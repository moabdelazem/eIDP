// /elk end to end: real LDAP (alice is in DEVOPS, so devops-admin; bob is in
// Payments only and holds neither elk permission), a fake Elasticsearch, and
// an allowlist of eidp-test-* — so every index outside it is refused here,
// whatever the cluster has.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { serve } from '@hono/node-server'
import { createFakeElasticsearch } from '../../integrations/elasticsearch/fake-server.ts'

const fake = createFakeElasticsearch()
const server = serve({ fetch: fake.app.fetch, port: 0 })
await new Promise((resolve) => server.once('listening', resolve))

process.env.ELASTICSEARCH_URL = `http://localhost:${(server.address() as AddressInfo).port}`
process.env.ELASTICSEARCH_API_KEY = 'fake'
process.env.ELASTICSEARCH_INDICES = 'eidp-test-*'

const { createApp } = await import('../../app.ts')
const { closeDb, migrate } = await import('../../lib/db.ts')
const app = createApp()

fake.put('eidp-test-apps', 'agriland-api', { name: 'agriland-api', technology: 'DotNetCore', environment: 'prd' })
fake.put('eidp-test-apps', 'nfp-backend', { name: 'nfp-backend', technology: 'Spring', environment: 'dev' })
fake.put('secrets', 'one', { password: 'never' })

async function login(username: string): Promise<string> {
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: `${username}pw` }),
  })
  return ((await res.json()) as { token: string }).token
}

