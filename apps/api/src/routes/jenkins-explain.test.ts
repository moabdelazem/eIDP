// "What went wrong?" end to end: a fake Jenkins with failed builds, a fake
// Ollama answering like a model, real Postgres for the kept answers and real
// LDAP for who may ask. Needs the containers.
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

const jenkins = createFakeJenkins()
const ollama = createFakeOllama()
const j = await listen(jenkins.app.fetch)
const o = await listen(ollama.app.fetch)
const url = `http://localhost:${j.port}/jenkins`

process.env.JENKINS_URL = url
process.env.JENKINS_USER = 'eidp'
process.env.JENKINS_TOKEN = 'fake'
process.env.OLLAMA_URL = `http://localhost:${o.port}`
process.env.OLLAMA_MODEL = 'qwen2.5'
process.env.OLLAMA_NUM_CTX = '8192'

const { createApp } = await import('../app.ts')
const { closeDb, ensureSchema, query } = await import('../lib/db.ts')
const app = createApp()
const tokens: Record<string, string> = {}

// Keyed by this fake's URL, which carries a fresh port: only ever these tests' rows.
const forget = () => query('delete from build_explanations where server = $1', [url])

before(async () => {
  await ensureSchema()
  await forget()
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
  await forget()
  await closeDb()
  j.server.close()
  o.server.close()
})

function call(who: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const LOAN = { job: 'payments/loan-scoring-api', number: 40 }
const explain = (who = 'alice', build: { job: string; number: number; fresh?: boolean } = LOAN) => call(who, 'POST', '/jenkins/explain', build)
const kept = (build = LOAN) => call('alice', 'GET', `/jenkins/explain?job=${encodeURIComponent(build.job)}&number=${build.number}`)

async function json<T = Record<string, any>>(res: Response): Promise<T> {
  assert.ok(res.ok, `${res.status}: ${await res.clone().text()}`)
  return (await res.json()) as T
}

test('only someone who may see Jenkins and use the AI may ask', async () => {
  assert.equal((await explain('bob')).status, 403)
  assert.equal((await call('bob', 'GET', `/jenkins/explain?job=x&number=1`)).status, 403)
})

test('before anyone asks, there is no answer, and the page is told the AI is there', async () => {
  const body = await json(await kept())
  assert.deepEqual(body.ai, { configured: true, model: 'qwen2.5' })
  assert.equal(body.explanation, null)
})

test('a failed build is explained, citing the log lines that show why', async () => {
  const calls = ollama.requests.length
  const answer = await json(await explain())
  assert.equal(ollama.requests.length, calls + 1)

  assert.match(answer.summary, /The Test stage failed/)
  assert.equal(answer.category, 'test_failure')
  assert.equal(answer.model, 'qwen2.5')
  assert.equal(answer.createdByName, 'Alice Example')
  assert.ok(answer.evidence.length > 0)

  // Cited lines are numbered as the build page numbers the same log, and
  // their text is the log's own.
  const run = await json(await call('alice', 'GET', `/jenkins/run?job=${encodeURIComponent(LOAN.job)}&number=${LOAN.number}`))
  const lines = run.log.replace(/\n$/, '').split('\n')
  for (const { line, text } of answer.evidence) assert.equal(text, lines[line - 1])
  assert.ok(answer.evidence.some((e: any) => /script returned exit code 1/.test(e.text)))
})

test('the model is sent the failed stage, the parameters and the numbered log — never a secret', async () => {
  const sent = ollama.requests.at(-1)!
  assert.equal(sent.model, 'qwen2.5')
  assert.equal(sent.options?.num_ctx, 8192)
  assert.ok(sent.format, 'a JSON schema for the answer')
  const user = sent.messages.find((m) => m.role === 'user')!.content
  assert.match(user, /^Failed stage: Test$/m)
  assert.match(user, /^Parameters: BRANCH=release\/2\.3, ENV=staging, SKIP_TESTS=false$/m)
  assert.match(user, /^\d+: ERROR: script returned exit code 1$/m)
  for (const secret of ['s3cr3t-pass', 'hunter2', 'eyJhbGciOiJIUzI1NiJ9']) assert.ok(!user.includes(secret), secret)
})

test('the answer is kept: asking again, or opening the page, does not ask the model', async () => {
  const calls = ollama.requests.length
  const again = await json(await explain('carol'))
  assert.equal(ollama.requests.length, calls)
  assert.equal(again.createdByName, 'Alice Example')
  assert.equal((await json(await kept())).explanation.summary, again.summary)
})

test('asking afresh replaces the kept answer', async () => {
  const calls = ollama.requests.length
  const fresh = await json(await explain('carol', { ...LOAN, fresh: true }))
  assert.equal(ollama.requests.length, calls + 1)
  assert.equal(fresh.createdByName, 'Carol Example')
  assert.equal((await json(await kept())).explanation.createdByName, 'Carol Example')
})

test('two people asking at once share one answer from one call', async () => {
  const build = { job: 'payments/deploy-prod', number: 5 }
  const calls = ollama.requests.length
  const [a, b] = await Promise.all([json(await explain('alice', build)), json(await explain('carol', build))])
  assert.equal(ollama.requests.length, calls + 1)
  assert.equal(a.summary, b.summary)
})

test('a line the model invents is dropped from the evidence', async () => {
  ollama.setMode('invent-line')
  try {
    const answer = await json(await explain('alice', { job: 'agriland-api/main', number: 20, fresh: true }))
    assert.ok(!answer.evidence.some((e: any) => e.line === 999_999))
  } finally {
    ollama.setMode('ok')
  }
})

test('broken JSON is asked for once more before giving up', async () => {
  ollama.setMode('bad-json-once')
  const calls = ollama.requests.length
  try {
    await json(await explain('alice', { ...LOAN, fresh: true }))
    assert.equal(ollama.requests.length, calls + 2)
  } finally {
    ollama.setMode('ok')
  }

  ollama.setMode('bad-json')
  try {
    const res = await explain('alice', { ...LOAN, fresh: true })
    assert.equal(res.status, 502)
    assert.match((await res.json()).error.message, /could not be read/)
  } finally {
    ollama.setMode('ok')
  }
})

test('a model Ollama does not have says how to get it', async () => {
  ollama.setMode('no-model')
  try {
    const res = await explain('alice', { ...LOAN, fresh: true })
    assert.equal(res.status, 502)
    assert.match((await res.json()).error.message, /ollama pull qwen2\.5/)
  } finally {
    ollama.setMode('ok')
  }
})

test('a build that passed has nothing to explain', async () => {
  const res = await explain('alice', { job: 'payments/payments-web', number: 9 })
  assert.equal(res.status, 409)
  assert.match((await res.json()).error.message, /Only a failed or unstable build/)
})
