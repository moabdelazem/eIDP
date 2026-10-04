// Weekly digests end to end: real LDAP (bob is in Payments, alice in DEVOPS,
// dave in nothing), real Postgres, a fake Ollama — and a week of builds,
// requests and an incident written straight into the tables, so every count
// is known. DigestLab is a team nobody is in: only digests.all reads it.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { serve } from '@hono/node-server'
import pg from 'pg'
import { createFakeJenkins } from '../integrations/jenkins/fake-server.ts'
import { createFakeOllama } from '../integrations/ollama/fake-server.ts'

const servers: { close: () => void }[] = []
async function start(app: { fetch: (req: Request) => Response | Promise<Response> }) {
  const server = serve({ fetch: app.fetch, port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  servers.push(server)
  return `http://localhost:${(server.address() as AddressInfo).port}`
}

const ollama = createFakeOllama()
// Jenkins is only asked for its access rules (none); the builds are written below.
const url = `${await start(createFakeJenkins().app)}/jenkins`
process.env.JENKINS_URL = url
process.env.JENKINS_USER = 'eidp'
process.env.JENKINS_TOKEN = 'fake'
process.env.OLLAMA_URL = await start(ollama.app)
process.env.OLLAMA_MODEL = 'qwen2.5'

const { createApp } = await import('../app.ts')
const { closeDb, ensureSchema, query } = await import('../lib/db.ts')
const { config } = await import('../lib/config.ts')
const { forgetApplications } = await import('../services/pipelines.ts')
const { syncJenkinsAccess } = await import('../services/jenkins-access.ts')
const { weekOf } = await import('../services/digest.ts')
const app = createApp()
const tokens: Record<string, string> = {}

const SYSTEMS = {
  __digest_lab: { project: 'DigestProj', team: 'DigestLab', apps: ['digest-api', 'digest-web'] },
  __digest_pay: { project: 'DigestPay', team: 'Payments', apps: ['digest-pay'] },
}
const catalogLock = new pg.Client({ connectionString: config.DATABASE_URL })
const requestIds: string[] = []
let sampleFloor = 0

const HOUR = 3_600_000
const DAY = 24 * HOUR
const thisWeek = weekOf(new Date())
const lastWeek = new Date(new Date(`${thisWeek}T00:00:00Z`).getTime() - 7 * DAY).toISOString().slice(0, 10)
const monday = new Date(`${lastWeek}T00:00:00Z`).getTime()
const at = (ms: number) => new Date(monday + ms)

const forget = () =>
  Promise.all(
    ['jenkins_builds', 'jenkins_jobs', 'jenkins_sync', 'jenkins_job_access', 'jenkins_access_sync'].map((t) => query(`delete from ${t} where server = $1`, [url])),
  )

let number = 0
async function build(job: string, result: string, when: Date, parameters: { name: string; value: string }[] = []) {
  await query(
    `insert into jenkins_builds (server, job, number, result, started_at, duration_ms, url, parameters) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [url, job, ++number, result, when, 10 * 60_000, `${url}/job/x/${number}/`, JSON.stringify(parameters.map((p) => ({ ...p, hidden: false })))],
  )
}

async function request(fields: { project: string; repository: string; status: string; teamGroup?: string; requestedAt: Date; completedAt?: Date; error?: string }) {
  const { rows } = await query<{ id: string }>(
    `insert into requests (kind, collection, project, repository, justification, requested_by, requested_by_name, status, team_group, requested_at, completed_at, decided_at, error)
     values ('create_repository', 'DefaultCollection', $1, $2, 'digest test', 'bob', 'Bob Example', $3, $4, $5, $6, $6, $7) returning id`,
    [fields.project, fields.repository, fields.status, fields.teamGroup ?? null, fields.requestedAt, fields.completedAt ?? null, fields.error ?? null],
  )
  requestIds.push(rows[0]!.id)
}

before(async () => {
  await ensureSchema()
  await catalogLock.connect()
  await catalogLock.query('select pg_advisory_lock(4202)')
  await forget()
  await query(`delete from weekly_digests where team in ('DigestLab', 'Payments')`)
  for (const [dir, system] of Object.entries(SYSTEMS)) {
    await query('delete from catalog_systems where dir = $1', [dir])
    await query(`insert into catalog_systems (dir, project_name, teams) values ($1, $2, $3)`, [dir, system.project, { dev: system.team }])
    for (const name of system.apps) {
      await query(`insert into catalog_applications (id, system_dir, group_name, name, repository) values ($1, $2, $3, $3, $3)`, [`${dir}/${name}`, dir, name])
    }
  }
  forgetApplications()
  await syncJenkinsAccess()

  // Last week: digest-api broke, was fixed two hours later, and broke again for good.
  await build('digestlab/digest-api', 'failure', at(1 * HOUR))
  await build('digestlab/digest-api', 'failure', at(2 * HOUR))
  await build('digestlab/digest-api', 'success', at(3 * HOUR))
  await build('digestlab/digest-api', 'failure', at(4 * DAY))
  // The shared deploy job: two runs for digest-web, and one for an app that is not DigestLab's.
  await build('platform/deploy', 'success', at(1 * DAY), [{ name: 'APP_NAME', value: 'digest-web' }])
  await build('platform/deploy', 'success', at(2 * DAY), [{ name: 'APP_NAME', value: 'digest-web' }])
  await build('platform/deploy', 'failure', at(2 * DAY), [{ name: 'APP_NAME', value: 'digest-pay' }])
  // The week before, and the week in progress: neither is last week's.
  await build('digestlab/digest-api', 'success', at(-3 * DAY))
  await build('digestlab/digest-api', 'success', at(-2 * DAY))
  await build('digestlab/digest-api', 'failure', new Date(Date.now() - 60_000))

  const suffix = Date.now().toString(36)
  await request({ project: 'DigestProj', repository: `waiting-${suffix}`, status: 'pending', requestedAt: at(DAY) })
  await request({ project: 'DigestProj', repository: `done-${suffix}`, status: 'completed', requestedAt: at(DAY), completedAt: at(DAY + HOUR) })
  await request({ project: 'Elsewhere', repository: `broke-${suffix}`, status: 'failed', teamGroup: 'DigestLab', requestedAt: at(2 * DAY), completedAt: at(2 * DAY + HOUR), error: 'digest test: could not grant access' })
  await request({ project: 'DigestProj', repository: `old-${suffix}`, status: 'completed', requestedAt: at(-20 * DAY), completedAt: at(-20 * DAY) })

  sampleFloor = Number((await query<{ max: string | null }>('select max(id) from health_samples')).rows[0]?.max ?? 0)
  for (const [when, status, summary] of [
    [at(3 * DAY), 'degraded', 'digest test: sealed'],
    [at(3 * DAY + HOUR), 'ok', 'fine'],
  ] as const) {
    await query(`insert into health_samples (at, component, status, latency_ms, summary) values ($1, 'vault', $2, 5, $3)`, [when, status, summary])
  }

  for (const who of ['alice', 'bob', 'dave']) {
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: who, password: `${who}pw` }),
    })
    tokens[who] = ((await res.json()) as { token: string }).token
  }
})

after(async () => {
  await query(`delete from weekly_digests where team in ('DigestLab', 'Payments')`)
  await query('delete from requests where id = any($1::uuid[])', [requestIds])
  await query('delete from health_samples where id > $1', [sampleFloor])
  for (const dir of Object.keys(SYSTEMS)) await query('delete from catalog_systems where dir = $1', [dir])
  await forget()
  await catalogLock.query('select pg_advisory_unlock(4202)')
  await catalogLock.end()
  await closeDb()
  for (const s of servers) s.close()
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

test('people read their own teams’ digests; digests.all reads every team’s', async () => {
  const bob = await json(await call('bob', 'GET', '/digests'))
  assert.ok(bob.mine.includes('Payments'))
  assert.ok(!bob.teams.includes('DigestLab'))
  assert.equal(bob.canRegenerate, false)
  assert.equal(bob.current, thisWeek)
  assert.equal(bob.weeks[0], thisWeek)
  assert.equal(bob.weeks[1], lastWeek)

  assert.ok((await json(await call('alice', 'GET', '/digests'))).teams.includes('DigestLab'))
  assert.deepEqual((await json(await call('dave', 'GET', '/digests'))).teams, [])

  const refused = await call('bob', 'GET', '/digests/DigestLab')
  assert.equal(refused.status, 403)
  assert.equal((await refused.json()).error.code, 'not_your_team')
  assert.equal((await call('bob', 'GET', '/digests/NoSuchTeam')).status, 404)
  assert.equal((await call('bob', 'POST', `/digests/Payments/regenerate`, { week: lastWeek })).status, 403)
})

test('a finished week counts the team’s runs, requests and incidents — and the model only words them', async () => {
  const d = await json(await call('alice', 'GET', `/digests/digestlab?week=${lastWeek}`))
  assert.equal(d.team, 'DigestLab', 'the catalog’s spelling')
  assert.equal(d.live, false)
  assert.deepEqual(d.facts.projects, ['DigestProj'])

  const b = d.facts.builds
  // digest-pay's deploy is Payments', and the week before and the week in progress are not last week.
  assert.deepEqual(b.current, { builds: 6, passed: 3, failed: 3, unstable: 0, aborted: 0, successRate: 0.5 })
  assert.equal(b.previous.builds, 2)
  assert.equal(b.previous.successRate, 1)
  assert.equal(b.pipelines, 2)
  assert.equal(b.failing.length, 1)
  assert.deepEqual([b.failing[0].job, b.failing[0].failures, b.failing[0].broken], ['digestlab/digest-api', 3, true])
  // From the first failure to the end of the pass that fixed it.
  assert.deepEqual(b.fixes, { count: 1, medianMs: 2 * HOUR + 10 * 60_000, longestMs: 2 * HOUR + 10 * 60_000 })
  assert.deepEqual(b.busiest.map((x: any) => [x.application, x.builds]), [['digest-api', 4], ['digest-web', 2]])

  const r = d.facts.requests
  assert.equal(r.filed, 3)
  assert.equal(r.completed, 1)
  assert.deepEqual(r.failed.map((x: any) => x.error), ['digest test: could not grant access'])
  assert.ok(r.waiting.some((x: any) => x.target.startsWith('DigestProj/waiting-')))
  assert.ok(d.facts.incidents.some((i: any) => i.summary === 'digest test: sealed' && i.name === 'Secrets (Vault)'))

  assert.equal(d.summary, 'DigestLab passed 50% of its builds this week.')
  assert.deepEqual(d.highlights, ['digestlab/digest-api is still broken — worth a look.'])
  assert.match(d.model, /qwen2\.5/)
  assert.ok(d.weeks.includes(lastWeek))
})

test('a finished week is written once and kept; writing it again replaces it', async () => {
  const first = await json(await call('alice', 'GET', `/digests/DigestLab?week=${lastWeek}`))
  const again = await json(await call('alice', 'GET', `/digests/DigestLab?week=${lastWeek}`))
  assert.equal(again.createdAt, first.createdAt)

  ollama.setMode('no-model')
  try {
    const redone = await json(await call('alice', 'POST', '/digests/DigestLab/regenerate', { week: lastWeek }))
    assert.notEqual(redone.createdAt, first.createdAt)
    // The model failed: the facts stand alone, and say why there are no words.
    assert.equal(redone.summary, null)
    assert.match(redone.error, /ollama pull/)
    assert.equal(redone.facts.builds.current.builds, 6)
  } finally {
    ollama.setMode('ok')
  }
})

test('the week in progress is counted live and never summarised', async () => {
  const d = await json(await call('alice', 'GET', `/digests/DigestLab?week=${thisWeek}`))
  assert.equal(d.live, true)
  assert.equal(d.summary, null)
  assert.equal(d.facts.builds.current.builds, 1)
  assert.equal((await call('alice', 'POST', '/digests/DigestLab/regenerate', { week: thisWeek })).status, 400)
})

test('weeks are Mondays, and a week whose builds are gone is not made up', async () => {
  const notMonday = new Date(monday + DAY).toISOString().slice(0, 10)
  assert.equal((await call('alice', 'GET', `/digests/DigestLab?week=${notMonday}`)).status, 400)
  const old = new Date(monday - 10 * 7 * DAY).toISOString().slice(0, 10)
  const res = await call('alice', 'GET', `/digests/DigestLab?week=${old}`)
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error.code, 'no_digest')
})
