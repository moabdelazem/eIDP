// Failures explained as they happen: a fake Jenkins with a week of builds, a
// fake Ollama, real Postgres. Needs the containers.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { serve } from '@hono/node-server'
import { createFakeJenkins } from '../integrations/jenkins/fake-server.ts'
import { createFakeOllama } from '../integrations/ollama/fake-server.ts'

async function listen(fetch: (req: Request) => Response | Promise<Response>) {
  const server = serve({ fetch, port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

const jenkinsFake = createFakeJenkins()
const ollama = createFakeOllama()
const j = await listen(jenkinsFake.app.fetch)
const o = await listen(ollama.app.fetch)
const url = `http://localhost:${j.port}/jenkins`

process.env.JENKINS_URL = url
process.env.JENKINS_USER = 'eidp'
process.env.JENKINS_TOKEN = 'fake'
process.env.OLLAMA_URL = `http://localhost:${o.port}`
process.env.OLLAMA_MODEL = 'qwen2.5'

const { createApp } = await import('../app.ts')
const { closeDb, ensureSchema, query } = await import('../lib/db.ts')
const { syncJenkins } = await import('../services/jenkins-sync.ts')
const { explainNewFailures } = await import('../services/auto-explain.ts')
const app = createApp()
let alice = ''

// Every table here is keyed by this fake's URL, fresh per run: only ever these tests' rows.
const TABLES = ['build_explanations', 'build_explain_attempts', 'jenkins_builds', 'jenkins_jobs', 'jenkins_sync']
const forget = () => Promise.all(TABLES.map((t) => query(`delete from ${t} where server = $1`, [url])))

before(async () => {
  await ensureSchema()
  await forget()
  await syncJenkins()
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'alicepw' }),
  })
  alice = ((await res.json()) as { token: string }).token
})

after(async () => {
  await forget()
  await closeDb()
  j.server.close()
  o.server.close()
})

const get = async (path: string) =>
  (await (await app.request(path, { headers: { authorization: `Bearer ${alice}` } })).json()) as Record<string, any>
const explanation = (job: string, number: number) => get(`/jenkins/explain?job=${encodeURIComponent(job)}&number=${number}`)
const explained = async () =>
  (await query<{ job: string; number: number; created_by: string }>('select job, number, created_by from build_explanations where server = $1 order by job', [url])).rows

test('before the run, a fresh failure says it is on its way', async () => {
  const body = await explanation('payments/loan-scoring-api', 40)
  assert.equal(body.explanation, null)
  assert.deepEqual(body.auto, { state: 'queued', error: null })
})

test('each failing job’s latest failure is explained, once, without anyone asking', async () => {
  const calls = ollama.requests.length
  assert.deepEqual(await explainNewFailures(), { explained: 3, failed: 0 })
  assert.equal(ollama.requests.length, calls + 3)
  assert.deepEqual(
    (await explained()).map((r) => `${r.job}#${r.number}:${r.created_by}`),
    ['agriland-api/main#20:e-idp', 'payments/deploy-prod#5:e-idp', 'payments/loan-scoring-api#40:e-idp'],
  )

  const body = await explanation('payments/loan-scoring-api', 40)
  assert.equal(body.explanation.automatic, true)
  assert.equal(body.explanation.createdByName, 'e-IDP, automatically')
  assert.equal(body.auto.state, 'off')
})

test('a second run asks the model nothing', async () => {
  const calls = ollama.requests.length
  assert.deepEqual(await explainNewFailures(), { explained: 0, failed: 0 })
  assert.equal(ollama.requests.length, calls)
})

test('only the latest failure of a job: the ones before it in the same streak are left alone', async () => {
  // loan-scoring-api #38 and #39 failed too; only #40 is its latest.
  assert.ok(!(await explained()).some((r) => r.job === 'payments/loan-scoring-api' && r.number !== 40))
  assert.equal((await explanation('payments/loan-scoring-api', 39)).auto.state, 'off')
})

test('a new failure is explained after the sync that finds it', async () => {
  jenkinsFake.addBuild('payments/payments-web', { result: 'FAILURE' })
  await syncJenkins()
  assert.deepEqual(await explainNewFailures(), { explained: 1, failed: 0 })
  assert.ok((await explained()).some((r) => r.job === 'payments/payments-web' && r.number === 11))
})

test('the failing list carries each failure’s one-line explanation', async () => {
  const overview = await get('/jenkins')
  const loan = overview.failures.find((f: any) => f.job === 'payments/loan-scoring-api')
  assert.match(loan.explanation.summary, /The Test stage failed/)
  assert.equal(loan.explanation.category, 'test_failure')
})

test('when the model cannot explain a build, it says why and does not retry on every sync', async () => {
  jenkinsFake.addBuild('agriland-api/feature%2Fscoring', { result: 'FAILURE' })
  await syncJenkins()
  ollama.setMode('bad-json')
  try {
    assert.deepEqual(await explainNewFailures(), { explained: 0, failed: 1 })
    const calls = ollama.requests.length
    assert.deepEqual(await explainNewFailures(), { explained: 0, failed: 0 })
    assert.equal(ollama.requests.length, calls, 'not retried straight away')
  } finally {
    ollama.setMode('ok')
  }
  const body = await explanation('agriland-api/feature%2Fscoring', 4)
  assert.equal(body.auto.state, 'failed')
  assert.match(body.auto.error, /could not be read/)
})

test('when Ollama itself is down, the run stops and nothing is held against the build', async () => {
  jenkinsFake.addBuild('inventories-lint', { result: 'FAILURE' })
  await syncJenkins()
  ollama.setMode('no-model')
  try {
    assert.deepEqual(await explainNewFailures(), { explained: 0, failed: 0 })
  } finally {
    ollama.setMode('ok')
  }
  const number = (jenkinsFake.find(['inventories-lint']) as { builds: { number: number }[] }).builds[0]!.number
  assert.equal((await explanation('inventories-lint', number)).auto.state, 'queued')
  assert.deepEqual(await explainNewFailures(), { explained: 1, failed: 0 })
})
