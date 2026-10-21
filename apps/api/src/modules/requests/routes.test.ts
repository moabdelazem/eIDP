// The request lifecycle end to end: real Postgres, real LDAP (alice and carol
// are DEVOPS, bob is not), and a fake Azure DevOps Server. Needs the containers.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { serve } from '@hono/node-server'
import { createFakeAdo } from '../../integrations/ado/fake-server.ts'
import { createFakeJenkins } from '../../integrations/jenkins/fake-server.ts'
import { createFakeJira } from '../../integrations/jira/fake-server.ts'
import { createFakeOllama } from '../../integrations/ollama/fake-server.ts'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

// Jenkins, for what runs after a pipeline is pushed: provisioning, then a first
// test build. Its builds start and finish only when a test says so.
const fakeJenkins = createFakeJenkins({ provisioning: true })
const jenkinsServer = serve({ fetch: fakeJenkins.app.fetch, port: 0 })
await new Promise((resolve) => jenkinsServer.once('listening', resolve))
process.env.JENKINS_URL = `http://localhost:${(jenkinsServer.address() as AddressInfo).port}/jenkins`
process.env.JENKINS_USER = 'eidp'
process.env.JENKINS_TOKEN = 'fake'
process.env.PIPELINE_PROVISION_JOB = 'devops/provisioning'
process.env.PIPELINE_TEST_JOB = '{project}/{application}/develop'

const fakeOllama = createFakeOllama()
const ollamaServer = serve({ fetch: fakeOllama.app.fetch, port: 0 })
await new Promise((resolve) => ollamaServer.once('listening', resolve))
process.env.OLLAMA_URL = `http://localhost:${(ollamaServer.address() as AddressInfo).port}`
process.env.OLLAMA_MODEL = 'qwen2.5'

// Inventories, for pipeline requests: a local repository seeded with the
// parser's fixtures plus a project of the tests' own, pushed to over file://.
const inventoriesRemote = mkdtempSync(join(tmpdir(), 'eidp-inventories-'))
{
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  git(inventoriesRemote, 'init', '-q', '--bare', '-b', 'main')
  const seed = mkdtempSync(join(tmpdir(), 'eidp-seed-'))
  cpSync(fileURLToPath(new URL('../../integrations/inventories/__fixtures__/repo', import.meta.url)), seed, { recursive: true })
  mkdirSync(join(seed, 'PipeHome/group_vars/all'), { recursive: true })
  writeFileSync(join(seed, 'PipeHome/group_vars/all/project.yml'), 'project_name: PipeHome\n')
  mkdirSync(join(seed, 'Reference/group_vars/ref-app'), { recursive: true })
  writeFileSync(join(seed, 'Reference/group_vars/ref-app/resources.yml'), 'name: ref-app\nreplicas: 1\n')
  // The references the .NET and project templates are imported from, as definitions.ts names them.
  const reference = join(seed, 'LPGMS_Penalty/group_vars/LPGMS.PWebApi')
  mkdirSync(reference, { recursive: true })
  writeFileSync(
    join(reference, 'cicd.yml'),
    [
      'repository_name: LPGMS.PWebApi',
      'build_technology: DotNetCore',
      'dockerfile_name: Dockerfile-User-global',
      'packages: tz-global',
      'nuget_name: Reference.Package',
      'db_password: hunter2',
      'build_image:',
      '  name: sdk',
      '  tag: "6.0"',
      'deploy_image:',
      '  tag: 6.0',
      '',
    ].join('\n'),
  )
  writeFileSync(join(reference, 'LPGMS.PWebApi.env.yml'), 'service: LPGMS.PWebApi\n')
  mkdirSync(join(seed, 'GAFI_Digital_Network/group_vars/all'), { recursive: true })
  writeFileSync(join(seed, 'GAFI_Digital_Network/group_vars/all/project.yml'), 'project_name: GAFI_Digital_Network\nmail_subject: GAFI_Digital_Network builds\n')
  writeFileSync(join(seed, 'GAFI_Digital_Network/group_vars/all/team.yml'), 'company: someone-else\n')
  git(seed, 'init', '-q', '-b', 'main')
  git(seed, 'add', '.')
  git(seed, '-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'seed')
  git(seed, 'push', '-q', inventoriesRemote, 'main')
  rmSync(seed, { recursive: true, force: true })
}
process.env.INVENTORIES_GIT_URL = `file://${inventoriesRemote}`
process.env.INVENTORIES_WRITE_CHECKOUT = mkdtempSync(join(tmpdir(), 'eidp-write-'))


// ocp-templates, which approved pipelines write their manifests to.
const ocpTemplatesRemote = mkdtempSync(join(tmpdir(), 'eidp-ocp-templates-'))
{
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  git(ocpTemplatesRemote, 'init', '-q', '--bare', '-b', 'main')
  const seed = mkdtempSync(join(tmpdir(), 'eidp-ocp-seed-'))
  mkdirSync(join(seed, 'PipeHome'), { recursive: true })
  writeFileSync(join(seed, 'PipeHome/README'), 'manifests\n')
  mkdirSync(join(seed, 'LPGMS_Penalty/LPGMS.PWebApi'), { recursive: true })
  writeFileSync(join(seed, 'LPGMS_Penalty/LPGMS.PWebApi/deployment-LPGMS.PWebApi.yml'), 'kind: Deployment\nname: "{{ app_name }}"\n')
  git(seed, 'init', '-q', '-b', 'main')
  git(seed, 'add', '.')
  git(seed, '-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'seed')
  git(seed, 'push', '-q', ocpTemplatesRemote, 'main')
  rmSync(seed, { recursive: true, force: true })
}
process.env.OCP_TEMPLATES_GIT_URL = `file://${ocpTemplatesRemote}`
process.env.OCP_TEMPLATES_WRITE_CHECKOUT = mkdtempSync(join(tmpdir(), 'eidp-ocp-write-'))

const { createApp } = await import('../../app.ts')
const { registerTechnology } = await import('./pipeline/technologies.ts')
const { writePipeline } = await import('./pipeline/write.ts')
const { advanceSteps } = await import('./pipeline/follow-up.ts')
const { closeDb, migrate, query } = await import('../../lib/db.ts')
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
  await restoreTemplates()
  await query('delete from requests')
  await closeDb()
  server.close()
  jiraServer.close()
  jenkinsServer.close()
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
  const { CONTRIBUTOR } = await import('../../integrations/ado/index.ts')
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
  const { recoverInterrupted } = await import('./service.ts')
  const created = await json<{ id: string }>(await call('bob', 'POST', '/requests', repoRequest('interrupted')))
  // Simulate a crash between approval and completion.
  await query(`update requests set status = 'approved' where id = $1`, [created.id])
  assert.equal(await recoverInterrupted(), 1)
  const seen = await json(await call('bob', 'GET', `/requests/${created.id}`))
  assert.equal(seen.status, 'failed')
  assert.match(String(seen.error), /restarted/)
})

