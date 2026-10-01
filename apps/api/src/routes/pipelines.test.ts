// My pipelines end to end: real LDAP (bob is in Payments, alice in DEVOPS,
// dave in nothing), real Postgres, a fake Jenkins with a week of builds, and a
// system of our own in the catalog that Payments owns — so which pipelines are
// bob's, and what he may do with them, come from the same places they do in use.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { serve } from '@hono/node-server'
import pg from 'pg'
import { createFakeJenkins } from '../integrations/jenkins/fake-server.ts'

const fake = createFakeJenkins()
const server = serve({ fetch: fake.app.fetch, port: 0 })
await new Promise((resolve) => server.once('listening', resolve))
const url = `http://localhost:${(server.address() as AddressInfo).port}/jenkins`

process.env.JENKINS_URL = url
process.env.JENKINS_USER = 'eidp'
process.env.JENKINS_TOKEN = 'fake'

const { createApp } = await import('../app.ts')
const { closeDb, ensureSchema, query } = await import('../lib/db.ts')
const { config } = await import('../lib/config.ts')
const app = createApp()
const tokens: Record<string, string> = {}

/** Ours alone: catalog tests replace the catalog wholesale, so the lock is held throughout. */
const SYSTEM = '__pipelines_test'
const catalogLock = new pg.Client({ connectionString: config.DATABASE_URL })
let auditFloor = 0
let binding: string | null = null

const forget = () =>
  Promise.all(['jenkins_builds', 'jenkins_jobs', 'jenkins_sync'].map((table) => query(`delete from ${table} where server = $1`, [url])))

before(async () => {
  await ensureSchema()
  await catalogLock.connect()
  await catalogLock.query('select pg_advisory_lock(4202)')
  await forget()
  await query('delete from catalog_systems where dir = $1', [SYSTEM])
  await query(`insert into catalog_systems (dir, project_name, teams) values ($1, 'PipeLab', '{"dev":"Payments","prd":"DEVOPS"}')`, [SYSTEM])
  for (const app of ['loan-scoring-api', 'payments-web']) {
    await query(
      `insert into catalog_applications (id, system_dir, group_name, name, environment, repository) values ($1, $2, $3, $3, null, $3)`,
      [`${SYSTEM}/${app}`, SYSTEM, app],
    )
  }
  auditFloor = Number((await query<{ max: string | null }>('select max(id) from jenkins_audit')).rows[0]?.max ?? 0)
  for (const who of ['alice', 'bob', 'dave']) {
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: who, password: `${who}pw` }),
    })
    tokens[who] = ((await res.json()) as { token: string }).token
  }
  const synced = await json(await call('alice', 'POST', '/jenkins/sync'))
  assert.equal(synced.ok, true, synced.error)
})

