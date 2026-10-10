// The request lifecycle end to end: real Postgres, real LDAP (alice and carol
// are DEVOPS, bob is not), and a fake Azure DevOps Server. Needs the containers.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { serve } from '@hono/node-server'
import { createFakeAdo } from '../integrations/ado/fake-server.ts'
import { createFakeJira } from '../integrations/jira/fake-server.ts'
import { createFakeOllama } from '../integrations/ollama/fake-server.ts'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const fake = createFakeAdo()
const server = serve({ fetch: fake.app.fetch, port: 0 })
await new Promise((resolve) => server.once('listening', resolve))
const port = (server.address() as AddressInfo).port

const fakeJira = createFakeJira()
const jiraServer = serve({ fetch: fakeJira.app.fetch, port: 0 })
await new Promise((resolve) => jiraServer.once('listening', resolve))
const jiraPort = (jiraServer.address() as AddressInfo).port

// Config is read on import, so point it at the fakes before anything loads it.
process.env.ADO_BASE_URL = `http://localhost:${port}/tfs/DefaultCollection`
process.env.ADO_PAT = 'fake'
process.env.JIRA_BASE_URL = `http://localhost:${jiraPort}/jira`
process.env.JIRA_TOKEN = 'fake'

const fakeOllama = createFakeOllama()
const ollamaServer = serve({ fetch: fakeOllama.app.fetch, port: 0 })
await new Promise((resolve) => ollamaServer.once('listening', resolve))
process.env.OLLAMA_URL = `http://localhost:${(ollamaServer.address() as AddressInfo).port}`
process.env.OLLAMA_MODEL = 'qwen2.5'

const { createApp } = await import('../app.ts')
const { closeDb, migrate, query } = await import('../lib/db.ts')
const app = createApp()

const tokens: Record<string, string> = {}

