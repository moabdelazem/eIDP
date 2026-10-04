// The Jenkins page's API end to end: real LDAP (alice is DEVOPS, bob is not),
// real Postgres for history and the audit, and a fake Jenkins with a week of
// builds. Needs the containers.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { serve } from '@hono/node-server'
import { createFakeJenkins, type FakeBuild } from '../integrations/jenkins/fake-server.ts'

const fake = createFakeJenkins()
const server = serve({ fetch: fake.app.fetch, port: 0 })
await new Promise((resolve) => server.once('listening', resolve))
const port = (server.address() as AddressInfo).port
const url = `http://localhost:${port}/jenkins`

// Config is read on import, so point it at the fake before anything loads it.
process.env.JENKINS_URL = url
process.env.JENKINS_USER = 'eidp'
process.env.JENKINS_TOKEN = 'fake'

const { createApp } = await import('../app.ts')
const { closeDb, ensureSchema, query } = await import('../lib/db.ts')
const app = createApp()
const tokens: Record<string, string> = {}
/** Audit rows before these tests; only rows after it are theirs to delete. */
let auditFloor = 0

// History is keyed by server, and this fake's URL carries a fresh port, so
// these rows are only ever the tests' own.
const forget = () =>
  Promise.all(['jenkins_builds', 'jenkins_jobs', 'jenkins_sync', 'jenkins_ignored'].map((table) => query(`delete from ${table} where server = $1`, [url])))

