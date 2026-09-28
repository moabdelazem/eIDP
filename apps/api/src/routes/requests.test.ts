// The request lifecycle end to end: real Postgres, real LDAP (alice and carol
// are DEVOPS, bob is not), and a fake Azure DevOps Server. Needs the containers.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { serve } from '@hono/node-server'
import { createFakeAdo } from '../integrations/ado/fake-server.ts'

const fake = createFakeAdo()
const server = serve({ fetch: fake.app.fetch, port: 0 })
await new Promise((resolve) => server.once('listening', resolve))
const port = (server.address() as AddressInfo).port

// Config is read on import, so point it at the fake before anything loads it.
process.env.ADO_BASE_URL = `http://localhost:${port}/tfs/DefaultCollection`
process.env.ADO_PAT = 'fake'

const { createApp } = await import('../app.ts')
const { closeDb, ensureSchema, query } = await import('../lib/db.ts')
const app = createApp()

const tokens: Record<string, string> = {}

before(async () => {
  await ensureSchema()
  await query('delete from requests')
  for (const who of ['alice', 'bob', 'carol']) {
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: who, password: `${who}pw` }),
    })
    tokens[who] = ((await res.json()) as { token: string }).token
  }
})

after(async () => {
  await query('delete from requests')
  await closeDb()
  server.close()
})

