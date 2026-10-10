// Migrations (lib/db.ts). The real ones are applied over rows of every kind
// the portal writes, twice; the runner itself is driven against a scratch
// schema with scratch files, so its rules are tested without touching the
// portal's tables. Needs the postgres container.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import pg from 'pg'
import { config } from './config.ts'
import { closeDb, migrate, migrateWith, query } from './db.ts'

const made: { requests: string[]; audit: string[] } = { requests: [], audit: [] }
const scratch = `migrate_test_${process.pid}_${Date.now()}`
const client = new pg.Client({ connectionString: config.DATABASE_URL })
let dir = ''

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eidp-migrations-'))
  await client.connect()
  await client.query(`create schema ${scratch}`)
  await client.query(`set search_path to ${scratch}`)
})

after(async () => {
  if (made.requests.length) await query('delete from requests where id = any($1::uuid[])', [made.requests])
  if (made.audit.length) await query('delete from rbac_audit where id = any($1::bigint[])', [made.audit])
  await client.query(`drop schema ${scratch} cascade`)
  await client.end()
  await rm(dir, { recursive: true, force: true })
  await closeDb()
})

const file = (name: string, sql: string) => writeFile(join(dir, name), sql)
const recorded = async () => (await client.query<{ name: string }>('select name from schema_migrations order by name')).rows.map((r) => r.name)

test('the portal’s migrations apply once, over rows of the newest kinds', async () => {
  await migrate()
  // The kinds a narrower constraint once refused to boot over.
  const jira = await query<{ id: string }>(
    `insert into requests (kind, project, project_key, justification, requested_by, requested_by_name)
     values ('create_jira_project', $1, $2, 'migrate test', 'migrate-test', 'Migrate test') returning id`,
    [`Migrate Test ${Date.now()}`, `MT${Date.now() % 100000}`],
  )
  made.requests.push(jira.rows[0]!.id)
  const update = await query<{ id: string }>(
    `insert into rbac_audit (actor, action, binding, previous) values ('migrate-test', 'update', '{}'::jsonb, '{}'::jsonb) returning id`,
  )
  made.audit.push(update.rows[0]!.id)

  assert.deepEqual(await migrate(), [], 'nothing left to apply')
  const { rows } = await query<{ name: string }>('select name from schema_migrations order by name')
  assert.ok(rows.some((r) => r.name === '0001_baseline.sql'))
})

test('the portal’s migrations build an empty database from nothing', async () => {
  // A database that existed before migrations hid an index made above its
  // table: every fresh install failed. This one starts with nothing.
  const fresh = `${scratch}_fresh`
  const own = new pg.Client({ connectionString: config.DATABASE_URL })
  await own.connect()
  try {
    await own.query(`create schema ${fresh}`)
    await own.query(`set search_path to ${fresh}`)
    const applied = await migrateWith(own, fileURLToPath(new URL('./migrations/', import.meta.url)))
    assert.equal(applied[0], '0001_baseline.sql')
    const { rows } = await own.query<{ n: number }>('select count(*)::int as n from pg_tables where schemaname = $1', [fresh])
    assert.ok(rows[0]!.n > 20, `${rows[0]!.n} tables`)
  } finally {
    await own.query(`drop schema if exists ${fresh} cascade`)
    await own.end()
  }
})

test('files apply in order, once each, and a new one alone next time', async () => {
  await file('0002_second.sql', 'alter table things add column size int;')
  await file('0001_first.sql', 'create table things (id int primary key);')
  await file('notes.md', 'not a migration')
  assert.deepEqual(await migrateWith(client, dir), ['0001_first.sql', '0002_second.sql'])
  assert.deepEqual(await migrateWith(client, dir), [])

  await file('0003_third.sql', 'insert into things (id, size) values (1, 2);')
  assert.deepEqual(await migrateWith(client, dir), ['0003_third.sql'])
  assert.deepEqual(await recorded(), ['0001_first.sql', '0002_second.sql', '0003_third.sql'])
})

test('a failing migration leaves nothing behind, and is tried again once fixed', async () => {
  await file('0004_broken.sql', 'create table half (id int); select no_such_function();')
  await assert.rejects(migrateWith(client, dir), /Migration 0004_broken\.sql failed/)
  assert.equal((await client.query(`select to_regclass('half') as t`)).rows[0].t, null, 'its first statement rolled back')
  assert.ok(!(await recorded()).includes('0004_broken.sql'))

  await file('0004_broken.sql', 'create table half (id int);')
  assert.deepEqual(await migrateWith(client, dir), ['0004_broken.sql'])
})

test('an applied migration that was edited stops the boot and says which', async () => {
  await file('0001_first.sql', 'create table things (id bigint primary key);')
  await assert.rejects(migrateWith(client, dir), /0001_first\.sql was changed after it was applied/)
})