after(async () => {
  if (binding) await query('delete from rbac_bindings where id = $1', [binding])
  await query('delete from jenkins_audit where id > $1', [auditFloor])
  await query('delete from catalog_systems where dir = $1', [SYSTEM])
  await forget()
  await catalogLock.query('select pg_advisory_unlock(4202)')
  await catalogLock.end()
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

async function json<T = Record<string, any>>(res: Response): Promise<T> {
  assert.ok(res.ok, `${res.status}: ${await res.clone().text()}`)
  return (await res.json()) as T
}

const mine = async (who: string) => json<{ pipelines: any[]; queue: any[]; startedByYou: any[] }>(await call(who, 'GET', '/pipelines'))
const pipeline = (list: { pipelines: any[] }, job: string) => list.pipelines.find((p) => p.job === job)

/** The jobs `uid` started a build of, as history holds them. */
async function startedBy(uid: string): Promise<string[]> {
  const { rows } = await query<{ job: string }>(
    `select distinct job from jenkins_builds where server = $1 and $2 = any(causes) order by job`,
    [url, `Started by user ${uid}`],
  )
  return rows.map((row) => row.job)
}

test('a pipeline is yours when your team owns it or you started it, and says which', async () => {
  const list = await mine('bob')
  const expected = new Set(['payments/loan-scoring-api', 'payments/payments-web', ...(await startedBy('bob'))])
  assert.deepEqual(new Set(list.pipelines.map((p) => p.job)), expected)

  const owned = pipeline(list, 'payments/loan-scoring-api')
  assert.deepEqual(owned.reasons.find((r: any) => r.kind === 'team'), { kind: 'team', team: 'Payments', project: 'PipeLab' })
  assert.equal(owned.owners[0].project, 'PipeLab')
  assert.deepEqual(owned.owners[0].applications, ['loan-scoring-api'])
  assert.ok(owned.recent.length > 0 && owned.recent.length <= 10)
  assert.equal(owned.last.number, owned.recent[0].number)

  // Started, not owned: there because of the builds, and says so.
  const other = list.pipelines.find((p) => !p.reasons.some((r: any) => r.kind === 'team'))
  assert.ok(other, 'bob started builds of a pipeline Payments does not own')
  assert.deepEqual(other.reasons.map((r: any) => r.kind), ['started'])
  assert.ok(other.reasons[0].builds > 0)

  // The 7-day list holds only bob's own builds.
  assert.ok(list.startedByYou.length > 0)
  for (const run of list.startedByYou) assert.ok(run.causes.includes('Started by user bob'), run.causes.join())
})

test('being in the owning team shows a pipeline but does not let you act on it', async () => {
  const list = await mine('bob')
  assert.ok(list.pipelines.every((p) => p.canOperate === false))
  assert.ok(list.queue.some((q) => q.job === 'payments/payments-web' && q.canOperate === false))
  const res = await call('bob', 'POST', '/jenkins/rebuild', { job: 'payments/loan-scoring-api', number: 40 })
  assert.equal(res.status, 403)
  assert.equal(fake.triggered.length, 0)
})

test('someone with no team and no builds has no pipelines', async () => {
  const list = await mine('dave')
  assert.deepEqual(list.pipelines, [])
  assert.deepEqual(list.queue, [])
  assert.deepEqual(list.startedByYou, [])
})

test('a build of your pipeline opens for you; anyone else’s is not found', async () => {
  const number = pipeline(await mine('bob'), 'payments/loan-scoring-api').last.number
  const own = await json(await call('bob', 'GET', `/jenkins/run?job=payments/loan-scoring-api&number=${number}`))
  assert.equal(own.number, number)
  assert.equal(own.canOperate, false)

  // dave owns nothing and started nothing, so every build is someone else's.
  const stranger = `/jenkins/run?job=payments/loan-scoring-api&number=${number}`
  const res = await call('dave', 'GET', stranger)
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error.code, 'pipeline_not_found')

  // DevOps see every build, and may act on it.
  const any = await json(await call('alice', 'GET', stranger))
  assert.equal(any.canOperate, true)
})

test('a pipeline operator bound to the team may act on its pipelines, and only those', async () => {
  const { rows } = await query<{ id: string }>(
    `insert into rbac_bindings (subject_type, subject, role, scope_type, scope, reason, created_by)
     values ('user', 'bob', 'pipeline-operator', 'team', 'Payments', 'pipelines test', 'alice') returning id`,
  )
  binding = rows[0]!.id

  const list = await mine('bob')
  const owned = pipeline(list, 'payments/loan-scoring-api')
  assert.equal(owned.canOperate, true)
  assert.ok(owned.reasons.some((r: any) => r.kind === 'scope' && /Pipeline operator/.test(r.via)))
  const startedOnly = list.pipelines.find((p) => p.reasons.every((r: any) => r.kind === 'started'))
  assert.equal(startedOnly.canOperate, false)

  // Run again: queued in Jenkins, and the audit says bob asked.
  const queued = await call('bob', 'POST', '/jenkins/rebuild', { job: 'payments/loan-scoring-api', number: owned.last.number })
  assert.equal(queued.status, 202, await queued.clone().text())
  assert.equal(fake.triggered.at(-1)?.job, 'payments/loan-scoring-api')
  const audit = await query<{ actor: string; action: string; ok: boolean }>('select actor, action, ok from jenkins_audit where id > $1 order by id', [auditFloor])
  assert.deepEqual(audit.rows.at(-1), { actor: 'bob', action: 'rebuild', ok: true })

  // Not his team's: refused before Jenkins is asked, naming why.
  const before = fake.triggered.length
  const refused = await call('bob', 'POST', '/jenkins/rebuild', { job: startedOnly.job, number: startedOnly.last.number })
  assert.equal(refused.status, 403)
  assert.match((await refused.json()).error.message, /team or project that owns it/)
  assert.equal(fake.triggered.length, before)

  // The queue: his team's item can be taken out; a queue id alone opens nothing else.
  fake.queue.push({ id: 777, job: startedOnly.job, since: Date.now(), why: 'Waiting' })
  assert.equal((await call('bob', 'POST', '/jenkins/queue/777/cancel')).status, 403)
  assert.ok(fake.queue.some((q) => q.id === 777))
  assert.equal((await call('bob', 'POST', '/jenkins/queue/499/cancel')).status, 200)
  assert.ok(!fake.queue.some((q) => q.id === 499))

  // The Jenkins page itself stays DevOps': a scoped operator is not a viewer.
  assert.equal((await call('bob', 'GET', '/jenkins')).status, 403)
})
