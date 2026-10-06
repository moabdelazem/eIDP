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

// The health service, as the portal sees it: what it was asked, by whom, with which token.
const HEALTH_TOKEN = 'portal-test-health-token-0123'
const asked: { method: string; path: string; auth: string | null; actor: string | null; body: unknown }[] = []
const { Hono: HonoApp } = await import('hono')
const fakeHealth = new HonoApp()
  .get('/health', (c) => c.json({ ok: true, lastRound: { at: new Date().toISOString(), ok: true }, sampleMinutes: 5 }))
  .all('/v1/*', async (c) => {
    const body = c.req.method === 'GET' || c.req.method === 'DELETE' ? undefined : await c.req.json()
    asked.push({ method: c.req.method, path: c.req.path + (new URL(c.req.url).search || ''), auth: c.req.header('authorization') ?? null, actor: c.req.header('x-eidp-actor') ?? null, body })
    if (c.req.path === '/v1/machines' && c.req.method === 'POST' && (body as { name?: string }).name === 'taken') {
      return c.json({ error: { code: 'machine_exists', message: 'A machine by that name already exists.' } }, 409)
    }
    if (c.req.path === '/v1/history') return c.json({ days: 7, dates: [], components: {}, incidents: [], since: null, sampleMinutes: 5 })
    if (c.req.method === 'POST') return c.json({ id: '00000000-0000-4000-8000-000000000001', ...(body as object) }, 201)
    return c.json([])
  })
const healthUrl = await start(fakeHealth as unknown as Hono)
process.env.HEALTH_SERVICE_URL = healthUrl
process.env.HEALTH_TOKEN = HEALTH_TOKEN

// As src/index.ts does: secrets first, then everything that reads config.
const { loadSecrets } = await import('../integrations/vault/index.ts')
assert.equal((await loadSecrets()).source, 'vault')
const { createApp } = await import('../app.ts')
const { closeDb, ensureSchema, query } = await import('../lib/db.ts')
const app = createApp()
let alice = ''

const forget = () =>
  Promise.all(
    ['jenkins_builds', 'jenkins_jobs', 'jenkins_sync', 'jenkins_job_access', 'jenkins_access_sync'].map((t) =>
      query(`delete from ${t} where server = $1`, [jenkinsUrl]),
    ),
  )

before(async () => {
  await ensureSchema()
  await forget()
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
    ['postgres', 'directory', 'vault', 'ado', 'jira', 'jenkins', 'ollama', 'catalog', 'jenkins-history', 'jenkins-access', 'health-service'],
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

test('the health service reads the portal’s dependencies with the shared token, and nobody else does', async () => {
  const get = (auth?: string) => app.request('/internal/health?fresh=1', { headers: auth ? { authorization: auth } : {} })
  assert.equal((await get()).status, 401)
  assert.equal((await get(`Bearer ${alice}`)).status, 401, 'a person’s session is not the token')
  assert.equal((await get('Bearer not-the-token-not-the-token')).status, 401)
  const res = await get(`Bearer ${HEALTH_TOKEN}`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as Health
  assert.ok(body.components.some((c) => c.id === 'postgres'))
  // The health service, from the portal's side: answering, its last round recent.
  assert.equal(body.components.find((c) => c.id === 'health-service')?.status, 'ok')
})

test('history, machines and alerts are asked of the health service, with the token and who asked', async () => {
  const headers = { authorization: `Bearer ${alice}`, 'content-type': 'application/json' }
  asked.length = 0
  const history = await app.request('/system/history?days=7', { headers })
  assert.equal(history.status, 200)
  assert.equal(((await history.json()) as { days: number }).days, 7)

  const added = await app.request('/system/machines', { method: 'POST', headers, body: JSON.stringify({ name: 'jenkins-agent-01', host: 'agent01.example', ports: [22] }) })
  assert.equal(added.status, 201)
  const post = asked.find((a) => a.method === 'POST' && a.path === '/v1/machines')!
  assert.equal(post.auth, `Bearer ${HEALTH_TOKEN}`)
  assert.equal(post.actor, 'alice (Alice Example)')
  assert.deepEqual(post.body, { name: 'jenkins-agent-01', host: 'agent01.example', ports: [22] })
  assert.equal(asked.find((a) => a.path === '/v1/history?days=7')?.auth, `Bearer ${HEALTH_TOKEN}`)

  // Its refusals come through as the portal's own.
  const taken = await app.request('/system/machines', { method: 'POST', headers, body: JSON.stringify({ name: 'taken', host: 'x', ports: [22] }) })
  assert.equal(taken.status, 409)
  assert.equal(((await taken.json()) as { error: { code: string } }).error.code, 'machine_exists')
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
