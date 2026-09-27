// Exercises the real write and read path against Postgres, with the parser's
// own fixtures standing in for a checkout. Needs `docker compose up -d`.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseInventories } from '../integrations/inventories/parse.ts'
import { closeDb, ensureSchema, query } from '../lib/db.ts'
import { readCatalog, writeCatalog } from './catalog.ts'

const fixtures = fileURLToPath(
  new URL('../integrations/inventories/__fixtures__/repo', import.meta.url),
)

await ensureSchema()
await writeCatalog(await parseInventories(fixtures))
const catalog = await readCatalog()

after(async () => {
  await query('delete from catalog_systems')
  await closeDb()
})

test('systems land with their ownership intact', () => {
  const agriland = catalog.find((s) => s.id === 'AgriLand')
  assert.ok(agriland)
  assert.equal(agriland.company, 'eFinance')
  assert.deepEqual(agriland.teams, { dev: 'DEVdotNET', qc: 'QC', uat: 'DEVOPS', prd: 'DEVOPS' })
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
  assert.equal(rows[0]?.descriptor.replicas, 2)
})

test('a rebuild replaces the catalog rather than doubling it', async () => {
  await writeCatalog(await parseInventories(fixtures))
  const { rows } = await query<{ count: string }>('select count(*) from catalog_applications')
  assert.equal(rows[0]?.count, '6')
})
