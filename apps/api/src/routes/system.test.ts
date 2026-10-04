// The health page's API end to end: real Postgres and LDAP, and fakes for
// every integration — Vault included, loaded at boot as the API loads it.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { serve } from '@hono/node-server'
import type { Hono } from 'hono'
import { createFakeAdo } from '../integrations/ado/fake-server.ts'
import { createFakeJenkins } from '../integrations/jenkins/fake-server.ts'
import { createFakeJira } from '../integrations/jira/fake-server.ts'
import { createFakeOllama } from '../integrations/ollama/fake-server.ts'
import { createFakeVault } from '../integrations/vault/fake-server.ts'

const servers: { close: () => void }[] = []
async function start(app: Hono) {
  const server = serve({ fetch: app.fetch, port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  servers.push(server)
  return `http://localhost:${(server.address() as AddressInfo).port}`
}

const vault = createFakeVault({ secrets: { 'eidp/api': { LDAP_BIND_PASSWORD: 'admin', JIRA_TOKEN: 'fake' } } })
const jenkins = createFakeJenkins()
// A server without the configured model pulled: the check must say so.
const ollama = createFakeOllama({ models: ['llama3:latest'] })

process.env.VAULT_ADDR = await start(vault.app)
process.env.VAULT_TOKEN = 'dev-root'
process.env.VAULT_SECRET_PATHS = 'eidp/api'
process.env.ADO_BASE_URL = `${await start(createFakeAdo().app)}/tfs/DefaultCollection`
process.env.ADO_PAT = 'fake'
process.env.JIRA_BASE_URL = `${await start(createFakeJira().app)}/jira`
process.env.JIRA_TOKEN = 'fake'
const jenkinsUrl = `${await start(jenkins.app)}/jenkins`
process.env.JENKINS_URL = jenkinsUrl
process.env.JENKINS_USER = 'eidp'
process.env.JENKINS_TOKEN = 'fake'
process.env.OLLAMA_URL = await start(ollama.app)
process.env.OLLAMA_MODEL = 'qwen2.5'
delete process.env.INVENTORIES_PROJECT

// As src/index.ts does: secrets first, then everything that reads config.
const { loadSecrets } = await import('../integrations/vault/index.ts')
assert.equal((await loadSecrets()).source, 'vault')
const { createApp } = await import('../app.ts')
const { closeDb, ensureSchema, query } = await import('../lib/db.ts')
const app = createApp()
let alice = ''
/** Health samples before these tests; only rows after it are theirs to delete. */
let sampleFloor = 0

const forget = () =>
  Promise.all(
    ['jenkins_builds', 'jenkins_jobs', 'jenkins_sync', 'jenkins_job_access', 'jenkins_access_sync'].map((t) =>
      query(`delete from ${t} where server = $1`, [jenkinsUrl]),
    ),
  )

before(async () => {
  await ensureSchema()
  await forget()
  sampleFloor = Number((await query<{ max: string | null }>('select max(id) from health_samples')).rows[0]?.max ?? 0)
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'alicepw' }),
  })
  alice = ((await res.json()) as { token: string }).token
})

after(async () => {
  await forget()
  await query('delete from health_samples where id > $1', [sampleFloor])
  await closeDb()
  for (const s of servers) s.close()
})

type Health = { status: string; components: { id: string; group: string; status: string; summary: string; facts: { label: string; value: string }[] }[] }

async function health(): Promise<Health> {
  const res = await app.request('/system/health?fresh=1', { headers: { authorization: `Bearer ${alice}` } })
  assert.equal(res.status, 200, await res.clone().text())
  return (await res.json()) as Health
}
const component = (h: Health, id: string) => h.components.find((c) => c.id === id)!
const fact = (h: Health, id: string, label: string) => component(h, id).facts.find((f) => f.label === label)?.value

test('every component is checked, and each says what it is', async () => {
  const h = await health()
  assert.deepEqual(
    h.components.map((c) => c.id),
    ['postgres', 'directory', 'vault', 'ado', 'jira', 'jenkins', 'ollama', 'catalog', 'jenkins-history', 'jenkins-access'],
  )
  assert.equal(component(h, 'postgres').status, 'ok')
  assert.equal(component(h, 'directory').status, 'ok')
  assert.equal(fact(h, 'directory', 'Product'), 'OpenLDAP')
  assert.equal(component(h, 'vault').status, 'ok')
  assert.match(component(h, 'vault').summary, /2 keys/)
  assert.equal(fact(h, 'vault', 'Loaded at boot from'), 'Vault, 2 settings')
  assert.equal(component(h, 'ado').status, 'ok')
  assert.equal(component(h, 'jira').status, 'ok')
  assert.equal(component(h, 'jenkins').status, 'ok')
  assert.equal(fact(h, 'jenkins', 'Version'), '2.462.3')
  // Not configured is off, not down.
  assert.equal(component(h, 'catalog').status, 'off')
  // Nothing secret leaves: no token, password or full URL with credentials.
  const text = JSON.stringify(h)
  for (const secret of ['dev-root', 'admin', 'fake']) assert.ok(!text.includes(`"${secret}"`), `${secret} must not appear`)
})

