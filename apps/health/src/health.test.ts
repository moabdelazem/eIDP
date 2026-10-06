// The health service end to end: a fake portal answering /internal/health, a
// real TCP listener standing in for a machine's port, a fake node_exporter,
// and real Postgres (shared with the portal's dev data, so every check looks
// for its own rows and the cleanup deletes only what these tests made).
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createFakeExporter } from './fake-exporter.ts'

async function listen(fetch: (req: Request) => Response | Promise<Response>) {
  const server = serve({ fetch, port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

// The portal, as the health service sees it: its dependencies, or nothing at all.
const portalState = { up: true, vault: 'ok' as 'ok' | 'down' }
const portal = await listen(
  new Hono().get('/internal/health', (c) => {
    if (c.req.header('authorization') !== `Bearer ${TOKEN}`) return c.json({ error: { code: 'unauthorised' } }, 401)
    return c.json({ status: 'ok', components: [{ id: 'test-vault', name: 'Test Vault', status: portalState.vault, summary: `Vault is ${portalState.vault}.`, latencyMs: 4 }] })
  }).fetch,
)
const TOKEN = 'test-health-token-0123456789'
const exporter = createFakeExporter()
const metrics = await listen(exporter.app.fetch)

// A port that accepts, and one that refuses (a listener opened then closed).
const open: Server = createServer((socket) => socket.end())
await new Promise<void>((resolve) => open.listen(0, '127.0.0.1', resolve))
const openPort = (open.address() as AddressInfo).port
const closedServer = createServer()
await new Promise<void>((resolve) => closedServer.listen(0, '127.0.0.1', resolve))
const closedPort = (closedServer.address() as AddressInfo).port
await new Promise((resolve) => closedServer.close(resolve))

process.env.HEALTH_TOKEN = TOKEN
process.env.PORTAL_URL = `http://localhost:${portal.port}`
process.env.HEALTH_SAMPLE_MINUTES = '0'
process.env.HEALTH_ALERT_AFTER = '2'
process.env.HEALTH_ALERT_TO = 'devops@example.com'
process.env.MACHINE_TIMEOUT_MS = '800'

const { createApp } = await import('./app.ts')
const { closeDb, ensureSchema, query } = await import('./db.ts')
const { checkMachine } = await import('./machines.ts')
const { sampleOnce } = await import('./sampler.ts')
const app = createApp()

const floors = { samples: 0, alerts: 0, audit: 0 }
const made: string[] = []
const maxId = async (table: string) => Number((await query<{ max: string | null }>(`select max(id) from ${table}`)).rows[0]?.max ?? 0)

before(async () => {
  await ensureSchema()
  ;[floors.samples, floors.alerts, floors.audit] = await Promise.all([maxId('health_samples'), maxId('health_alerts'), maxId('health_machine_audit')])
})

after(async () => {
  if (made.length) await query('delete from health_machines where id = any($1::uuid[])', [made])
  await query('delete from health_samples where id > $1', [floors.samples])
  await query('delete from health_alerts where id > $1', [floors.alerts])
  await query('delete from health_machine_audit where id > $1', [floors.audit])
  await closeDb()
  portal.server.close()
  metrics.server.close()
  open.close()
})

const call = (method: string, path: string, body?: unknown, token = TOKEN) =>
  app.request(path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-eidp-actor': 'alice (Alice Example)' }, body: body === undefined ? undefined : JSON.stringify(body) })

async function json<T = any>(res: Response): Promise<T> {
  assert.ok(res.ok, `${res.status}: ${await res.clone().text()}`)
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

const machine = (over: Record<string, unknown> = {}) => ({ name: `test-box-${made.length}-${Date.now()}`, host: '127.0.0.1', ports: [openPort], group: 'Test machines', notify: ['owner@example.com'], ...over })

test('only the portal, holding the token, reaches /v1; liveness is open', async () => {
  assert.equal((await app.request('/health')).status, 200)
  assert.equal((await call('GET', '/v1/machines', undefined, 'wrong-token-wrong-token')).status, 401)
  assert.equal((await app.request('/v1/machines')).status, 401)
})

test('machines are added, changed and removed, each audited with who and how it was', async () => {
  const added = await json(await call('POST', '/v1/machines', machine()))
  made.push(added.id)
  const changed = await json(await call('PUT', `/v1/machines/${added.id}`, { ...machine({ name: added.name }), environment: 'prd' }))
  assert.equal(changed.environment, 'prd')
  const { rows } = await query<{ action: string; actor: string; previous: any }>('select action, actor, previous from health_machine_audit where id > $1 and machine->>\'id\' = $2 order by id', [floors.audit, added.id])
  assert.deepEqual(rows.map((r) => r.action), ['add', 'update'])
  assert.equal(rows[1]!.actor, 'alice (Alice Example)')
  assert.equal(rows[1]!.previous.environment, null)

  // Nothing to check is refused; a name already taken is a 409, not a 500.
  assert.equal((await call('POST', '/v1/machines', machine({ ports: [] }))).status, 400)
  assert.equal((await call('POST', '/v1/machines', machine({ host: 'not a host!' }))).status, 400)
  assert.equal((await call('POST', '/v1/machines', machine({ name: added.name.toUpperCase() }))).status, 409)

  const gone = await json(await call('POST', '/v1/machines', machine()))
  assert.equal((await call('DELETE', `/v1/machines/${gone.id}`)).status, 204)
  assert.equal((await call('DELETE', `/v1/machines/${gone.id}`)).status, 404)
})

test('a machine answers on its ports and node_exporter: ok, with CPU from the second look', async () => {
  const m = { id: 'probe-1', name: 'probe', host: '127.0.0.1', ports: [openPort], httpUrl: null, exporterUrl: `http://localhost:${metrics.port}/metrics`, group: 'x', environment: null, notify: [], notes: null, enabled: true }
  const first = await checkMachine(m)
  assert.equal(first.status, 'ok', first.summary)
  assert.equal(first.metrics.cores, 4)
  assert.equal(first.metrics.cpu, null, 'busy time needs two looks')
  assert.ok(Math.abs(first.metrics.memory! - 0.42) < 0.01)
  assert.deepEqual({ mount: first.metrics.disk!.mount, used: Math.round(first.metrics.disk!.used * 100) }, { mount: '/', used: 61 }, 'tmpfs is not a disk')
  assert.ok(first.metrics.uptimeSeconds! > 11 * 86400)
  await new Promise((r) => setTimeout(r, 1100))
  const second = await checkMachine(m)
  assert.ok(Math.abs(second.metrics.cpu! - 0.25) < 0.05, `cpu ${second.metrics.cpu}`)

  exporter.state.diskUsed = 0.95
  const full = await checkMachine(m)
  assert.equal(full.status, 'degraded')
  assert.match(full.summary, /\/ 95% full/)
  exporter.state.diskUsed = 0.61
})

test('a closed port makes a machine degraded; nothing answering makes it down, saying why', async () => {
  const base = { id: 'probe-2', name: 'probe', host: '127.0.0.1', httpUrl: null, exporterUrl: null, group: 'x', environment: null, notify: [], notes: null, enabled: true }
  const partial = await checkMachine({ ...base, ports: [openPort, closedPort] })
  assert.equal(partial.status, 'degraded')
  assert.match(partial.summary, new RegExp(`port ${closedPort} closed`, 'i'))
  const down = await checkMachine({ ...base, ports: [closedPort] })
  assert.equal(down.status, 'down')
  assert.match(down.summary, /refused the connection/)
})

test('two bad rounds raise one alert, for the machine’s people and the default list; recovery raises another', async () => {
  const added = await json(await call('POST', '/v1/machines', machine({ ports: [closedPort] })))
  made.push(added.id)
  const component = `machine:${added.id}`
  const alertsFor = async () => (await query<{ kind: string; recipients: string[]; state: string }>('select kind, recipients, state from health_alerts where id > $1 and component = $2 order by id', [floors.alerts, component])).rows

  await sampleOnce()
  assert.equal((await alertsFor()).length, 0, 'one bad sample is a blip')
  await sampleOnce()
  await sampleOnce()
  const [down, ...more] = await alertsFor()
  assert.equal(down?.kind, 'down')
  assert.equal(more.length, 0, 'an open alert is not raised again')
  assert.deepEqual(down?.recipients.sort(), ['devops@example.com', 'owner@example.com'])
  assert.equal(down?.state, 'pending', 'waiting for the mail service')

  await json(await call('PUT', `/v1/machines/${added.id}`, { ...machine({ name: added.name, ports: [openPort] }) }))
  await sampleOnce()
  assert.deepEqual((await alertsFor()).map((a) => a.kind), ['down', 'recovered'])

  const { alerts, pending } = await json(await call('GET', '/v1/alerts'))
  assert.ok(alerts.some((a: any) => a.component === component && a.kind === 'recovered'))
  assert.ok(pending >= 2)
})

test('the portal’s own dependencies are sampled through it; the portal not answering is the portal down', async () => {
  portalState.vault = 'down'
  await sampleOnce()
  await sampleOnce()
  const vault = await query<{ kind: string }>(`select kind from health_alerts where id > $1 and component = 'test-vault'`, [floors.alerts])
  assert.deepEqual(vault.rows.map((r) => r.kind), ['down'])
  portalState.vault = 'ok'

  portal.server.close()
  await new Promise((r) => setTimeout(r, 50))
  const round = await sampleOnce()
  assert.equal(round.portal.ok, false)
  const sample = round.samples.find((s) => s.component === 'portal')!
  assert.equal(sample.status, 'down')
  assert.equal(round.samples.some((s) => s.component === 'test-vault'), false, 'no guess at what it could not ask')
})

test('history names every component, machines included, with its incidents', async () => {
  const body = await json(await call('GET', '/v1/history?days=7'))
  const mine = Object.entries(body.components).filter(([id]) => made.some((m) => id === `machine:${m}`))
  assert.ok(mine.length >= 1)
  assert.equal(body.dates.length, 7)
  assert.ok(body.incidents.some((i: any) => i.component === 'test-vault' && i.name === 'Test Vault'))
  assert.equal(body.components['test-vault'].name, 'Test Vault')
})
