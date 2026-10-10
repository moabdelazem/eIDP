// The tables in the schema files (lib/schema.ts, modules/*/schema.ts) are the
// tables the migrations make — checked both ways, not trusted. One scratch
// schema is built by the real migrations, another from what drizzle-kit
// makes of the schema files, and their columns, indexes and constraints must
// be the same. A schema file changed without `pnpm db:generate`, or a
// migration written by hand that the schema files never heard of, fails here.
// Needs the postgres container.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import pg from 'pg'
import { config } from './config.ts'
import { migrateWith } from './db.ts'

const api = fileURLToPath(new URL('../../', import.meta.url))
const run = `${process.pid}_${Date.now()}`
const fromMigrations = `schema_test_m_${run}`
const fromSchema = `schema_test_s_${run}`
const client = new pg.Client({ connectionString: config.DATABASE_URL })

before(async () => {
  await client.connect()
  for (const s of [fromMigrations, fromSchema]) await client.query(`create schema ${s}`)

  await client.query(`set search_path to ${fromMigrations}`)
  await migrateWith(client, fileURLToPath(new URL('./migrations/', import.meta.url)))

  const { stdout } = await promisify(execFile)('node_modules/.bin/drizzle-kit', ['export', '--sql'], { cwd: api })
  await client.query(`set search_path to ${fromSchema}`)
  await client.query(stdout.replaceAll('"public".', ''))
})

after(async () => {
  for (const s of [fromMigrations, fromSchema]) await client.query(`drop schema if exists ${s} cascade`)
  await client.end()
})

/** Everything about the tables that a query or a constraint could notice, schema name taken out. */
async function shape(schema: string) {
  const strip = (s: string) => s.replaceAll(`${schema}.`, '')
  const columns = await client.query(
    `select table_name, column_name, data_type, udt_name, is_nullable, column_default
       from information_schema.columns where table_schema = $1 and table_name <> 'schema_migrations'
      order by 1, 2`,
    [schema],
  )
  const indexes = await client.query(`select indexname, indexdef from pg_indexes where schemaname = $1 and tablename <> 'schema_migrations' order by 1`, [schema])
  const constraints = await client.query(
    `select c.conrelid::regclass::text as tbl, c.conname, pg_get_constraintdef(c.oid) as def
       from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where n.nspname = $1 and c.conrelid::regclass::text not like '%schema_migrations'
      order by 1, 2`,
    [schema],
  )
  return {
    columns: columns.rows.map((r) => ({ ...r, column_default: r.column_default && strip(r.column_default) })),
    indexes: indexes.rows.map((r) => ({ name: r.indexname, def: strip(r.indexdef) })),
    constraints: constraints.rows.map((r) => ({ table: strip(r.tbl), name: r.conname, def: strip(r.def) })),
  }
}

test('the schema files describe exactly the tables the migrations make', async () => {
  const [made, described] = await Promise.all([shape(fromMigrations), shape(fromSchema)])
  assert.ok(made.columns.length > 150, `the migrations made the tables (${made.columns.length} columns)`)
  assert.deepEqual(described.columns, made.columns, 'columns')
  assert.deepEqual(described.indexes, made.indexes, 'indexes')
  assert.deepEqual(described.constraints, made.constraints, 'constraints')
})