test('a model nobody pulled is a warning that says the command', async () => {
  const h = await health()
  assert.equal(component(h, 'ollama').status, 'degraded')
  assert.match(component(h, 'ollama').summary, /ollama pull qwen2\.5/)
  assert.equal(h.status, 'degraded')
})

test('Jenkins history is a warning until it is read, and current after', async () => {
  assert.equal(component(await health(), 'jenkins-history').status, 'degraded')
  const synced = await app.request('/jenkins/sync', { method: 'POST', headers: { authorization: `Bearer ${alice}` } })
  assert.equal(synced.status, 200)
  const h = await health()
  assert.equal(component(h, 'jenkins-history').status, 'ok')
  assert.match(fact(h, 'jenkins-history', 'Last run read')!, /builds? from \d+ jobs?/)
})

test('a sealed Vault is a warning, not an outage: the running API keeps what it loaded', async () => {
  vault.seal()
  try {
    const h = await health()
    assert.equal(component(h, 'vault').status, 'degraded')
    assert.match(component(h, 'vault').summary, /sealed/)
    assert.notEqual(h.status, 'down')
  } finally {
    vault.seal(false)
  }
  assert.equal(component(await health(), 'vault').status, 'ok')
})

test('answers are shared for a few seconds unless asked fresh', async () => {
  const headers = { authorization: `Bearer ${alice}` }
  const first = await (await app.request('/system/health', { headers })).json()
  const second = await (await app.request('/system/health', { headers })).json()
  assert.equal(first.checkedAt, second.checkedAt)
})

test('a sample keeps every component, and history draws days, uptime and incidents from samples', async () => {
  const { recordSample } = await import('../services/health.ts')
  const now = await recordSample()
  const kept = await query<{ n: string }>('select count(*) as n from health_samples where id > $1 and at = $2', [sampleFloor, now.checkedAt])
  assert.equal(Number(kept.rows[0]!.n), now.components.length)

  // Ollama's own story: down two days ago, then fine; a warning now and still going.
  const day = 86_400_000
  const at = (ms: number) => new Date(Date.now() - ms).toISOString()
  const rows: [string, string, string][] = [
    [at(2 * day + 30 * 60_000), 'ok', 'fine'],
    [at(2 * day + 25 * 60_000), 'down', 'test: unreachable at night'],
    [at(2 * day + 20 * 60_000), 'down', 'test: still unreachable'],
    [at(2 * day + 15 * 60_000), 'ok', 'fine again'],
    [at(10 * 60_000), 'degraded', 'test: model missing'],
    [at(5 * 60_000), 'degraded', 'test: model missing'],
  ]
  for (const [when, status, summary] of rows) {
    await query(`insert into health_samples (at, component, status, latency_ms, summary) values ($1, 'ollama', $2, 12, $3)`, [when, status, summary])
  }

  const res = await app.request('/system/history?days=7', { headers: { authorization: `Bearer ${alice}` } })
  assert.equal(res.status, 200)
  const h = (await res.json()) as any
  assert.equal(h.days, 7)
  assert.equal(h.dates.length, 7)
  const ollama = h.components.ollama
  assert.equal(ollama.days.length, 7)
  const twoDaysAgo = rows[1]![0].slice(0, 10)
  assert.equal(ollama.days.find((d: any) => d.day === twoDaysAgo).worst, 'down')
  assert.ok(ollama.uptime > 0 && ollama.uptime < 1)
  assert.ok(ollama.latency.length > 0)

  // Incidents come from the samples; the API's own sampler may be writing
  // beside these tests, so their rules are checked on rows of their own below.
  assert.ok(Array.isArray(h.incidents))
})

test('an incident is a run of checks not ok, closed by the next ok one, open while it lasts', async () => {
  const { incidentsOf } = await import('../services/health.ts')
  const t = (min: number) => new Date(Date.UTC(2026, 9, 1, 12, min))
  const rows = [
    { component: 'ollama', at: t(0), status: 'ok' as const, summary: 'fine' },
    { component: 'ollama', at: t(5), status: 'degraded' as const, summary: 'model missing' },
    { component: 'ollama', at: t(10), status: 'down' as const, summary: 'unreachable' },
    { component: 'ollama', at: t(15), status: 'ok' as const, summary: 'fine' },
    { component: 'vault', at: t(0), status: 'off' as const, summary: 'not configured' },
    { component: 'vault', at: t(20), status: 'degraded' as const, summary: 'sealed' },
  ]
  const [vault, ollama, ...rest] = incidentsOf(rows)
  assert.equal(rest.length, 0, 'off is not an incident')
  // Newest first; the worst it got; from its first bad check to the next good one.
  assert.deepEqual(ollama, { component: 'ollama', name: 'Ollama', status: 'down', from: t(5).toISOString(), to: t(15).toISOString(), summary: 'model missing' })
  assert.deepEqual(vault, { component: 'vault', name: 'Secrets (Vault)', status: 'degraded', from: t(20).toISOString(), to: null, summary: 'sealed' })
})
