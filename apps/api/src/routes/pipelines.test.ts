// My pipelines end to end: real LDAP (bob is in Payments; carol in Payments
// and DEVOPS; dave in nothing), real Postgres, a fake Jenkins with a week of
// builds — including the shared platform/build job maika runs on every push,
// and platform/deploy, which says in APP_NAME which app it deploys — and two
// systems of our own in the catalog, so whose each run is comes from the same
// places it does in use.
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
const { forgetApplications } = await import('../services/pipelines.ts')
const { syncJenkinsAccess } = await import('../services/jenkins-access.ts')
const app = createApp()
const tokens: Record<string, string> = {}

/**
 * Ours alone: catalog tests replace the catalog wholesale, so the lock is held
 * throughout. Payments owns loan-scoring-api and payments-web; nfp-backend
 * belongs to a team nobody here is in; agriland-mobile is in no catalog.
 */
const SYSTEMS = {
  __pipelines_pay: { project: 'PipeLab', team: 'Payments', apps: ['loan-scoring-api', 'payments-web'] },
  __pipelines_nb: { project: 'NBLab', team: 'NBTeam', apps: ['nfp-backend'] },
}
const catalogLock = new pg.Client({ connectionString: config.DATABASE_URL })
let auditFloor = 0
let binding: string | null = null

const forget = () =>
  Promise.all(
    ['jenkins_builds', 'jenkins_jobs', 'jenkins_sync', 'jenkins_job_access', 'jenkins_access_sync'].map((table) =>
      query(`delete from ${table} where server = $1`, [url]),
    ),
  )

before(async () => {
  await ensureSchema()
  await catalogLock.connect()
  await catalogLock.query('select pg_advisory_lock(4202)')
  await forget()
  for (const [dir, system] of Object.entries(SYSTEMS)) {
    await query('delete from catalog_systems where dir = $1', [dir])
    await query(`insert into catalog_systems (dir, project_name, teams) values ($1, $2, $3)`, [dir, system.project, { dev: system.team }])
    for (const name of system.apps) {
      await query(`insert into catalog_applications (id, system_dir, group_name, name, repository) values ($1, $2, $3, $3, $3)`, [`${dir}/${name}`, dir, name])
    }
  }
  forgetApplications()
  auditFloor = Number((await query<{ max: string | null }>('select max(id) from jenkins_audit')).rows[0]?.max ?? 0)
  for (const who of ['alice', 'bob', 'carol', 'dave']) {
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: who, password: `${who}pw` }),
    })
    tokens[who] = ((await res.json()) as { token: string }).token
  }
  const synced = await json(await call('alice', 'POST', '/jenkins/sync'))
  assert.equal(synced.ok, true, synced.error)
  // No per-team rules yet: the catalog decides until a test says otherwise.
  await syncJenkinsAccess()
})