test('another process’s creation still beating is left alone; one gone quiet is failed', async () => {
  const { recoverInterrupted } = await import('./service.ts')
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

// ---- pipelines ------------------------------------------------------------------


// A technology of the tests' own: what the ported templates will do, in miniature.
registerTechnology({
  key: 'TestTech',
  label: 'Test Tech',
  versions: ['1', '2'],
  fields: [{ name: 'artifact_id', label: 'Artifact ID', options: null, default: '{application}', help: 'Letters and digits.', pattern: '^[a-z0-9-]+$' }],
  targets: ['OCP'],
  noNamespaces: false,
  files: async (ctx, inventories) => [
    // Copied from a reference application and patched, as the ported templates do.
    { path: `${ctx.system}/group_vars/${ctx.spec.application}/resources.yml`, content: (await inventories.read('Reference/group_vars/ref-app/resources.yml'))!.replace('ref-app', ctx.spec.application) },
    { path: `${ctx.system}/group_vars/${ctx.spec.application}/cicd.yml`, content: `repository_name: ${ctx.repository}\nbuild_technology: TestTech\n` },
    { path: `${ctx.system}/group_vars/${ctx.spec.application}/TestTech.yml`, content: `artifact_id: ${ctx.spec.fields.artifact_id}\nversion: "${ctx.spec.version}"\n` },
  ],
})

const adoProject = (name: string, repos: string[]) => {
  const coll = fake.collections.get('DefaultCollection')!
  const project = { id: randomUUID(), name, description: '', state: 'wellFormed' as const }
  coll.projects.push(project)
  for (const repo of repos) coll.repos.push({ id: randomUUID(), name: repo, project: { id: project.id, name } })
}
adoProject('PipeHome', ['pipe-api', 'pipe-web', 'pipe-late', 'pipe-steps', 'pipe-fail', 'pipe-edit'])
adoProject('PipeLab', ['lab-api'])

const teams = {
  company: 'eFinance', devTeam: 'Payments', qcTeam: 'QC', uatTeam: 'DEVOPS', prdTeam: 'DEVOPS', automaticDeployToQc: false,
  devTeamList: [], opsTeamList: ['DEVOPS'], prdOnly: [], prdApprovers: ['DEVOPS'], projectManagers: [],
}

const pipelineRequest = (project: string, repository: string, pipeline: Record<string, unknown> = {}) => ({
  kind: 'create_pipeline',
  collection: 'DefaultCollection',
  project,
  repository,
  justification: 'The new scoring service needs its pipeline.',
  teamGroup: 'Payments',
  pipeline: { application: repository, deployTarget: 'OCP', technology: 'TestTech', version: '2', library: false, fields: { artifact_id: repository }, newProject: null, ...pipeline },
})

/** What the inventories repository holds now, at `path`, or null. */
function inventoriesFile(path: string): string | null {
  try {
    return execFileSync('git', ['--git-dir', inventoriesRemote, 'show', `main:${path}`], { stdio: 'pipe' }).toString()
  } catch {
    return null
  }
}
const inventoriesLog = () => execFileSync('git', ['--git-dir', inventoriesRemote, 'log', '--format=%s%n%b', 'main']).toString()

const pipelineLock = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://eidp:eidp@localhost:5432/eidp' })

// The templates are global rows in the shared database: the ones these tests
// write are put back as they were, history included, whatever happens.
const TEMPLATE_DIRS = ['DotNetCore/OCP', 'manifests/DotNetCore/OCP', 'project']
let templatesBefore: { dir: string; files: unknown; updated_by: string; updated_by_name: string; updated_at: Date }[] = []
let historyFloor = 0
let templatesTaken = false
/** Called by the file's `after`, before the pool closes. */
async function restoreTemplates() {
  if (!templatesTaken) return
  await query('delete from pipeline_templates where dir = any($1)', [TEMPLATE_DIRS])
  for (const row of templatesBefore) {
    await query('insert into pipeline_templates (dir, files, updated_by, updated_by_name, updated_at) values ($1, $2, $3, $4, $5)', [row.dir, JSON.stringify(row.files), row.updated_by, row.updated_by_name, row.updated_at])
  }
  await query('delete from pipeline_template_history where id > $1 and dir = any($2)', [historyFloor, TEMPLATE_DIRS])
}

test('pipelines: DevOps imports a template from its reference, checks it, and saves it', async () => {
  templatesBefore = (await query('select * from pipeline_templates where dir = any($1)', [TEMPLATE_DIRS])).rows as typeof templatesBefore
  historyFloor = Number((await query('select coalesce(max(id), 0) as id from pipeline_template_history')).rows[0].id)
  templatesTaken = true
  await query('delete from pipeline_templates where dir = any($1)', [TEMPLATE_DIRS])
  const at = (dir: string) => `/requests/pipeline/template?dir=${encodeURIComponent(dir)}`

  const slots = await json<{ dir: string; repository: string; reference: string; saved: unknown }[]>(await call('alice', 'GET', '/requests/pipeline/templates'))
  assert.deepEqual(slots.find((s) => s.dir === 'DotNetCore/OCP'), {
    ...slots.find((s) => s.dir === 'DotNetCore/OCP'),
    repository: 'inventories',
    reference: 'LPGMS_Penalty/group_vars/LPGMS.PWebApi',
    saved: null,
  })

  // Imported from the reference: the name a placeholder, the password not carried.
  const imported = await json<{ files: { path: string; content: string }[]; notes: string[] }>(await call('alice', 'POST', `${at('DotNetCore/OCP')}`.replace('template?', 'template/import?')))
  assert.deepEqual(imported.files.map((f) => f.path), ['__APPLICATION__.env.yml', 'cicd.yml'])
  const cicd = imported.files.find((f) => f.path === 'cicd.yml')!.content
  assert.match(cicd, /^repository_name: __APPLICATION__$/m)
  assert.match(cicd, /^db_password: changeme$/m)
  assert.match(imported.notes.join(' '), /db_password had a value in the reference/)

  // Saving checks what it is given.
  const refused = await call('alice', 'PUT', at('DotNetCore/OCP'), { files: [{ path: 'cicd.yml', content: 'db_password: hunter2\n' }] })
  assert.equal(refused.status, 422)
  assert.equal((await call('alice', 'PUT', at('DotNetCore/OCP'), { files: [{ path: '../escape.yml', content: 'a: 1\n' }] })).status, 400)
  assert.equal((await call('alice', 'PUT', at('nowhere'), { files: [{ path: 'a.yml', content: 'a: 1\n' }] })).status, 404)

  const saved = await json<{ files: unknown[]; history: { changedBy: string; files: number }[] }>(await call('alice', 'PUT', at('DotNetCore/OCP'), { files: imported.files }))
  assert.equal(saved.files.length, 2)
  assert.deepEqual(saved.history.slice(0, 1).map((h) => [h.changedBy, h.files]), [['alice', 2]], 'newest first')

  // The manifests, from ocp-templates: the name replaced in paths only.
  const manifests = await json<{ files: { path: string; content: string }[]; notes: string[] }>(await call('alice', 'POST', at('manifests/DotNetCore/OCP').replace('template?', 'template/import?')))
  assert.deepEqual(manifests.files, [{ path: 'deployment-__APPLICATION__.yml', content: 'kind: Deployment\nname: "{{ app_name }}"\n' }])
  assert.equal((await call('alice', 'PUT', at('manifests/DotNetCore/OCP'), { files: manifests.files })).status, 200)

  // The project's own files, never its team.yml.
  const project = await json<{ files: { path: string; content: string }[] }>(await call('alice', 'POST', at('project').replace('template?', 'template/import?')))
  assert.deepEqual(project.files, [{ path: 'project.yml', content: 'project_name: __PROJECT__\nmail_subject: __PROJECT__ builds\n' }])
  assert.equal((await call('alice', 'PUT', at('project'), { files: [...project.files, { path: 'team.yml', content: 'company: x\n' }] })).status, 400)
  assert.equal((await call('alice', 'PUT', at('project'), { files: project.files })).status, 200)

  // Removing one stops the technology being offered, and is kept in the history.
  const technologies = async () => (await json<{ key: string }[]>(await call('bob', 'GET', '/requests/pipeline/technologies'))).map((t) => t.key)
  assert.ok((await technologies()).includes('DotNetCore'))
  assert.equal((await call('alice', 'DELETE', at('manifests/DotNetCore/OCP'))).status, 204)
  assert.ok(!(await technologies()).includes('DotNetCore'), 'every template a target needs, or it is not offered')
  const history = await json<{ history: { files: number | null }[] }>(await call('alice', 'GET', at('manifests/DotNetCore/OCP')))
  assert.deepEqual(history.history.slice(0, 2).map((h) => h.files), [null, 1])
  assert.equal((await call('alice', 'PUT', at('manifests/DotNetCore/OCP'), { files: manifests.files })).status, 200)
})

test('pipelines: the form learns the technologies and whether the project is in inventories yet', async () => {
  await pipelineLock.connect()
  await pipelineLock.query('select pg_advisory_lock(4202)')
  await query("delete from catalog_systems where dir in ('PipeHome', 'PipeLab')")
  await query("insert into catalog_systems (dir, project_name) values ('PipeHome', 'PipeHome')")
  await query("insert into catalog_applications (id, system_dir, group_name, name) values ('PipeHome/taken-api', 'PipeHome', 'taken-api', 'taken-api')")

  const technologies = await json<{ key: string; files?: unknown }[]>(await call('bob', 'GET', '/requests/pipeline/technologies'))
  const tech = technologies.find((t) => t.key === 'TestTech')!
  assert.deepEqual(
    technologies.filter((t) => t.key === 'DotNetCore').map((t) => (t as unknown as { targets: string[] }).targets),
    [['OCP']],
    'a technology is offered once its templates are saved, for the targets they cover',
  )
  assert.ok(tech && !('files' in tech), 'what to ask, never the templates')
  const home = await json<{ exists: boolean; system: string }>(await call('bob', 'GET', '/requests/pipeline/project?project=pipehome'))
  assert.deepEqual([home.exists, home.system], [true, 'PipeHome'])
  const lab = await json<{ exists: boolean; environments: Record<string, { key: string }[]> }>(await call('bob', 'GET', '/requests/pipeline/project?project=PipeLab'))
  assert.equal(lab.exists, false)
  assert.deepEqual(lab.environments.OCP!.map((e) => e.key), ['dev', 'qc', 'uat', 'prd', 'prd_dr'])
  assert.deepEqual(lab.environments.K8s!.map((e) => e.key), ['dev', 'qc', 'uat', 'preprod', 'prd', 'prd_dr'])
})

test('pipelines: the check refuses what inventories or the registry could not take', async () => {
  const reason = async (body: Record<string, unknown>) => (await json<{ ok: boolean; reason?: string }>(await call('bob', 'POST', '/requests/check', body))).reason ?? 'ok'
  assert.match(await reason(pipelineRequest('PipeHome', 'pipe-api', { application: 'prd_pipe' })), /“prd_” is reserved/)
  assert.match(await reason(pipelineRequest('PipeHome', 'pipe-api', { technology: 'Cobol' })), /not set up/)
  assert.match(await reason(pipelineRequest('PipeHome', 'pipe-api', { fields: {} })), /Artifact ID/)
  assert.match(await reason(pipelineRequest('PipeHome', 'pipe-api', { version: null })), /version/)
  assert.match(await reason(pipelineRequest('PipeHome', 'pipe-api', { version: '9' })), /version the platform builds: 1, 2/, 'only listed versions')
  assert.match(await reason(pipelineRequest('PipeHome', 'pipe-api', { fields: { artifact_id: 'Not Valid' } })), /Artifact ID does not look right. Letters and digits./)
  assert.match(await reason(pipelineRequest('PipeHome', 'no-such-repo')), /no repository called no-such-repo/)
  assert.match(await reason(pipelineRequest('PipeHome', 'pipe-api', { application: 'Taken-API' })), /already has an application called taken-api/)
  assert.match(await reason(pipelineRequest('PipeHome', 'pipe-api', { newProject: { teams, namespaces: {} } })), /already set up for pipelines/)
  assert.match(await reason(pipelineRequest('PipeLab', 'lab-api')), /has no pipelines yet/)
  assert.match(await reason(pipelineRequest('PipeLab', 'lab-api', { newProject: { teams, namespaces: { dev: { name: 'lab-dev', user: null } } } })), /Name the QC namespace/)
  assert.match(await reason(pipelineRequest('PipeLab', 'lab-api', { newProject: { teams: { ...teams, automaticDeployToQc: null }, namespaces: {} } })), /deploy to QC automatically/)
  assert.match(await reason(pipelineRequest('PipeHome', 'pipe-api', { application: 'pipe api' })), /no spaces/)
  assert.match(await reason(pipelineRequest('PipeHome', 'pipe-api', { application: 'a'.repeat(51) })), /at most 50/)
  assert.equal(await reason(pipelineRequest('PipeHome', 'pipe-api')), 'ok')
})

test('pipelines: approved, its files are pushed to inventories in one commit that says who and why', async () => {
  const filed = await json<{ id: string; pipeline: { application: string } }>(await call('bob', 'POST', '/requests', pipelineRequest('PipeHome', 'pipe-api')))
  assert.equal(filed.pipeline.application, 'pipe-api')
  assert.equal((await call('bob', 'GET', `/requests/${filed.id}/pipeline`)).status, 403, 'the files are the approver’s to read')
  // A second ask for the same pipeline waits on the first.
  assert.equal((await call('carol', 'POST', '/requests', pipelineRequest('PipeHome', 'pipe-api'))).status, 409)

  const preview = await json<{ files: { path: string }[]; errors: string[]; commit: string | null }>(await call('alice', 'GET', `/requests/${filed.id}/pipeline`))
  assert.deepEqual(preview.errors, [])
  assert.deepEqual(preview.files.map((f) => f.path).sort(), ['PipeHome/group_vars/pipe-api/TestTech.yml', 'PipeHome/group_vars/pipe-api/cicd.yml', 'PipeHome/group_vars/pipe-api/resources.yml', 'PipeHome/pipe-api.yml'])
  assert.equal(inventoriesFile('PipeHome/group_vars/pipe-api/cicd.yml'), null, 'a preview writes nothing')

  await call('alice', 'POST', `/requests/${filed.id}/approve`, {})
  const done = await settled(filed.id)
  assert.equal(done.status, 'completed', done.error)
  assert.match(done.resultUrl!, /#[0-9a-f]{40}$/)
  assert.equal(inventoriesFile('PipeHome/group_vars/pipe-api/TestTech.yml'), 'artifact_id: pipe-api\nversion: "2"\n')
  assert.equal(inventoriesFile('PipeHome/group_vars/pipe-api/resources.yml'), 'name: pipe-api\nreplicas: 1\n', 'copied from the reference and patched')
  const log = inventoriesLog()
  assert.match(log, /Add the pipe-api pipeline \(Test Tech on OCP\)/)
  assert.match(log, /Requested by .+ \(bob\); approved by .+ \(alice\)/)
  assert.ok(log.includes(`e-IDP-Request: ${filed.id}`))

  // Writing it again finds the commit rather than pushing a second one.
  const before = inventoriesLog().split('e-IDP-Request').length
  const again = await writePipeline((await json(await call('alice', 'GET', `/requests/${filed.id}`))) as never)
  assert.equal(again.files.length, 0)
  assert.equal(inventoriesLog().split('e-IDP-Request').length, before)
})

test('pipelines: a new project also gets its team.yml and namespaces', async () => {
  const body = pipelineRequest('PipeLab', 'lab-api', {
    newProject: {
      teams,
      namespaces: {
        dev: { name: 'lab-dev', user: null },
        qc: { name: 'lab-qc', user: null },
        uat: { name: 'lab-uat', user: null },
        prd: { name: 'lab-prd', user: 'svc-lab' },
        prd_dr: { name: 'lab-prd', user: 'svc-lab' },
      },
    },
  })
  const filed = await json<{ id: string }>(await call('bob', 'POST', '/requests', body))
  await call('alice', 'POST', `/requests/${filed.id}/approve`, {})
  assert.equal((await settled(filed.id)).status, 'completed')
  const team = inventoriesFile('PipeLab/group_vars/all/team.yml')!
  assert.match(team, /^company: eFinance$/m)
  assert.match(team, /^automatic_deploy_to_qc: "false"$/m)
  assert.match(team, /^dev_team_list:\n  -$/m, 'an empty list is one empty item, as the repository spells it')
  assert.match(team, /^ops_team_list:\n  - DEVOPS$/m)
  assert.match(team, /^prd_approvers:\n  - DEVOPS\nprd_only:\n  - DEVOPS$/m, 'empty approver lists fall back to DEVOPS, in the old order')
  assert.equal(inventoriesFile('PipeLab/host_vars/prd_ocp/vars.yml'), 'cluster_type: HQ\n\nocp_namespace:\n  name: lab-prd\n  user: svc-lab\n  token: changeme\n')
  assert.match(inventoriesFile('PipeLab/host_vars/prd_dr_ocp/vars.yml')!, /^cluster_type: DR$/m)
  assert.match(inventoriesFile('PipeLab/host_vars/dev_ocp/vars.yml')!, /^  user: changeme$/m, 'no user: the placeholder, listed as a follow-up')
  assert.equal(inventoriesFile('PipeLab/group_vars/all/project.yml'), 'project_name: PipeLab\nmail_subject: PipeLab builds\n')
  assert.match(inventoriesFile('PipeLab/lab-api.yml')!, /prd_lab-api:\n          hosts:\n            prd_ocp:\n            prd_dr_ocp:/)
  assert.ok(inventoriesFile('PipeLab/group_vars/lab-api/cicd.yml'))
})

test('pipelines: a technology from its template — the reference copied with the name, version and fields set', async () => {
  const body = pipelineRequest('PipeHome', 'pipe-web', { technology: 'DotNetCore', version: '8.0', fields: { nuget_name: 'Pipe.Web' } })
  const filed = await json<{ id: string }>(await call('bob', 'POST', '/requests', body))
  await call('alice', 'POST', `/requests/${filed.id}/approve`, {})
  assert.equal((await settled(filed.id)).status, 'completed')
  assert.equal(
    inventoriesFile('PipeHome/group_vars/pipe-web/cicd.yml'),
    [
      'repository_name: pipe-web',
      'build_technology: DotNetCore',
      'dockerfile_name: Dockerfile-User',
      'packages: tz',
      'nuget_name: Pipe.Web',
      'db_password: changeme',
      'build_image:',
      '  name: sdk',
      '  tag: "8.0"',
      'deploy_image:',
      '  tag: 8.0',
      'app_path: "pipe-web"',
      '',
    ].join('\n'),
  )
  assert.equal(inventoriesFile('PipeHome/group_vars/pipe-web/pipe-web.env.yml'), 'service: pipe-web\n', 'the name in paths too')
  const manifest = execFileSync('git', ['--git-dir', ocpTemplatesRemote, 'show', 'main:PipeHome/pipe-web/deployment-pipe-web.yml']).toString()
  assert.equal(manifest, 'kind: Deployment\nname: "{{ app_name }}"\n', 'the manifests to ocp-templates: the name in paths, the contents as they are')
  assert.match(execFileSync('git', ['--git-dir', ocpTemplatesRemote, 'log', '-1', '--format=%B', 'main']).toString(), /Add the pipe-web manifests[\s\S]*e-IDP-Request: /)
})

test('pipelines: a library gets no manifests, and a test technology without them never touches ocp-templates', async () => {
  const before = execFileSync('git', ['--git-dir', ocpTemplatesRemote, 'rev-parse', 'main']).toString()
  const body = pipelineRequest('PipeHome', 'pipe-api', { application: 'pipe-lib', technology: 'DotNetCore', version: '6.0', library: true, fields: { nuget_name: 'Pipe.Lib' } })
  const filed = await json<{ id: string }>(await call('bob', 'POST', '/requests', body))
  const preview = await json<{ manifests: unknown[] }>(await call('alice', 'GET', `/requests/${filed.id}/pipeline`))
  assert.deepEqual(preview.manifests, [])
  await call('alice', 'POST', `/requests/${filed.id}/approve`, {})
  assert.equal((await settled(filed.id)).status, 'completed')
  assert.ok(inventoriesFile('PipeHome/group_vars/pipe-lib/cicd.yml'), 'inventories written')
  assert.equal(execFileSync('git', ['--git-dir', ocpTemplatesRemote, 'rev-parse', 'main']).toString(), before)
})

// ---- after the push: provisioning and a first test build -----------------------

type Step = { step: string; status: string; job: string | null; number: number | null; url: string | null; note: string | null; attempts: number }
const stepsOf = async (id: string, who = 'alice') => (await json<{ steps: Step[] }>(await call(who, 'GET', `/requests/${id}`))).steps
const statuses = async (id: string) => Object.fromEntries((await stepsOf(id)).map((s) => [s.step, s.status]))

test('pipelines: once pushed, provisioning runs in Jenkins, then a first test build', async () => {
  const filed = await json<{ id: string }>(await call('bob', 'POST', '/requests', pipelineRequest('PipeHome', 'pipe-steps')))
  await call('alice', 'POST', `/requests/${filed.id}/approve`, {})
  assert.equal((await settled(filed.id)).status, 'completed')
  assert.deepEqual(await statuses(filed.id), { provision: 'pending', test: 'waiting' }, 'the test build waits on provisioning')

  // Every open step moves along — earlier tests' pipelines too — so look for this one's.
  await advanceSteps()
  const provisioning = fakeJenkins.triggered.find((t) => t.parameters.APP_NAME === 'pipe-steps')!
  assert.equal(provisioning.job, 'devops/provisioning')
  assert.deepEqual(provisioning.parameters, { COLLECTION: 'DefaultCollection', PROJECT: 'PipeHome', APP_NAME: 'pipe-steps', NEW_PROJECT: 'false' })
  assert.equal((await statuses(filed.id)).provision, 'queued')

  fakeJenkins.startQueued()
  await advanceSteps()
  const running = (await stepsOf(filed.id))[0]!
  assert.equal(running.status, 'running')
  assert.match(running.url!, /job\/devops\/job\/provisioning\/\d+\/$/)

  fakeJenkins.finishRunning()
  await advanceSteps()
  assert.deepEqual(await statuses(filed.id), { provision: 'succeeded', test: 'pending' })

  // The test build, in the job provisioning made.
  await advanceSteps()
  assert.ok(fakeJenkins.triggered.some((t) => t.job === 'PipeHome/pipe-steps/develop'))
  fakeJenkins.startQueued()
  await advanceSteps()
  fakeJenkins.finishRunning()
  await advanceSteps()
  assert.deepEqual(await statuses(filed.id), { provision: 'succeeded', test: 'succeeded' })
  assert.equal((await json<{ status: string }>(await call('bob', 'GET', `/requests/${filed.id}`))).status, 'completed')
  assert.equal((await stepsOf(filed.id, 'bob')).length, 2, 'the requester follows the steps too')
})

test('pipelines: provisioning failing leaves the request complete; DevOps run it again, the requester cannot', async () => {
  const filed = await json<{ id: string }>(await call('bob', 'POST', '/requests', pipelineRequest('PipeHome', 'pipe-fail')))
  await call('alice', 'POST', `/requests/${filed.id}/approve`, {})
  assert.equal((await settled(filed.id)).status, 'completed')
  await advanceSteps()
  fakeJenkins.startQueued()
  await advanceSteps()
  fakeJenkins.finishRunning()
  await advanceSteps()
  const [provision, testBuild] = await stepsOf(filed.id)
  assert.equal(provision!.status, 'failed')
  assert.equal(provision!.note, 'The build failed.')
  assert.equal(testBuild!.status, 'waiting', 'no test build without provisioning')
  assert.equal((await json<{ status: string }>(await call('alice', 'GET', `/requests/${filed.id}`))).status, 'completed', 'the files are in inventories either way')

  assert.equal((await call('bob', 'POST', `/requests/${filed.id}/steps/provision/retry`)).status, 403)
  assert.equal((await call('alice', 'POST', `/requests/${filed.id}/steps/test/retry`)).status, 200, 'the test build can be started by hand while it waits')
  assert.equal((await statuses(filed.id)).test, 'pending')
  const again = await json<Step[]>(await call('alice', 'POST', `/requests/${filed.id}/steps/provision/retry`))
  assert.deepEqual(Object.fromEntries(again.map((s) => [s.step, s.status])), { provision: 'pending', test: 'waiting' }, 'provisioning again puts the test build back behind it')
  assert.equal((await call('alice', 'POST', `/requests/${filed.id}/steps/provision/retry`)).status, 409, 'only a failed or skipped one runs again')
  await advanceSteps()
  assert.equal((await stepsOf(filed.id))[0]!.attempts, 2)
})

// ---- deciders adjusting a waiting request -----------------------------------------

type Adjusted = { id: string; repository: string | null; adjustments: { field: string; from: string | null; to: string | null; byName: string }[]; editedFiles: string[]; pipeline: { application: string; version: string } | null }

test('adjust: DevOps rename a repository before approving; each change is checked, kept, and shown to the requester', async () => {
  const filed = await json<{ id: string }>(await call('bob', 'POST', '/requests', repoRequest('adj-repo')))
  assert.equal((await call('bob', 'PATCH', `/requests/${filed.id}`, { repository: 'adj-repo-2' })).status, 403, 'the requester does not adjust their own')

  const taken = await call('alice', 'PATCH', `/requests/${filed.id}`, { repository: 'agriland-api' })
  assert.equal(taken.status, 409)
  assert.match((await json<{ error: { message: string } }>(taken)).error.message, /already has a repository called agriland-api/)
  assert.equal((await call('alice', 'PATCH', `/requests/${filed.id}`, { application: 'x' })).status, 400, 'a field this kind does not have')

  const adjusted = await json<Adjusted>(await call('alice', 'PATCH', `/requests/${filed.id}`, { repository: 'adj-repo-2' }))
  assert.equal(adjusted.repository, 'adj-repo-2')
  assert.deepEqual(
    adjusted.adjustments.map(({ field, from, to }) => ({ field, from, to })),
    [{ field: 'repository', from: 'adj-repo', to: 'adj-repo-2' }],
  )
  const seen = await json<Adjusted>(await call('bob', 'GET', `/requests/${filed.id}`))
  assert.equal(seen.adjustments[0]!.byName.length > 0, true, 'the requester sees who changed it')
  // The same value again changes nothing and records nothing.
  assert.equal((await json<Adjusted>(await call('alice', 'PATCH', `/requests/${filed.id}`, { repository: 'adj-repo-2' }))).adjustments.length, 1)

  await call('alice', 'POST', `/requests/${filed.id}/approve`, {})
  assert.equal((await settled(filed.id)).status, 'completed')
  const repos = fake.collections.get('DefaultCollection')!.repos.map((r) => r.name)
  assert.ok(repos.includes('adj-repo-2') && !repos.includes('adj-repo'), 'created under the adjusted name')
  assert.equal((await call('alice', 'PATCH', `/requests/${filed.id}`, { repository: 'later' })).status, 409, 'only while it waits')
})

test('adjust: an access request changes nothing — who gets access is the requester’s to ask', async () => {
  const filed = await json<{ id: string }>(
    await call('bob', 'POST', '/requests', { kind: 'grant_access', collection: 'DefaultCollection', project: 'AgriLand', grantees: ['bob'], justification: 'I join the AgriLand team this week.', teamGroup: 'Payments' }),
  )
  const res = await call('alice', 'PATCH', `/requests/${filed.id}`, { project: 'NBFS_LoanManagementSystem' })
  assert.equal(res.status, 400)
  assert.match((await json<{ error: { message: string } }>(res)).error.message, /Reject it with a note/)
})

test('adjust: a pipeline’s files edited before approving are what is pushed, and only deciders read them', async () => {
  const filed = await json<{ id: string }>(await call('bob', 'POST', '/requests', pipelineRequest('PipeHome', 'pipe-edit')))
  const preview = await json<{ files: { path: string; content: string }[] }>(await call('alice', 'GET', `/requests/${filed.id}/pipeline`))
  const path = 'PipeHome/group_vars/pipe-edit/TestTech.yml'
  const original = preview.files.find((f) => f.path === path)!.content
  const edited = `${original}replicas: 2\n`

  assert.equal((await call('alice', 'PATCH', `/requests/${filed.id}`, { files: [{ path: 'PipeHome/elsewhere.yml', content: 'x: 1\n' }] })).status, 400, 'only files approving writes')
  const leak = await call('alice', 'PATCH', `/requests/${filed.id}`, { files: [{ path, content: `${original}db_password: hunter2\n` }] })
  assert.equal(leak.status, 400)
  assert.match((await json<{ error: { message: string } }>(leak)).error.message, /db_password/)

  const adjusted = await json<Adjusted>(
    await call('alice', 'PATCH', `/requests/${filed.id}`, {
      files: [
        { path, content: edited },
        // Unchanged files are not kept as edits.
        { path: 'PipeHome/pipe-edit.yml', content: preview.files.find((f) => f.path === 'PipeHome/pipe-edit.yml')!.content },
      ],
    }),
  )
  assert.deepEqual(adjusted.editedFiles, [path])
  const bob = await json<Adjusted & { content?: unknown }>(await call('bob', 'GET', `/requests/${filed.id}`))
  assert.deepEqual(bob.editedFiles, [path], 'the requester sees which files were edited')
  assert.ok(!JSON.stringify(bob).includes('replicas: 2'), 'but not what they say')
  const after = await json<{ files: { path: string; content: string }[]; edited: string[] }>(await call('alice', 'GET', `/requests/${filed.id}/pipeline`))
  assert.deepEqual(after.edited, [path])
  assert.equal(after.files.find((f) => f.path === path)!.content, edited)

  await call('alice', 'POST', `/requests/${filed.id}/approve`, {})
  assert.equal((await settled(filed.id)).status, 'completed')
  assert.equal(inventoriesFile(path), edited)
})

test('adjust: renaming a pipeline’s application drops edits to files it no longer writes, and says so', async () => {
  const filed = await json<{ id: string }>(await call('bob', 'POST', '/requests', pipelineRequest('PipeHome', 'pipe-api', { application: 'pipe-renamed' })))
  const path = 'PipeHome/group_vars/pipe-renamed/TestTech.yml'
  const preview = await json<{ files: { path: string; content: string }[] }>(await call('alice', 'GET', `/requests/${filed.id}/pipeline`))
  await call('alice', 'PATCH', `/requests/${filed.id}`, { files: [{ path, content: `${preview.files.find((f) => f.path === path)!.content}# edited\n` }] })
  assert.equal((await call('alice', 'PATCH', `/requests/${filed.id}`, { application: 'pipe-two', files: [] })).status, 400, 'one at a time')
  const renamed = await json<Adjusted>(await call('alice', 'PATCH', `/requests/${filed.id}`, { application: 'pipe-two', version: '1' }))
  assert.equal(renamed.pipeline!.application, 'pipe-two')
  assert.equal(renamed.pipeline!.version, '1')
  assert.deepEqual(renamed.editedFiles, [])
  assert.deepEqual(renamed.adjustments.map((a) => a.field), ['files', 'application', 'version', 'files'])
  assert.equal((await call('alice', 'PATCH', `/requests/${filed.id}`, { version: '7' })).status, 409, 'a version the technology does not build')
  await call('alice', 'POST', `/requests/${filed.id}/reject`, { note: 'test done' })
})

test('pipelines: what appeared in inventories while it waited is a conflict at approval, and nothing is pushed', async () => {
  const filed = await json<{ id: string }>(await call('bob', 'POST', '/requests', pipelineRequest('PipeHome', 'pipe-late')))
  // Someone adds the application by hand after the request was filed.
  const hand = mkdtempSync(join(tmpdir(), 'eidp-hand-'))
  execFileSync('git', ['clone', '-q', inventoriesRemote, hand])
  mkdirSync(join(hand, 'PipeHome/group_vars/pipe-late'), { recursive: true })
  writeFileSync(join(hand, 'PipeHome/group_vars/pipe-late/cicd.yml'), 'by: hand\n')
  execFileSync('git', ['-C', hand, 'add', '.'])
  execFileSync('git', ['-C', hand, '-c', 'user.name=h', '-c', 'user.email=h@x', 'commit', '-q', '-m', 'by hand'])
  execFileSync('git', ['-C', hand, 'push', '-q', 'origin', 'main'])
  rmSync(hand, { recursive: true, force: true })

  const preview = await json<{ errors: string[] }>(await call('alice', 'GET', `/requests/${filed.id}/pipeline`))
  assert.match(preview.errors.join(' '), /pipe-late already has files in inventories/)
  await call('alice', 'POST', `/requests/${filed.id}/approve`, {})
  const failed = await settled(filed.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error!, /already has files/)
  assert.equal(inventoriesFile('PipeHome/group_vars/pipe-late/cicd.yml'), 'by: hand\n', 'nothing overwritten')

  await query("delete from catalog_applications where system_dir in ('PipeHome', 'PipeLab')")
  await query("delete from catalog_systems where dir in ('PipeHome', 'PipeLab')")
  await pipelineLock.query('select pg_advisory_unlock(4202)')
  await pipelineLock.end()
})