function call(who: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

/** Creation runs in the background after approval; wait for it to settle. */
async function settled(id: string, who = 'alice') {
  for (let i = 0; i < 60; i++) {
    const request = await json<{ status: string }>(await call(who, 'GET', `/requests/${id}`))
    if (request.status !== 'approved') return request as Record<string, string>
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('request never settled')
}

const repoRequest = (repository: string) => ({
  kind: 'create_repository',
  collection: 'DefaultCollection',
  project: 'AgriLand',
  repository,
  justification: 'New service for the loan scoring work.',
  teamGroup: 'Payments',
})

/** Allow bits an identity holds on a repository, by account name. */
function accessOn(repository: string, account: string): number | undefined {
  const repo = fake.collections.get('DefaultCollection')!.repos.find((r) => r.name === repository)!
  const identity = fake.identities.find((i) => i.properties.Account.$value === account)!
  return fake.acl.get(`repoV2/${repo.project.id}/${repo.id}`)?.get(identity.descriptor)
}

test('the collections on the server are discovered, with the default marked', async () => {
  const body = await json(await call('bob', 'GET', '/ado/collections'))
  assert.deepEqual(body.collections, ['DefaultCollection', 'Legacy'])
  assert.equal(body.defaultCollection, 'DefaultCollection')
  assert.equal(body.serverUrl, `http://localhost:${port}/tfs`)
})

test('a PAT refused at the server root still gets the configured collection', async () => {
  fake.setDenyServerScope(true)
  try {
    const body = await json(await call('bob', 'GET', '/ado/collections'))
    assert.deepEqual(body.collections, ['DefaultCollection'])
  } finally {
    fake.setDenyServerScope(false)
  }
})

test('projects are listed per collection', async () => {
  const names = (await json<{ name: string }[]>(await call('bob', 'GET', '/ado/collections/Legacy/projects'))).map((p) => p.name)
  assert.deepEqual(names, ['OldPortal'])
})

test('the live check explains what is wrong before anything is filed', async () => {
  const check = async (body: unknown) => json(await call('bob', 'POST', '/requests/check', body))
  assert.deepEqual(await check({ ...repoRequest('ok-name') }), { ok: true })
  assert.match(String((await check(repoRequest('bad/name'))).reason), /cannot contain “\/”/)
  assert.match(String((await check(repoRequest('_hidden'))).reason), /underscore/)
  assert.match(String((await check(repoRequest('agriland-api'))).reason), /already has a repository/)
  assert.match(
    String((await check({ ...repoRequest('x'), project: 'Nope' })).reason),
    /There is no project Nope/,
  )
})

test('a request needs a reason', async () => {
  const res = await call('bob', 'POST', '/requests', { ...repoRequest('no-reason'), justification: '  ' })
  assert.equal(res.status, 400)
})

test('the team has to be one of the requester’s own groups', async () => {
  const notTheirs = await call('bob', 'POST', '/requests', { ...repoRequest('not-my-team'), teamGroup: 'DEVOPS' })
  assert.equal(notTheirs.status, 400)
  assert.match(String((await json<{ error: { message: string } }>(notTheirs)).error.message), /not a member of DEVOPS/)
  const { teamGroup: _, ...noTeam } = repoRequest('no-team')
  assert.equal((await call('bob', 'POST', '/requests', noTeam)).status, 400)
})

test('a developer files a request and it waits for DEVOPS', async () => {
  const res = await call('bob', 'POST', '/requests', repoRequest('loan-scoring'))
  assert.equal(res.status, 201)
  const request = await json(res)
  assert.equal(request.status, 'pending')
  assert.equal(request.requestedByName, 'Bob Example')
  assert.equal(request.teamGroup, 'Payments')
})

test('the same request cannot be filed twice while it is open', async () => {
  const res = await call('carol', 'POST', '/requests', repoRequest('loan-scoring'))
  assert.equal(res.status, 409)
  assert.match(String((await json<{ error: { message: string } }>(res)).error.message), /Bob Example has already asked/)
})

test('someone outside DEVOPS cannot see the pool or decide', async () => {
  assert.equal((await call('bob', 'GET', '/requests/pool')).status, 403)
  const [mine] = await json<{ id: string }[]>(await call('bob', 'GET', '/requests/mine'))
  assert.equal((await call('bob', 'POST', `/requests/${mine!.id}/approve`, {})).status, 403)
})

test('DEVOPS approves, and the repository is created in Azure DevOps', async () => {
  const pool = await json<{ open: { id: string; repository: string }[] }>(await call('alice', 'GET', '/requests/pool'))
  const target = pool.open.find((r) => r.repository === 'loan-scoring')!
  assert.ok(target)

  const approved = await json(await call('alice', 'POST', `/requests/${target.id}/approve`, {}))
  assert.equal(approved.status, 'approved')
  assert.equal(approved.decidedByName, 'Alice Example')

  const done = await settled(target.id)
  assert.equal(done.status, 'completed')
  assert.match(done.resultUrl!, /\/DefaultCollection\/AgriLand\/_git\/loan-scoring$/)
  const repos = fake.collections.get('DefaultCollection')!.repos.map((r) => r.name)
  assert.ok(repos.includes('loan-scoring'))
})

test('approval grants the requester and their team Contributor on the new repository', async () => {
  const { CONTRIBUTOR } = await import('../integrations/ado/index.ts')
  assert.equal(accessOn('loan-scoring', 'bob'), CONTRIBUTOR)
  assert.equal(accessOn('loan-scoring', 'Payments'), CONTRIBUTOR)
  // The approver gets nothing from deciding.
  assert.equal(accessOn('loan-scoring', 'alice'), undefined)
})

test('a team Azure DevOps cannot find fails the request before anything is created', async () => {
  const payments = fake.identities.findIndex((i) => i.properties.Account.$value === 'Payments')
  const [removed] = fake.identities.splice(payments, 1)
  const created = await json<{ id: string }>(await call('bob', 'POST', '/requests', repoRequest('unknown-team')))
  await call('alice', 'POST', `/requests/${created.id}/approve`, {})
  const failed = await settled(created.id)
  fake.identities.splice(payments, 0, removed!)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error!, /does not know an account or group called Payments/)
  assert.ok(!fake.collections.get('DefaultCollection')!.repos.some((r) => r.name === 'unknown-team'))
})

test('when granting fails after creating, a retry only grants', async () => {
  fake.setDenyGrants(true)
  const created = await json<{ id: string }>(await call('bob', 'POST', '/requests', repoRequest('grant-later')))
  await call('alice', 'POST', `/requests/${created.id}/approve`, {})
  const failed = await settled(created.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error!, /Created grant-later, but could not grant access/)

  fake.setDenyGrants(false)
  await call('carol', 'POST', `/requests/${created.id}/retry`)
  const done = await settled(created.id)
  assert.equal(done.status, 'completed')
  // Not created twice — the retry would have hit "already exists" otherwise.
  assert.equal(fake.collections.get('DefaultCollection')!.repos.filter((r) => r.name === 'grant-later').length, 1)
  assert.ok(accessOn('grant-later', 'bob'))
})

test('a decided request cannot be approved again', async () => {
  const [done] = await json<{ id: string }[]>(await call('bob', 'GET', '/requests/mine'))
  const res = await call('carol', 'POST', `/requests/${done!.id}/approve`, {})
  assert.equal(res.status, 409)
})

test('two approvers clicking at once create it exactly once', async () => {
  const created = await json<{ id: string }>(await call('bob', 'POST', '/requests', repoRequest('race-me')))
  const results = await Promise.all([
    call('alice', 'POST', `/requests/${created.id}/approve`, {}),
    call('carol', 'POST', `/requests/${created.id}/approve`, {}),
  ])
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
  await settled(created.id)
  const copies = fake.collections.get('DefaultCollection')!.repos.filter((r) => r.name === 'race-me')
  assert.equal(copies.length, 1)
})

test('DEVOPS cannot approve their own request; a colleague can', async () => {
  const own = await json<{ id: string }>(await call('alice', 'POST', '/requests', repoRequest('alice-tool')))
  const self = await call('alice', 'POST', `/requests/${own.id}/approve`, {})
  assert.equal(self.status, 403)
  assert.equal((await json<{ error: { code: string } }>(self)).error.code, 'own_request')

  assert.equal((await call('carol', 'POST', `/requests/${own.id}/approve`, {})).status, 200)
  assert.equal((await settled(own.id, 'carol')).status, 'completed')
})

test('a rejection needs a reason, and the requester sees it', async () => {
  const created = await json<{ id: string }>(await call('bob', 'POST', '/requests', repoRequest('dup-of-existing')))
  assert.equal((await call('carol', 'POST', `/requests/${created.id}/reject`, {})).status, 400)
  const rejected = await json(
    await call('carol', 'POST', `/requests/${created.id}/reject`, { note: 'Use agriland-api instead.' }),
  )
  assert.equal(rejected.status, 'rejected')
  const seen = await json(await call('bob', 'GET', `/requests/${created.id}`))
  assert.equal(seen.decisionNote, 'Use agriland-api instead.')
})

test('a requester can withdraw their own waiting request, and nobody else can', async () => {
  const created = await json<{ id: string }>(await call('bob', 'POST', '/requests', repoRequest('changed-my-mind')))
  assert.equal((await call('carol', 'POST', `/requests/${created.id}/cancel`)).status, 409)
  assert.equal((await json(await call('bob', 'POST', `/requests/${created.id}/cancel`))).status, 'cancelled')
})

test('a developer cannot read someone else’s request', async () => {
  const theirs = await json<{ id: string }>(await call('carol', 'POST', '/requests', repoRequest('carol-thing')))
  assert.equal((await call('bob', 'GET', `/requests/${theirs.id}`)).status, 404)
})

test('a new project waits for Azure DevOps to finish creating it', async () => {
  const created = await json<{ id: string }>(
    await call('bob', 'POST', '/requests', {
      kind: 'create_project',
      collection: 'Legacy',
      project: 'NewPlatform',
      description: 'Platform rewrite',
      justification: 'Kick-off approved in Q3 planning.',
      teamGroup: 'Payments',
    }),
  )
  await call('alice', 'POST', `/requests/${created.id}/approve`, {})
  const done = await settled(created.id)
  assert.equal(done.status, 'completed')
  assert.match(done.resultUrl!, /\/Legacy\/NewPlatform$/)
  assert.ok(fake.collections.get('Legacy')!.projects.some((p) => p.name === 'NewPlatform'))

  // The requester and their team join the new project's Contributors group.
  const contributors = fake.identities.find((i) => i.providerDisplayName === '[NewPlatform]\\Contributors')!
  const joined = [...(fake.members.get(contributors.id) ?? [])].map(
    (id) => fake.identities.find((i) => i.id === id)!.properties.Account.$value,
  )
  assert.deepEqual(joined.sort(), ['Payments', 'bob'])
})

test('a malformed id is simply not found', async () => {
  assert.equal((await call('bob', 'GET', '/requests/not-a-uuid')).status, 404)
})

test('when Azure DevOps fails, the request says why and DEVOPS can retry it', async () => {
  fake.setFailProjects(true)
  const created = await json<{ id: string }>(
    await call('bob', 'POST', '/requests', {
      kind: 'create_project',
      collection: 'Legacy',
      project: 'Flaky',
      justification: 'Testing failure handling.',
      teamGroup: 'Payments',
    }),
  )
  await call('alice', 'POST', `/requests/${created.id}/approve`, {})
  const failed = await settled(created.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error!, /TF30177/)

  // Only DEVOPS may retry, and the original approval stands.
  assert.equal((await call('bob', 'POST', `/requests/${created.id}/retry`)).status, 403)
  fake.setFailProjects(false)
  await call('carol', 'POST', `/requests/${created.id}/retry`)
  const done = await settled(created.id)
  assert.equal(done.status, 'completed')
  assert.equal(done.decidedByName, 'Alice Example')
})

test('work interrupted by a restart is surfaced as failed, not left hanging', async () => {
  const { recoverInterrupted } = await import('../services/requests.ts')
  const created = await json<{ id: string }>(await call('bob', 'POST', '/requests', repoRequest('interrupted')))
  // Simulate a crash between approval and completion.
  await query(`update requests set status = 'approved' where id = $1`, [created.id])
  assert.equal(await recoverInterrupted(), 1)
  const seen = await json(await call('bob', 'GET', `/requests/${created.id}`))
  assert.equal(seen.status, 'failed')
  assert.match(String(seen.error), /restarted/)
})