function call(token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T
type Failure = { error: { code: string; message: string } }

let alice = '', bob = ''

before(async () => {
  await migrate()
  ;[alice, bob] = await Promise.all([login('alice'), login('bob')])
})

after(async () => {
  await closeDb()
  server.close()
})

test('the status names the cluster and the allowed indices', async () => {
  const res = await call(alice, 'GET', '/elk')
  assert.equal(res.status, 200)
  assert.deepEqual(await json(res), { configured: true, cluster: { name: 'eidp-fake', version: '8.15.0' }, error: null, indices: ['eidp-test-*'] })
})

test('someone without elk.read or elk.write is refused', async () => {
  for (const [method, path, body] of [
    ['GET', '/elk', undefined],
    ['GET', '/elk/indices/eidp-test-apps/documents/agriland-api', undefined],
    ['POST', '/elk/indices/eidp-test-apps/search', {}],
    ['POST', '/elk/indices/eidp-test-apps/documents', { document: { a: 1 } }],
  ] as const) {
    const res = await call(bob, method, path, body)
    assert.equal(res.status, 403, `${method} ${path}`)
    assert.equal((await json<Failure>(res)).error.code, 'forbidden')
  }
})

test('a document is read by id; a missing one is a 404', async () => {
  const res = await call(alice, 'GET', '/elk/indices/eidp-test-apps/documents/agriland-api')
  assert.equal(res.status, 200)
  assert.deepEqual(await json(res), { index: 'eidp-test-apps', id: 'agriland-api', version: 1, source: { name: 'agriland-api', technology: 'DotNetCore', environment: 'prd' } })

  const missing = await call(alice, 'GET', '/elk/indices/eidp-test-apps/documents/nope')
  assert.equal(missing.status, 404)
  assert.equal((await json<Failure>(missing)).error.code, 'document_not_found')
  // A missing index reads the same as a missing document.
  assert.equal((await call(alice, 'GET', '/elk/indices/eidp-test-none/documents/x')).status, 404)
})

test('an index outside the allowlist is refused, whether or not it exists', async () => {
  for (const index of ['secrets', 'nothing-here']) {
    const res = await call(alice, 'GET', `/elk/indices/${index}/documents/one`)
    assert.equal(res.status, 403)
    assert.equal((await json<Failure>(res)).error.code, 'index_not_allowed')
  }
  const write = await call(alice, 'POST', '/elk/indices/secrets/documents', { document: { a: 1 } })
  assert.equal(write.status, 403)
  assert.equal(fake.indices.get('secrets')!.size, 1)
})

test('wildcards, lists and bad names are refused before the cluster', async () => {
  for (const index of ['eidp-test-*', 'eidp-test-a,secrets', '_all', 'EIDP-TEST-A']) {
    const res = await call(alice, 'POST', `/elk/indices/${encodeURIComponent(index)}/search`, {})
    assert.equal(res.status, 400, index)
    assert.equal((await json<Failure>(res)).error.code, 'invalid_index')
  }
})

test('search: a query string, query DSL, sort and fields', async () => {
  const byWord = await json<{ total: { value: number }; hits: { id: string }[] }>(await call(alice, 'POST', '/elk/indices/eidp-test-apps/search', { q: 'technology:spring' }))
  assert.deepEqual(byWord.hits.map((h) => h.id), ['nfp-backend'])
  assert.equal(byWord.total.value, 1)

  const res = await call(alice, 'POST', '/elk/indices/eidp-test-apps/search', {
    query: { bool: { must_not: [{ term: { environment: 'qa' } }] } },
    sort: [{ name: 'desc' }],
    fields: ['name'],
    size: 1,
  })
  assert.equal(res.status, 200)
  const page = await json<{ index: string; total: { value: number; relation: string }; hits: { id: string; source: unknown }[] }>(res)
  assert.equal(page.index, 'eidp-test-apps')
  assert.deepEqual(page.total, { value: 2, relation: 'eq' })
  assert.deepEqual(page.hits.map((h) => [h.id, h.source]), [['nfp-backend', { name: 'nfp-backend' }]])
})

test('search refuses scripts, oversized pages and unknown keys', async () => {
  const scripted = await call(alice, 'POST', '/elk/indices/eidp-test-apps/search', { query: { bool: { filter: [{ script: { script: { source: 'true' } } }] } } })
  assert.equal(scripted.status, 400)
  assert.equal((await json<Failure>(scripted)).error.code, 'script_not_allowed')

  const sortScript = await call(alice, 'POST', '/elk/indices/eidp-test-apps/search', { sort: [{ _script: { script: 'x', type: 'number' } }] })
  assert.equal((await json<Failure>(sortScript)).error.code, 'script_not_allowed')

  for (const body of [{ size: 101 }, { from: 9_990, size: 20 }, { aggs: {} }, { size: -1 }]) {
    const res = await call(alice, 'POST', '/elk/indices/eidp-test-apps/search', body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal((await json<Failure>(res)).error.code, 'invalid_request')
  }
})

test('a document is added, read back, then replaced by id', async () => {
  const id = `run-${Date.now()}`
  const created = await call(alice, 'POST', '/elk/indices/eidp-test-writes/documents', { id, document: { name: 'first' }, waitForSearch: true })
  assert.equal(created.status, 201)
  assert.deepEqual(await json(created), { index: 'eidp-test-writes', id, result: 'created', version: 1 })

  const replaced = await call(alice, 'POST', '/elk/indices/eidp-test-writes/documents', { id, document: { name: 'second' } })
  assert.equal(replaced.status, 200)
  assert.equal((await json<{ result: string; version: number }>(replaced)).version, 2)

  const read = await json<{ source: unknown }>(await call(alice, 'GET', `/elk/indices/eidp-test-writes/documents/${id}`))
  assert.deepEqual(read.source, { name: 'second' })

  const generated = await call(alice, 'POST', '/elk/indices/eidp-test-writes/documents', { document: { name: 'no id' } })
  assert.equal(generated.status, 201)
  const { id: madeId } = await json<{ id: string }>(generated)
  assert.ok(madeId)
  assert.equal((await call(alice, 'GET', `/elk/indices/eidp-test-writes/documents/${madeId}`)).status, 200)
})

test('a document must be a JSON object', async () => {
  for (const document of [[1, 2], 'text', null]) {
    const res = await call(alice, 'POST', '/elk/indices/eidp-test-writes/documents', { document })
    assert.equal(res.status, 400)
    assert.equal((await json<Failure>(res)).error.code, 'invalid_request')
  }
})

test('the cluster’s refusal comes back with its reason', async () => {
  // The fake refuses nothing a valid body sends, so make it: wrong credentials.
  const { config } = await import('../../lib/config.ts')
  const key = config.ELASTICSEARCH_API_KEY
  ;(config as { ELASTICSEARCH_API_KEY?: string }).ELASTICSEARCH_API_KEY = 'wrong'
  try {
    const res = await call(alice, 'GET', '/elk/indices/eidp-test-apps/documents/agriland-api')
    assert.equal(res.status, 502)
    assert.equal((await json<Failure>(res)).error.code, 'elasticsearch_not_authenticated')
    const status = await json<{ configured: boolean; cluster: unknown; error: string }>(await call(alice, 'GET', '/elk'))
    assert.equal(status.cluster, null)
    assert.match(status.error, /credentials/)
  } finally {
    ;(config as { ELASTICSEARCH_API_KEY?: string }).ELASTICSEARCH_API_KEY = key
  }
})
