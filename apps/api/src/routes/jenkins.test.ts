// The Jenkins page's API end to end: real LDAP (alice is DEVOPS, bob is not),
// real Postgres for the audit, and a fake Jenkins. Needs the containers.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { serve } from '@hono/node-server'
import { createFakeJenkins } from '../integrations/jenkins/fake-server.ts'

const fake = createFakeJenkins()
const server = serve({ fetch: fake.app.fetch, port: 0 })
await new Promise((resolve) => server.once('listening', resolve))
const port = (server.address() as AddressInfo).port

// Config is read on import, so point it at the fake before anything loads it.
process.env.JENKINS_URL = `http://localhost:${port}/jenkins`
process.env.JENKINS_USER = 'eidp'
process.env.JENKINS_TOKEN = 'fake'

const { createApp } = await import('../app.ts')
const { closeDb, ensureSchema, query } = await import('../lib/db.ts')
const app = createApp()
const tokens: Record<string, string> = {}
/** Audit rows before these tests; only rows after it are theirs to delete. */
let auditFloor = 0

before(async () => {
  await ensureSchema()
  auditFloor = Number((await query<{ max: string | null }>('select max(id) from jenkins_audit')).rows[0]?.max ?? 0)
  for (const who of ['alice', 'bob']) {
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: who, password: `${who}pw` }),
    })
    tokens[who] = ((await res.json()) as { token: string }).token
  }
})

after(async () => {
  await query('delete from jenkins_audit where id > $1', [auditFloor])
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
  return (await res.json()) as T
}

const fresh = async () => json(await call('alice', 'GET', '/jenkins?fresh=1'))

test('someone without the permission is refused, with the reason', async () => {
  const res = await call('bob', 'GET', '/jenkins')
  assert.equal(res.status, 403)
  assert.match((await json(res)).error.message, /see Jenkins jobs/)
})

test('the overview counts what needs attention', async () => {
  const overview = await fresh()
  // Folders and the multibranch project are walked; only the leaves count.
  assert.equal(overview.counts.jobs, 7)
  assert.equal(overview.counts.failing, 3)
  assert.equal(overview.counts.running, 1)
  assert.equal(overview.counts.queued, 1)
  assert.equal(overview.counts.agentsOffline, 1)
  assert.equal(overview.url, `http://localhost:${port}/jenkins`)
})

test('failures are the jobs whose latest finished build did not pass, with how long', async () => {
  const { failures } = await fresh()
  const byJob = Object.fromEntries(failures.map((f: any) => [f.job, f]))
  assert.deepEqual(Object.keys(byJob).sort(), ['agriland-api/main', 'payments/deploy-prod', 'payments/loan-scoring-api'])

  const loan = byJob['payments/loan-scoring-api']
  assert.equal(loan.streak, 3)
  assert.equal(loan.streakAtLeast, false)
  assert.equal(loan.last.number, 4)
  assert.equal(loan.last.result, 'failure')
  assert.ok(loan.lastSuccess)
  // Unstable counts as broken: the build ran, but tests failed.
  assert.equal(byJob['agriland-api/main'].last.result, 'unstable')
  // Newest failure first.
  assert.deepEqual(failures.map((f: any) => f.job)[0], 'payments/loan-scoring-api')
})

test('recent runs cover every job, newest first, and a running build says so', async () => {
  const { runs } = await fresh()
  assert.equal(runs[0].job, 'inventories-lint')
  assert.equal(runs[0].result, 'running')
  const times = runs.map((r: any) => r.startedAt)
  assert.deepEqual(times, [...times].sort().reverse())
})

test('a run shows its cause, its parameters with secrets hidden, and the end of its log', async () => {
  const run = await json(await call('alice', 'GET', `/jenkins/run?job=${encodeURIComponent('payments/deploy-prod')}&number=2`))
  assert.deepEqual(run.causes, ['Started by user alice'])
  assert.deepEqual(run.parameters, [
    { name: 'VERSION', value: '1.4.2', hidden: false },
    { name: 'API_TOKEN', value: '[hidden]', hidden: true },
    { name: 'DB_PASSWORD', value: '[hidden]', hidden: true },
  ])
  assert.match(run.notReplayable, /password parameter \(DB_PASSWORD\)/)
  assert.match(run.log, /Finished: FAILURE\n$/)
})

test('a multibranch branch with an encoded slash is found', async () => {
  const run = await json(await call('alice', 'GET', `/jenkins/run?job=${encodeURIComponent('agriland-api/feature%2Fscoring')}&number=1`))
  assert.equal(run.result, 'success')
})

test('a build that does not exist is a 404, not a 500', async () => {
  const res = await call('alice', 'GET', `/jenkins/run?job=nope&number=1`)
  assert.equal(res.status, 404)
})

test('re-running uses the parameters the build had, and is audited', async () => {
  const res = await call('alice', 'POST', '/jenkins/rebuild', { job: 'payments/loan-scoring-api', number: 4 })
  assert.equal(res.status, 202)
  assert.ok((await json(res)).queueId)
  assert.deepEqual(fake.triggered.at(-1), { job: 'payments/loan-scoring-api', parameters: { BRANCH: 'main' } })

  const [entry] = await json<any[]>(await call('alice', 'GET', '/jenkins/audit'))
  assert.equal(entry.action, 'rebuild')
  assert.equal(entry.actor, 'alice')
  assert.equal(entry.job, 'payments/loan-scoring-api')
  assert.equal(entry.build, 4)
  assert.equal(entry.ok, true)
  // Acting clears the cache, so the new queue item shows at once.
  assert.equal((await json(await call('alice', 'GET', '/jenkins'))).counts.queued, 2)
})

test('a build with a password parameter is not re-run blank, and the refusal is audited', async () => {
  const before = fake.triggered.length
  const res = await call('alice', 'POST', '/jenkins/rebuild', { job: 'payments/deploy-prod', number: 2 })
  assert.equal(res.status, 409)
  assert.match((await json(res)).error.message, /Run it in Jenkins/)
  assert.equal(fake.triggered.length, before)
  const [entry] = await json<any[]>(await call('alice', 'GET', '/jenkins/audit'))
  assert.equal(entry.ok, false)
  assert.match(entry.error, /password parameter/)
})

test('a running build can be stopped', async () => {
  const res = await call('alice', 'POST', '/jenkins/stop', { job: 'inventories-lint', number: 2 })
  assert.equal(res.status, 202)
  assert.deepEqual(fake.stopped, ['inventories-lint#2'])
  const { runs } = await json(await call('alice', 'GET', '/jenkins'))
  assert.equal(runs.find((r: any) => r.job === 'inventories-lint' && r.number === 2).result, 'aborted')
})

test('a queued build can be taken out of the queue, once', async () => {
  assert.equal((await call('alice', 'POST', '/jenkins/queue/499/cancel')).status, 200)
  assert.ok(!fake.queue.some((q) => q.id === 499))
  const again = await call('alice', 'POST', '/jenkins/queue/499/cancel')
  assert.equal(again.status, 404)
  assert.match((await json(again)).error.message, /no longer waiting/)
})

test('the actions are refused without the permission too', async () => {
  const res = await call('bob', 'POST', '/jenkins/rebuild', { job: 'payments/loan-scoring-api', number: 4 })
  assert.equal(res.status, 403)
})
