// Exercises the real write and read path against Postgres, with the parser's
// own fixtures standing in for a checkout. Needs `docker compose up -d`.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseInventories } from '../../integrations/inventories/parse.ts'
import pg from 'pg'
import { config } from '../../lib/config.ts'
import { closeDb, migrate, query } from '../../lib/db.ts'
import { readCatalog, syncCatalog, writeCatalog } from './service.ts'

const fixtures = fileURLToPath(
  new URL('../../integrations/inventories/__fixtures__/repo', import.meta.url),
)

await migrate()
// The catalog is one set of tables, and this file replaces it wholesale. The
// chatbot's tests read it too, from their own process, so both hold this
// lock while they use it (modules/chatbot/routes.test.ts).
const lock = new pg.Client({ connectionString: config.DATABASE_URL })
await lock.connect()
await lock.query('select pg_advisory_lock(4202)')
await writeCatalog((await parseInventories(fixtures)).systems)
const catalog = await readCatalog()

after(async () => {
  await query('delete from catalog_systems')
  await lock.query('select pg_advisory_unlock(4202)')
  await lock.end()
  await closeDb()
})

test('systems land with their ownership intact', () => {
  const agriland = catalog.find((s) => s.id === 'AgriLand')
  assert.ok(agriland)
  assert.equal(agriland.company, 'eFinance')
  assert.deepEqual(agriland.teams, { dev: 'DEVdotNET', qc: 'QC', stress: 'QC', uat: 'DEVOPS', preprod: 'DEVOPS', prd: 'DEVOPS' })
  assert.deepEqual(catalog.find((s) => s.id === 'NBFS')?.approvers, ['DEVOPS', 'SECURITY'])
})

test('applications are attached to their own system', () => {
  assert.deepEqual(
    catalog.find((s) => s.id === 'AgriLand')?.applications.map((a) => a.name).sort(),
    ['AgriLand-API', 'AgriLand-Mobile'],
  )
})

test('environment variants survive as separate rows under one name', () => {
  const apps = catalog.find((s) => s.id === 'NBFS')?.applications ?? []
  assert.equal(apps.length, 4)
  assert.ok(apps.every((a) => a.name === 'nfp-backend'))
  assert.deepEqual(new Set(apps.map((a) => a.environment)), new Set([null, 'dev', 'prd', 'prd_dr']))
})

test('arrays and booleans round-trip through postgres', async () => {
  const api = catalog
    .find((s) => s.id === 'AgriLand')
    ?.applications.find((a) => a.name === 'AgriLand-API')
  assert.equal(api?.microservice, true)
  assert.deepEqual(api?.technologies, ['dotnet', 'DotNetCore', 'YAJSW'])
})

test('unmodelled cicd fields are kept in the descriptor column', async () => {
  const { rows } = await query<{ descriptor: Record<string, unknown> }>(
    'select descriptor from catalog_applications where id = $1',
    ['AgriLand/AgriLand-API'],
  )
  assert.equal(rows[0]?.descriptor.replicas, 1)
})

test('a rebuild replaces the catalog rather than doubling it', async () => {
  await writeCatalog((await parseInventories(fixtures)).systems)
  const { rows } = await query<{ count: string }>('select count(*) from catalog_applications')
  assert.equal(rows[0]?.count, '6')
})

test('a sync already running is joined, not started twice', async () => {
  // The timer and a Refresh click can overlap; two fetches into one checkout
  // would fight over git's lock. Here INVENTORIES_PROJECT is unset, so the
  // run fails at once without touching the checkout or the database.
  const first = syncCatalog()
  const second = syncCatalog()
  assert.equal(first, second)
  await assert.rejects(first, /INVENTORIES_PROJECT is not set/)
  // Once it has settled, the next call is a fresh run.
  const third = syncCatalog()
  assert.notEqual(third, first)
  await assert.rejects(third)
})