before(async () => {
  await ensureSchema()
  await forget()
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
  await forget()
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
  assert.ok(res.ok, `${res.status}: ${await res.clone().text()}`)
  return (await res.json()) as T
}

const sync = async () => json(await call('alice', 'POST', '/jenkins/sync'))
const search = async (q: string, extra = '') =>
  json<{ total: number; runs: any[] }>(await call('alice', 'GET', `/jenkins/runs?window=7d&limit=100&q=${encodeURIComponent(q)}${extra}`))

/** Every finished build in the fake between two instants, by job. */
function finishedBetween(from: string, to: string): { job: string; build: FakeBuild }[] {
  const [a, b] = [Date.parse(from), Date.parse(to)]
  return fake
    .jobs()
    .flatMap(({ fullName, job }) => job.builds.map((build) => ({ job: fullName, build })))
    .filter(({ build }) => !build.building && build.timestamp >= a && build.timestamp < b)
}

test('someone without the permission is refused, with the reason', async () => {
  const res = await call('bob', 'GET', '/jenkins')
  assert.equal(res.status, 403)
  assert.match((await res.json()).error.message, /see Jenkins jobs/)
  assert.equal((await call('bob', 'POST', '/jenkins/sync')).status, 403)
})

test('the first sync reads every job that has built, and keeps only what is inside retention', async () => {
  const state = await sync()
  assert.equal(state.ok, true, state.error)
  // Nine jobs have builds; never-built has nothing to read.
  assert.equal(state.jobsRead, 9)
  const expected = fake.jobs().flatMap(({ job }) => job.builds).filter((b) => b.timestamp > Date.now() - 30 * 86_400_000).length
  assert.equal(state.builds, expected)
  const { rows } = await query<{ n: string }>(`select count(*) as n from jenkins_builds where server = $1 and job = 'legacy-batch'`, [url])
  assert.equal(Number(rows[0]!.n), 0)
})

test('later syncs read only jobs that built since, or had a build still running', async () => {
  fake.reads.length = 0
  await sync()
  // inventories-lint has a running build; legacy-batch's old builds are not
  // stored, but its high-water mark keeps it from being backfilled again.
  assert.deepEqual(fake.reads, ['inventories-lint'])

  fake.reads.length = 0
  fake.addBuild('payments/payments-web', { result: 'FAILURE', parameters: [{ _class: 'hudson.model.StringParameterValue', name: 'TICKET', value: 'PAY-4242' }] })
  await sync()
  assert.deepEqual(fake.reads.sort(), ['inventories-lint', 'payments/payments-web'])
  assert.equal((await search('TICKET=PAY-4242')).total, 1)
})

test('a Pipeline run says which agent it ran on, though Jenkins does not report builtOn for one', async () => {
  // Every stored build has its agent, found from its stages (Stage View) by the sync.
  const { rows } = await query<{ job: string; number: number; built_on: string | null }>('select job, number, built_on from jenkins_builds where server = $1', [url])
  const agentOf = new Map(fake.jobs().flatMap(({ fullName, job }) => job.builds.map((b) => [`${fullName}#${b.number}`, b.builtOn])))
  assert.ok(rows.length > 0)
  for (const row of rows) assert.equal(row.built_on, agentOf.get(`${row.job}#${row.number}`), `${row.job} #${row.number}`)
  assert.ok((await search('linux-03')).runs.some((r) => r.builtOn === 'linux-03'))

  // The build page says so too.
  const run = await json(await call('alice', 'GET', '/jenkins/run?job=payments/loan-scoring-api&number=40'))
  assert.equal(run.builtOn, agentOf.get('payments/loan-scoring-api#40'))
  assert.ok(run.stages.every((s: any) => s.agent === null || s.agent === run.builtOn))
})

test('the overview says what is broken now, and for how long', async () => {
  const overview = await json(await call('alice', 'GET', '/jenkins'))
  assert.equal(overview.sync.ok, true)
  assert.equal(overview.counts.jobs, 10)
  assert.equal(overview.counts.running, 1)
  assert.equal(overview.counts.agentsOffline, 1)

  const byJob = Object.fromEntries(overview.failures.map((f: any) => [f.job, f]))
  assert.deepEqual(Object.keys(byJob).sort(), ['agriland-api/main', 'payments/deploy-prod', 'payments/loan-scoring-api', 'payments/payments-web'])
  const loan = byJob['payments/loan-scoring-api']
  assert.equal(loan.streak, 3)
  assert.equal(loan.streakAtLeast, false)
  assert.equal(loan.last.number, 40)
  assert.deepEqual(loan.last.parameters[0], { name: 'BRANCH', value: 'release/2.3', hidden: false })
  // Unstable is broken too: it ran, and tests failed.
  assert.equal(byJob['agriland-api/main'].last.result, 'unstable')
})

for (const [window, buckets] of [['24h', 24], ['7d', 28]] as const) {
  test(`the ${window} numbers match the builds in that window`, async () => {
    const stats = await json(await call('alice', 'GET', `/jenkins/stats?window=${window}`))
    const inWindow = finishedBetween(stats.from, stats.to)
    const count = (result: string) => inWindow.filter(({ build }) => build.result === result).length

    assert.equal(stats.current.builds, inWindow.length)
    assert.equal(stats.current.success, count('SUCCESS'))
    assert.equal(stats.current.failure, count('FAILURE'))
    assert.equal(stats.current.unstable, count('UNSTABLE'))
    assert.equal(stats.current.aborted, count('ABORTED'))
    const decided = count('SUCCESS') + count('FAILURE') + count('UNSTABLE')
    assert.equal(stats.current.successRate, count('SUCCESS') / decided)
    assert.equal(stats.running, 1)

    assert.equal(stats.timeline.length, buckets)
    const plotted = stats.timeline.reduce((n: number, b: any) => n + b.success + b.failure + b.unstable + b.aborted, 0)
    assert.equal(plotted, inWindow.length)
    assert.equal(stats.topFailing[0].job, 'payments/loan-scoring-api')
    assert.ok(stats.slowest.length > 0)
  })
}

test('the week before is its own window, for the deltas', async () => {
  const stats = await json(await call('alice', 'GET', '/jenkins/stats?window=7d'))
  const before = new Date(Date.parse(stats.from) - 7 * 86_400_000).toISOString()
  assert.equal(stats.previous.builds, finishedBetween(before, stats.from).length)
})

test('the dashboard says where builds ran, what started them, and how long fixing took', async () => {
  const stats = await json(await call('alice', 'GET', '/jenkins/stats?window=7d'))
  const from = Date.parse(stats.from)
  const to = Date.parse(stats.to)
  const all = fake.jobs().flatMap(({ fullName, job }) => job.builds.map((build) => ({ job: fullName, build })))
  const inWindow = all.filter(({ build }) => build.timestamp >= from && build.timestamp < to)

  // Agents: every build in the window ran on one, and the counts add up.
  const byAgent = new Map<string, number>()
  for (const { build } of inWindow) byAgent.set(build.builtOn, (byAgent.get(build.builtOn) ?? 0) + 1)
  assert.deepEqual(Object.fromEntries(stats.agents.map((a: any) => [a.agent, a.builds])), Object.fromEntries(byAgent))

  // Triggers: maika's pushes are named, as are the people and SCM changes.
  const triggers = Object.fromEntries(stats.triggers.map((t: any) => [t.trigger, t.builds]))
  assert.equal(triggers.maika, inWindow.filter(({ build }) => build.cause === 'Started by user maika').length)
  assert.equal(triggers['SCM change'], inWindow.filter(({ build }) => /SCM change/.test(build.cause)).length)
  assert.equal(stats.triggers.reduce((n: number, t: any) => n + t.builds, 0), inWindow.length)

  // Time to fix, worked out here from the fake's own history.
  const took: number[] = []
  for (const { job } of fake.jobs()) {
    let brokeAt: number | null = null
    for (const build of [...job.builds].reverse()) {
      if (build.result === 'FAILURE' || build.result === 'UNSTABLE') brokeAt ??= build.timestamp
      else if (build.result === 'SUCCESS') {
        if (brokeAt !== null && build.timestamp >= from && build.timestamp < to) took.push(build.timestamp - brokeAt)
        brokeAt = null
      }
    }
  }
  assert.equal(stats.recovery.current.fixes, took.length)
  if (took.length) assert.equal(stats.recovery.current.longestMs, Math.max(...took))

  // Each bucket carries the time of the builds that finished in it.
  assert.ok(stats.timeline.some((b: any) => b.p50Ms !== null && b.p95Ms >= b.p50Ms))
  assert.ok(stats.topFailing.every((f: any) => typeof f.ignored === 'boolean'))
})

test('builds are found by a parameter, by name and value', async () => {
  const release = await search('BRANCH=release')
  assert.ok(release.total > 0)
  assert.ok(release.runs.every((r) => r.job === 'payments/loan-scoring-api'))
  assert.ok(release.runs.every((r) => r.parameters.some((p: any) => p.name === 'BRANCH' && p.value === 'release/2.3')))

  // A bare word matches parameter values too, and words narrow each other.
  const staging = await search('staging release')
  assert.ok(staging.total > 0 && staging.total < release.total)
  assert.ok(staging.runs.every((r) => r.parameters.some((p: any) => p.value === 'staging')))
})

test('a hidden parameter cannot be searched for, and never leaves the API', async () => {
  assert.equal((await search('API_TOKEN=tok')).total, 0)
  assert.equal((await search('tok-123')).total, 0)
  const deploy = await search('deploy-prod')
  assert.ok(deploy.total > 0)
  for (const run of deploy.runs) {
    assert.deepEqual(run.parameters.find((p: any) => p.name === 'API_TOKEN'), { name: 'API_TOKEN', value: '[hidden]', hidden: true })
    assert.deepEqual(run.parameters.find((p: any) => p.name === 'DB_PASSWORD'), { name: 'DB_PASSWORD', value: '[hidden]', hidden: true })
  }
})

test('builds are found by number, agent and cause, and filtered by result', async () => {
  assert.ok((await search('#40')).runs.some((r) => r.job === 'payments/loan-scoring-api' && r.number === 40))
  assert.ok((await search('linux-03')).runs.every((r) => r.builtOn === 'linux-03'))
  assert.ok((await search('SCM')).runs.every((r) => r.causes.some((c: string) => /SCM/.test(c))))
  const failed = await search('', '&result=failure')
  assert.ok(failed.total > 0 && failed.runs.every((r) => r.result === 'failure'))
  // A % in the search is a character, not a wildcard: it finds only the
  // multibranch job whose name really holds one.
  const percent = await search('%')
  assert.equal(percent.total, 3)
  assert.ok(percent.runs.every((r) => r.job === 'agriland-api/feature%2Fscoring'))
})

test('results page, with the total alongside', async () => {
  const first = await json<{ total: number; runs: any[] }>(await call('alice', 'GET', '/jenkins/runs?window=7d&limit=10'))
  const second = await json<{ total: number; runs: any[] }>(await call('alice', 'GET', '/jenkins/runs?window=7d&limit=10&offset=10'))
  assert.equal(first.runs.length, 10)
  assert.equal(first.total, second.total)
  assert.notDeepEqual(first.runs[0], second.runs[0])
  const times = first.runs.map((r) => r.startedAt)
  assert.deepEqual(times, [...times].sort().reverse())
})

test('the parameter filter offers names with their commonest values, never secrets', async () => {
  const params = await json<any[]>(await call('alice', 'GET', '/jenkins/parameters?window=7d'))
  const branch = params.find((p) => p.name === 'BRANCH')
  assert.deepEqual(branch.values.map((v: any) => v.value).sort(), ['main', 'release/2.3'])
  assert.ok(!params.some((p) => p.name === 'API_TOKEN' || p.name === 'DB_PASSWORD'))
})

test('a build shows its stages, commits, agent, parameters and the end of its log', async () => {
  const run = await json(await call('alice', 'GET', `/jenkins/run?job=${encodeURIComponent('payments/loan-scoring-api')}&number=40`))
  assert.equal(run.result, 'failure')
  assert.equal(run.builtOn, 'linux-01')
  assert.deepEqual(
    run.stages.map((s: any) => `${s.name}:${s.result}`),
    ['Checkout:success', 'Build:success', 'Test:failure', 'Deploy:not_built'],
  )
  // The server has Pipeline Graph View, which says what ran in parallel and which branch broke.
  assert.equal(run.stagesFrom, 'graph')
  const test = run.stages.find((s: any) => s.name === 'Test')
  assert.deepEqual(
    test.branches.map((b: any) => `${b.name}:${b.result}`),
    ['Unit tests:failure', 'Integration tests:success'],
  )
  assert.deepEqual(run.changes, [{ commit: 'c0ffee40', message: 'Fix scoring for build 40', author: 'alice' }])
  assert.match(run.log, /ERROR: script returned exit code 1/)
  assert.equal(run.logUrl, `${run.url}consoleText`)
  assert.equal(run.notReplayable, null)
})

test('a freestyle build has no stages, and one with a password cannot be run again', async () => {
  const run = await json(await call('alice', 'GET', `/jenkins/run?job=${encodeURIComponent('payments/deploy-prod')}&number=5`))
  assert.deepEqual(run.stages, [])
  assert.equal(run.stagesFrom, null)
  assert.match(run.notReplayable, /password parameter \(DB_PASSWORD\)/)
})

test('a multibranch branch with an encoded slash is found', async () => {
  const run = await json(await call('alice', 'GET', `/jenkins/run?job=${encodeURIComponent('agriland-api/feature%2Fscoring')}&number=3`))
  assert.equal(run.result, 'success')
  // No Pipeline Graph View here: Stage View's flat list, no branches.
  assert.equal(run.stagesFrom, 'stage-view')
  assert.ok(run.stages.length > 0 && run.stages.every((s: any) => s.branches.length === 0))
})

test('a build that does not exist is a 404, not a 500', async () => {
  assert.equal((await call('alice', 'GET', `/jenkins/run?job=nope&number=1`)).status, 404)
})

test('re-running uses the parameters the build had, and is audited', async () => {
  const res = await call('alice', 'POST', '/jenkins/rebuild', { job: 'payments/loan-scoring-api', number: 40 })
  assert.equal(res.status, 202)
  assert.ok((await res.json()).queueId)
  assert.deepEqual(fake.triggered.at(-1), {
    job: 'payments/loan-scoring-api',
    parameters: { BRANCH: 'release/2.3', ENV: 'staging', SKIP_TESTS: 'false' },
  })
  const [entry] = await json<any[]>(await call('alice', 'GET', '/jenkins/audit'))
  assert.equal(entry.action, 'rebuild')
  assert.equal(entry.actor, 'alice')
  assert.equal(entry.build, 40)
  assert.equal(entry.ok, true)
  // The queue is live, so the new item shows at once.
  assert.equal((await json(await call('alice', 'GET', '/jenkins'))).counts.queued, 2)
})

test('a build with a password parameter is not re-run blank, and the refusal is audited', async () => {
  const before = fake.triggered.length
  const res = await call('alice', 'POST', '/jenkins/rebuild', { job: 'payments/deploy-prod', number: 5 })
  assert.equal(res.status, 409)
  assert.match((await res.json()).error.message, /Run it in Jenkins/)
  assert.equal(fake.triggered.length, before)
  const [entry] = await json<any[]>(await call('alice', 'GET', '/jenkins/audit'))
  assert.equal(entry.ok, false)
  assert.match(entry.error, /password parameter/)
})

test('a running build can be stopped, and history catches up', async () => {
  const running = (fake.find(['inventories-lint']) as { builds: FakeBuild[] }).builds[0]!
  assert.equal((await call('alice', 'POST', '/jenkins/stop', { job: 'inventories-lint', number: running.number })).status, 202)
  assert.deepEqual(fake.stopped, [`inventories-lint#${running.number}`])
  await sync()
  const { runs } = await search(`#${running.number} inventories-lint`)
  assert.equal(runs[0].result, 'aborted')
})

test('a queued build can be taken out of the queue, once', async () => {
  assert.equal((await call('alice', 'POST', '/jenkins/queue/499/cancel')).status, 200)
  assert.ok(!fake.queue.some((q) => q.id === 499))
  const again = await call('alice', 'POST', '/jenkins/queue/499/cancel')
  assert.equal(again.status, 404)
  assert.match((await again.json()).error.message, /no longer waiting/)
})

test('the actions are refused without the permission too', async () => {
  assert.equal((await call('bob', 'POST', '/jenkins/rebuild', { job: 'payments/loan-scoring-api', number: 40 })).status, 403)
})

test('a failing job can be ignored until it passes: off the failing list, back when it breaks again', async () => {
  const job = 'payments/loan-scoring-api'
  const before = await json(await call('alice', 'GET', '/jenkins'))
  assert.ok(before.failures.some((f: any) => f.job === job))

  assert.equal((await call('bob', 'POST', '/jenkins/ignore', { job, until: 'pass', reason: 'Known flaky test' })).status, 403)
  const short = await call('alice', 'POST', '/jenkins/ignore', { job, until: 'pass', reason: 'x' })
  assert.equal(short.status, 400)
  assert.match((await short.json()).error.message, /Say why/)

  await json(await call('alice', 'POST', '/jenkins/ignore', { job, until: 'pass', reason: 'Known flaky test, PAY-77' }))
  const ignored = await json(await call('alice', 'GET', '/jenkins'))
  assert.ok(!ignored.failures.some((f: any) => f.job === job))
  assert.equal(ignored.counts.failing, before.counts.failing - 1)
  const row = ignored.ignored.find((f: any) => f.job === job)
  assert.deepEqual({ reason: row.ignored.reason, by: row.ignored.by, untilPass: row.ignored.untilPass }, { reason: 'Known flaky test, PAY-77', by: 'alice', untilPass: true })
  const audit = await json<any[]>(await call('alice', 'GET', '/jenkins/audit'))
  assert.deepEqual({ action: audit[0].action, job: audit[0].job, note: audit[0].note }, { action: 'ignore', job, note: 'Known flaky test, PAY-77 (until it passes)' })

  // It passes: no longer failing at all. It breaks again: back on the list, the ignore spent.
  fake.addBuild(job, { result: 'SUCCESS' })
  await sync()
  const passed = await json(await call('alice', 'GET', '/jenkins'))
  assert.ok(!passed.failures.some((f: any) => f.job === job) && !passed.ignored.some((f: any) => f.job === job))
  fake.addBuild(job, { result: 'FAILURE' })
  await sync()
  assert.ok((await json(await call('alice', 'GET', '/jenkins'))).failures.some((f: any) => f.job === job))
})

test('an ignore for a time holds through new failures, and can be stopped', async () => {
  const job = 'payments/deploy-prod'
  await json(await call('alice', 'POST', '/jenkins/ignore', { job, until: '7d', reason: 'Prod freeze until Monday' }))
  fake.addBuild(job, { result: 'FAILURE' })
  await sync()
  const o = await json(await call('alice', 'GET', '/jenkins'))
  const row = o.ignored.find((f: any) => f.job === job)
  assert.equal(row.ignored.untilPass, false)
  assert.ok(Date.parse(row.ignored.expiresAt) > Date.now() + 6 * 86_400_000)

  await json(await call('alice', 'POST', '/jenkins/unignore', { job }))
  assert.ok((await json(await call('alice', 'GET', '/jenkins'))).failures.some((f: any) => f.job === job))
  assert.equal((await call('alice', 'POST', '/jenkins/unignore', { job })).status, 404)
  assert.equal((await call('alice', 'POST', '/jenkins/ignore', { job: 'no/such-job', until: 'pass', reason: 'Gone for good' })).status, 404)
})