after(async () => {
  if (binding) await query('delete from rbac_bindings where id = $1', [binding])
  await query('delete from jenkins_audit where id > $1', [auditFloor])
  for (const dir of Object.keys(SYSTEMS)) await query('delete from catalog_systems where dir = $1', [dir])
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

type Mine = { runs: any[]; pipelines: any[]; queue: any[]; access: { decides: string } }
const mine = async (who: string, window = '7d') => json<Mine>(await call(who, 'GET', `/pipelines?window=${window}`))
const param = (run: { parameters: { name: string; value: string | null }[] }, name: string) => run.parameters.find((p) => p.name === name)?.value
const kinds = (run: { reasons: { kind: string }[] }) => run.reasons.map((r) => r.kind)

/** A stored run of `job` matching `where`, for tests that need one by its content. */
async function stored(job: string, where: (row: any) => boolean = () => true) {
  const { rows } = await query<any>('select * from jenkins_builds where server = $1 and job = $2 order by number desc', [url, job])
  const row = rows.find(where)
  assert.ok(row, `a run of ${job}`)
  return row as { number: number; parameters: { name: string; value: string }[]; causes: string[]; authors: string[] }
}

test('the sync keeps who wrote the commits each build built', async () => {
  const push = await stored('platform/build', (r) => r.parameters.some((p: any) => /loan-scoring-api/.test(p.value)))
  assert.deepEqual(push.causes, ['Started by user maika'])
  assert.ok(push.authors.includes('bob') && push.authors.includes('bob@eidp.local'), push.authors.join())
})

test('a push maika built is the commit author’s run, and their team’s — no one else’s', async () => {
  const bobs = await mine('bob')
  const pushes = bobs.runs.filter((r) => r.job === 'platform/build')
  assert.ok(pushes.length > 0)
  for (const run of pushes) {
    // Only the pushes to Payments' loan-scoring-api: carol's nfp-backend pushes run through the same job.
    assert.match(param(run, 'REPOSITORY')!, /loan-scoring-api/)
    assert.deepEqual(run.applications, ['loan-scoring-api'])
    assert.equal(run.matchedBy, 'parameters')
    assert.deepEqual(run.reasons.find((r: any) => r.kind === 'commit'), { kind: 'commit', by: 'maika' })
    assert.ok(kinds(run).includes('team'))
    assert.equal(run.personal, true)
  }

  // carol's pushes are hers by commit, though no team of hers owns nfp-backend.
  const carols = await mine('carol')
  const nfp = carols.runs.filter((r) => r.job === 'platform/build' && /nfp-backend/.test(param(r, 'REPOSITORY')!))
  assert.ok(nfp.length > 0)
  for (const run of nfp) assert.deepEqual(kinds(run), ['commit'])
})

test('a shared deploy job shows only the runs for your projects, as a row of their own', async () => {
  const bobs = await mine('bob')
  const deploys = bobs.runs.filter((r) => r.job === 'platform/deploy')
  assert.ok(deploys.length > 0)
  // alice started every deploy; bob sees the loan-scoring-api ones because Payments owns it.
  assert.ok(deploys.every((r) => param(r, 'APP_NAME') === 'loan-scoring-api' && kinds(r).join() === 'team'))
  assert.equal(deploys.some((r) => r.personal), false)

  const rows = bobs.pipelines.filter((p) => p.job.startsWith('platform/'))
  assert.deepEqual(rows.map((p) => `${p.job} → ${p.applications.join()}`).sort(), ['platform/build → loan-scoring-api', 'platform/deploy → loan-scoring-api'])
  const deployRow = rows.find((p) => p.job === 'platform/deploy')
  assert.equal(deployRow.finished.builds, deploys.length)
})

test('every run listed is yours by name or your team’s project, and says which', async () => {
  const bobs = await mine('bob')
  for (const run of bobs.runs) {
    const started = run.causes.includes('Started by user bob')
    assert.equal(kinds(run).includes('started'), started, `${run.job} #${run.number}`)
    if (!run.personal) assert.ok(run.owners.some((o: any) => o.teams.includes('Payments')), `${run.job} #${run.number} is Payments'`)
  }
  // Every build bob started in the week is there.
  const { rows } = await query<{ n: string }>(
    `select count(*) as n from jenkins_builds where server = $1 and 'Started by user bob' = any(causes) and started_at >= now() - interval '7 days'`,
    [url],
  )
  assert.equal(bobs.runs.filter((r) => kinds(r).includes('started')).length, Number(rows[0]!.n))
})

test('someone with no team, no builds and no commits has no runs', async () => {
  const daves = await mine('dave')
  assert.deepEqual(daves.runs, [])
  assert.deepEqual(daves.pipelines, [])
  assert.deepEqual(daves.queue, [])
})

test('a run of yours opens for you; one for another project is not found, even on a shared job', async () => {
  const own = await stored('platform/build', (r) => r.authors.includes('bob'))
  const opened = await json(await call('bob', 'GET', `/jenkins/run?job=platform/build&number=${own.number}`))
  assert.equal(opened.canOperate, false)

  const carols = await stored('platform/build', (r) => r.authors.includes('carol'))
  const res = await call('bob', 'GET', `/jenkins/run?job=platform/build&number=${carols.number}`)
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error.code, 'pipeline_not_found')
  assert.equal((await call('dave', 'GET', `/jenkins/run?job=platform/build&number=${own.number}`)).status, 404)
  // DevOps see every run.
  assert.equal((await json(await call('alice', 'GET', `/jenkins/run?job=platform/build&number=${carols.number}`))).canOperate, true)
})

test('writing the commit does not let you act; a pipeline operator acts only on their team’s projects', async () => {
  const deploy = await stored('platform/deploy', (r) => r.parameters.some((p: any) => p.value === 'loan-scoring-api'))
  const other = await stored('platform/deploy', (r) => r.parameters.some((p: any) => p.value === 'agriland-mobile'))
  assert.equal((await call('bob', 'POST', '/jenkins/rebuild', { job: 'platform/deploy', number: deploy.number })).status, 403)

  const { rows } = await query<{ id: string }>(
    `insert into rbac_bindings (subject_type, subject, role, scope_type, scope, reason, created_by)
     values ('user', 'bob', 'pipeline-operator', 'team', 'Payments', 'pipelines test', 'alice') returning id`,
  )
  binding = rows[0]!.id
  const bobs = await mine('bob')
  assert.ok(bobs.runs.filter((r) => r.job === 'platform/deploy').every((r) => r.canOperate))

  // The shared deploy job, for Payments' app: queued, and the audit says bob asked.
  const queued = await call('bob', 'POST', '/jenkins/rebuild', { job: 'platform/deploy', number: deploy.number })
  assert.equal(queued.status, 202, await queued.clone().text())
  assert.deepEqual(fake.triggered.at(-1), { job: 'platform/deploy', parameters: { APP_NAME: 'loan-scoring-api', ENV: 'uat' } })
  const audit = await query<{ actor: string; action: string; ok: boolean }>('select actor, action, ok from jenkins_audit where id > $1 order by id', [auditFloor])
  assert.deepEqual(audit.rows.at(-1), { actor: 'bob', action: 'rebuild', ok: true })

  // The same job deploying another app is not his: refused before Jenkins is asked.
  const before = fake.triggered.length
  const refused = await call('bob', 'POST', '/jenkins/rebuild', { job: 'platform/deploy', number: other.number })
  assert.equal(refused.status, 403)
  assert.match((await refused.json()).error.message, /team or project it is for/)
  assert.equal(fake.triggered.length, before)

  // The queue is judged by what each item will run with.
  fake.queue.push({ id: 701, job: 'platform/deploy', since: Date.now(), why: 'Waiting', parameters: { APP_NAME: 'agriland-mobile' } })
  fake.queue.push({ id: 702, job: 'platform/deploy', since: Date.now(), why: 'Waiting', parameters: { APP_NAME: 'payments-web' } })
  const queue = (await mine('bob')).queue
  assert.ok(!queue.some((q) => q.id === 701), 'another app’s deploy is not in his queue')
  assert.deepEqual(queue.find((q) => q.id === 702)?.applications, ['payments-web'])
  assert.equal((await call('bob', 'POST', '/jenkins/queue/701/cancel')).status, 403)
  assert.equal((await call('bob', 'POST', '/jenkins/queue/702/cancel')).status, 200)
  assert.ok(fake.queue.some((q) => q.id === 701) && !fake.queue.some((q) => q.id === 702))

  // The Jenkins page itself stays DevOps': a scoped operator is not a viewer.
  assert.equal((await call('bob', 'GET', '/jenkins')).status, 403)
  await query('delete from rbac_bindings where id = $1', [binding])
  binding = null
})

// ---- Jenkins' own rules -------------------------------------------------------------

for (const strategy of ['role-strategy', 'matrix'] as const) {
  test(`with ${strategy} rules, Jenkins bounds a team’s runs, and a grant on a job names its runs`, async () => {
    fake.setAccess(strategy)
    const state = await syncJenkinsAccess()
    assert.equal(state.ok, true, state.error ?? '')
    assert.equal(state.source, strategy)

    const bobs = await mine('bob')
    assert.equal(bobs.access.decides, 'jenkins')
    // Payments may read loan-scoring-api in Jenkins, and its runs say so.
    const loan = bobs.runs.find((r) => r.job === 'payments/loan-scoring-api')
    assert.deepEqual(
      loan.reasons.filter((r: any) => r.kind === 'jenkins').map((r: any) => ({ sid: r.sid, group: r.group })),
      [{ sid: 'Payments', group: true }],
    )
    // The shared jobs: everyone may read them, so runs for Payments' apps stay
    // Payments' — and a grant to everyone names nobody.
    const deploys = bobs.runs.filter((r) => r.job === 'platform/deploy')
    assert.ok(deploys.length > 0 && deploys.every((r) => param(r, 'APP_NAME') === 'loan-scoring-api' && kinds(r).join() === 'team'))

    // dave, in no group, may read agriland-api by name: those runs are his to
    // see. agriland-mobile's deploys are not — a grant on a shared job says
    // nothing about whose each run is.
    const daves = await mine('dave')
    assert.deepEqual([...new Set(daves.runs.map((r) => r.job))].sort(), ['agriland-api/feature%2Fscoring', 'agriland-api/main'])
    assert.ok(daves.runs.every((r) => kinds(r).join() === 'jenkins' && r.reasons[0].group === false && r.canOperate === false))
  })
}

test('with no per-team rules in Jenkins, the catalog decides again', async () => {
  fake.setAccess('none')
  const state = await syncJenkinsAccess()
  assert.equal(state.source, 'none')
  assert.equal((await mine('bob')).access.decides, 'catalog')
  assert.deepEqual((await mine('dave')).runs, [])
})