before(async () => {
  await migrate()
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
  jiraServer.close()
  ollamaServer.close()
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

test('DEVOPS can approve their own request, and it records who did', async () => {
  const own = await json<{ id: string }>(await call('alice', 'POST', '/requests', repoRequest('alice-tool')))
  const self = await call('alice', 'POST', `/requests/${own.id}/approve`, {})
  assert.equal(self.status, 200)
  const done = await settled(own.id)
  assert.equal(done.status, 'completed')
  assert.equal(done.decidedByName, 'Alice Example')
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

test('another process’s creation still beating is left alone; one gone quiet is failed', async () => {
  const { recoverInterrupted } = await import('../services/requests.ts')
  const live = await json<{ id: string }>(await call('bob', 'POST', '/requests', repoRequest('beating')))
  const quiet = await json<{ id: string }>(await call('bob', 'POST', '/requests', repoRequest('quiet')))
  await query(`update requests set status = 'approved', heartbeat_at = now() where id = $1`, [live.id])
  await query(`update requests set status = 'approved', heartbeat_at = now() - interval '5 minutes' where id = $1`, [quiet.id])
  assert.equal(await recoverInterrupted(), 1)
  assert.equal((await json(await call('bob', 'GET', `/requests/${live.id}`))).status, 'approved')
  assert.equal((await json(await call('bob', 'GET', `/requests/${quiet.id}`))).status, 'failed')
  // Leave nothing approved behind for the tests after this one.
  await query(`update requests set status = 'failed' where id = $1`, [live.id])
})

const grantRequest = (extra: Record<string, unknown> = {}) => ({
  kind: 'grant_access',
  collection: 'DefaultCollection',
  project: 'AgriLand',
  grantees: ['bob', 'carol'],
  justification: 'Joining the AgriLand work.',
  ...extra,
})

/** Account names in a project group, by the group's short name. */
function membersOf(project: string, group: string): string[] {
  const container = fake.identities.find((i) => i.providerDisplayName === `[${project}]\\${group}`)!
  return [...(fake.members.get(container.id) ?? [])].map(
    (id) => fake.identities.find((i) => i.id === id)!.properties.Account.$value,
  )
}

test('an access request is checked against what exists and who the directory knows', async () => {
  const check = async (body: unknown) => json(await call('bob', 'POST', '/requests/check', body))
  assert.deepEqual(await check(grantRequest()), { ok: true })
  assert.match(String((await check(grantRequest({ grantees: ['bob', 'nobody'] }))).reason), /no account called nobody/)
  assert.match(String((await check(grantRequest({ project: 'Nope' }))).reason), /There is no project Nope/)
  assert.match(String((await check(grantRequest({ grantees: [' '] }))).reason), /at least one person/)
})

test('an access request is Contribute on the whole project, whatever the body asks for', async () => {
  const created = await json<{ id: string; grantees: string[]; teamGroup: null; repository: null; accessLevel: string }>(
    await call(
      'bob',
      'POST',
      '/requests',
      // A repository and a lower level are not the requester's to choose.
      grantRequest({ grantees: ['bob', 'carol', 'BOB'], repository: 'agriland-api', accessLevel: 'read' }),
    ),
  )
  // Duplicates by case are folded; no team is involved in an access request.
  assert.deepEqual(created.grantees, ['bob', 'carol'])
  assert.equal(created.teamGroup, null)
  assert.equal(created.repository, null)
  assert.equal(created.accessLevel, 'contribute')

  // A second person asking for the same access at the same time is fine.
  assert.equal((await call('carol', 'POST', '/requests', grantRequest({ grantees: ['carol'] }))).status, 201)

  await call('alice', 'POST', `/requests/${created.id}/approve`, {})
  const done = await settled(created.id)
  assert.equal(done.status, 'completed')
  assert.match(done.resultUrl!, /\/DefaultCollection\/AgriLand$/)
  assert.deepEqual(membersOf('AgriLand', 'Contributors').sort(), ['bob', 'carol'])
  assert.deepEqual(membersOf('AgriLand', 'Readers'), [])
  assert.equal(accessOn('agriland-api', 'carol'), undefined)
})

// ---- Jira ----------------------------------------------------------------

const jiraRequest = (project: string, projectKey: string) => ({
  kind: 'create_jira_project',
  project,
  projectKey,
  description: 'Loan scoring backlog.',
  justification: 'The Payments team is starting the loan scoring work.',
  teamGroup: 'Payments',
})

/** Who is in a Jira project's role, as `user:name` / `group:name`. */
function jiraRole(key: string, role: keyof typeof fakeJira.roleIds): string[] {
  return (fakeJira.roles.get(key)?.get(fakeJira.roleIds[role]) ?? [])
    .map((a) => `${a.type === 'atlassian-user-role-actor' ? 'user' : 'group'}:${a.name}`)
    .sort()
}

test('the form is told which Jira it is asking', async () => {
  const body = await json(await call('bob', 'GET', '/jira'))
  assert.equal(body.baseUrl, `http://localhost:${jiraPort}/jira`)
  assert.equal(body.serverTitle, 'Jira (fake)')
})

test('the Jira check explains what is wrong before anything is filed', async () => {
  const check = async (name: string, key: string) =>
    json<{ ok: boolean; reason?: string }>(await call('bob', 'POST', '/requests/check', jiraRequest(name, key)))
  assert.deepEqual(await check('Loan Scoring', 'LOAN'), { ok: true })
  assert.match(String((await check('Loan Scoring', 'loan')).reason), /uppercase letter/)
  assert.match(String((await check('X', 'LOAN')).reason), /at least two characters/)
  assert.match(String((await check('agriland', 'LOAN')).reason), /already has a project called AgriLand \(AGRI\)/)
  assert.match(String((await check('Loan Scoring', 'AGRI')).reason), /Project 'AgriLand' uses this project key/)
  // Archived projects are not listed, but Jira still holds their keys.
  assert.match(String((await check('Loan Scoring', 'OLD')).reason), /uses this project key/)
  // The server's own pattern and length, which the portal does not assume.
  assert.match(String((await check('Loan Scoring', 'LOAN2')).reason), /uppercase alphanumeric/)
  assert.match(String((await check('Loan Scoring', 'LOANSCORINGX')).reason), /must not exceed 10/)
})

test('a Jira project request waits for DevOps, and cannot be filed twice by name or key', async () => {
  const res = await call('bob', 'POST', '/requests', jiraRequest('Loan Scoring', 'LOAN'))
  assert.equal(res.status, 201)
  const request = await json(res)
  assert.equal(request.kind, 'create_jira_project')
  assert.equal(request.collection, null)
  assert.equal(request.projectKey, 'LOAN')
  assert.equal(request.teamGroup, 'Payments')

  for (const [name, key] of [['Loan Scoring', 'LSC'], ['Scoring', 'LOAN']] as const) {
    const again = await call('carol', 'POST', '/requests', jiraRequest(name, key))
    assert.equal(again.status, 409)
    assert.match(String((await json<{ error: { message: string } }>(again)).error.message), /Bob Example has already asked/)
  }

  assert.equal((await call('bob', 'POST', `/requests/${request.id}/approve`, {})).status, 403)
})

test('DevOps approve, and the project is created in Jira with the requester and their team in it', async () => {
  const [pending] = (await json<{ id: string; kind: string }[]>(await call('bob', 'GET', '/requests/mine'))).filter(
    (r) => r.kind === 'create_jira_project',
  )
  await call('alice', 'POST', `/requests/${pending!.id}/approve`, {})
  const done = await settled(pending!.id)
  assert.equal(done.status, 'completed', done.error)
  assert.equal(done.resultUrl, `http://localhost:${jiraPort}/jira/browse/LOAN`)

  const project = fakeJira.projects.find((p) => p.key === 'LOAN')!
  assert.equal(project.name, 'Loan Scoring')
  assert.equal(project.lead, 'bob')
  assert.equal(project.description, 'Loan scoring backlog.')
  assert.deepEqual(jiraRole('LOAN', 'Developers'), ['group:Payments', 'user:bob'])
  assert.deepEqual(jiraRole('LOAN', 'Administrators'), [])
})

test('a team Jira cannot find fails the request before anything is created', async () => {
  fakeJira.groups.delete('Payments')
  try {
    const created = await json<{ id: string }>(await call('bob', 'POST', '/requests', jiraRequest('No Team', 'NOTEAM')))
    await call('alice', 'POST', `/requests/${created.id}/approve`, {})
    const failed = await settled(created.id)
    assert.equal(failed.status, 'failed')
    assert.match(failed.error!, /Jira does not know a group called Payments/)
    assert.ok(!fakeJira.projects.some((p) => p.key === 'NOTEAM'))
  } finally {
    fakeJira.groups.add('Payments')
  }
})

test('when Jira refuses the roles after creating, a retry only grants', async () => {
  fakeJira.setDenyRoles(true)
  const created = await json<{ id: string }>(await call('bob', 'POST', '/requests', jiraRequest('Grant Later', 'GRANT')))
  await call('alice', 'POST', `/requests/${created.id}/approve`, {})
  const failed = await settled(created.id)
  fakeJira.setDenyRoles(false)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error!, /Created GRANT, but could not grant access: You cannot edit the configuration/)
  assert.ok(failed.resultUrl)

  // Half granted by hand in the meantime: the retry adds only what is missing,
  // where adding bob again would make Jira refuse the whole call.
  fakeJira.roles.get('GRANT')!.get(fakeJira.roleIds.Developers)!.push({ name: 'bob', type: 'atlassian-user-role-actor' })
  await call('carol', 'POST', `/requests/${created.id}/retry`)
  const done = await settled(created.id)
  assert.equal(done.status, 'completed', done.error)
  assert.equal(fakeJira.projects.filter((p) => p.key === 'GRANT').length, 1)
  assert.deepEqual(jiraRole('GRANT', 'Developers'), ['group:Payments', 'user:bob'])
})

test('when Jira fails to create, the request says why and nothing is recorded as made', async () => {
  fakeJira.setFailCreate(true)
  const created = await json<{ id: string }>(await call('bob', 'POST', '/requests', jiraRequest('Broken', 'BROKEN')))
  await call('alice', 'POST', `/requests/${created.id}/approve`, {})
  const failed = await settled(created.id)
  fakeJira.setFailCreate(false)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error!, /Internal server error creating the project/)
  assert.equal(failed.resultUrl, null)

  await call('alice', 'POST', `/requests/${created.id}/retry`)
  assert.equal((await settled(created.id)).status, 'completed')
})

// ---- risk summaries --------------------------------------------------------
// The catalog is shared with catalog.test.ts, which replaces it wholesale:
// hold its lock while these tests' own system is in it.

const catalogLock = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://eidp:eidp@localhost:5432/eidp' })
const RISK_SYSTEM = 'ZZRisk'

async function assessed(id: string, who = 'alice') {
  for (let i = 0; i < 60; i++) {
    const request = await json<Record<string, any>>(await call(who, 'GET', `/requests/${id}`))
    if (request.assessment || who !== 'alice') return request
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('never assessed')
}

const texts = (a: any, level: string) => a.facts.filter((f: any) => f.level === level).map((f: any) => f.text)

test('risk: a project that reaches production, owned by one team, is set up to check against', async () => {
  await catalogLock.connect()
  await catalogLock.query('select pg_advisory_lock(4202)')
  await query('delete from catalog_systems where dir = $1', [RISK_SYSTEM])
  await query(`insert into catalog_systems (dir, project_name, teams) values ($1, 'RiskLab', '{"dev":"DEVOPS","prd":"DEVOPS"}')`, [RISK_SYSTEM])
  await query(
    `insert into catalog_applications (id, system_dir, group_name, name, environment) values ($1, $2, 'prd_risk-api', 'risk-api', 'prd')`,
    [`${RISK_SYSTEM}/prd_risk-api`, RISK_SYSTEM],
  )
  const coll = fake.collections.get('DefaultCollection')!
  const project = { id: randomUUID(), name: 'RiskLab', description: '', state: 'wellFormed' as const }
  coll.projects.push(project)
  coll.repos.push({ id: randomUUID(), name: 'loan-scoring', project: { id: project.id, name: 'RiskLab' } })
})

test('risk: access for people outside the owning team, to production, for a thin reason, is high — and says why', async () => {
  const filed = await json<{ id: string }>(
    await call('bob', 'POST', '/requests', { kind: 'grant_access', collection: 'DefaultCollection', project: 'RiskLab', grantees: ['alice', 'bob', 'dave'], justification: 'Need it' }),
  )
  const { assessment } = await assessed(filed.id)
  assert.equal(assessment.level, 'high')
  const cautions = texts(assessment, 'caution')
  assert.ok(cautions.some((t: string) => /Bob Example is not in a team that owns RiskLab \(DEVOPS\)/.test(t)), cautions.join(' | '))
  assert.ok(cautions.some((t: string) => /RiskLab deploys to production/.test(t)))
  assert.ok(cautions.some((t: string) => /2 of 3 are outside the teams that own RiskLab: bob, dave/.test(t)))
  assert.ok(cautions.some((t: string) => /The reason is 2 words long/.test(t)))
  // The model's words, over those facts — and its reading of the reason.
  assert.match(assessment.summary, /^Weigh this before approving:/)
  assert.deepEqual(assessment.reasonConcerns, ['The reason does not say who needs this or what for.'])
  assert.equal(assessment.model, 'qwen2.5')
})

test('risk: only someone who may decide a request sees its assessment', async () => {
  const [mine] = await json<{ id: string }[]>(await call('bob', 'GET', '/requests/mine'))
  const asRequester = await json<Record<string, unknown>>(await call('bob', 'GET', `/requests/${mine!.id}`))
  assert.equal(asRequester.canDecide, false)
  assert.ok(!('assessment' in asRequester))
  assert.equal((await call('bob', 'POST', `/requests/${mine!.id}/assess`)).status, 403)

  const pool = await json<{ open: Record<string, any>[] }>(await call('alice', 'GET', '/requests/pool'))
  assert.equal(pool.open.find((r) => r.id === mine!.id)?.assessment.level, 'high')
})

test('risk: a near-duplicate name is a caution, from someone in the owning team a medium', async () => {
  const filed = await json<{ id: string }>(
    await call('alice', 'POST', '/requests', {
      kind: 'create_repository', collection: 'DefaultCollection', project: 'RiskLab', repository: 'loan_scoring-v2',
      justification: 'Second version of the scoring service for the Payments team, replacing loan-scoring next quarter.', teamGroup: 'DEVOPS',
    }),
  )
  const { assessment } = await assessed(filed.id)
  assert.deepEqual(texts(assessment, 'caution'), ['Similar names already exist: loan-scoring. It may already be there under another name.'])
  assert.equal(assessment.level, 'medium')
  assert.ok(texts(assessment, 'info').some((t: string) => /RiskLab deploys to production/.test(t)))
})

test('risk: without the model, the facts and the level still stand, and it says why there are no words', async () => {
  const [mine] = await json<{ id: string }[]>(await call('bob', 'GET', '/requests/mine'))
  fakeOllama.setMode('no-model')
  try {
    const again = await json<Record<string, any>>(await call('alice', 'POST', `/requests/${mine!.id}/assess`))
    assert.equal(again.level, 'high')
    assert.equal(again.summary, null)
    assert.match(again.error, /ollama pull qwen2\.5/)
  } finally {
    fakeOllama.setMode('ok')
  }
  await query('delete from catalog_systems where dir = $1', [RISK_SYSTEM])
  await catalogLock.query('select pg_advisory_unlock(4202)')
  await catalogLock.end()
})
