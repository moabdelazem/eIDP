import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { config } from './config.ts'

/**
 * One pool for the process. Queries go through `query`; anything that must be
 * all-or-nothing goes through `transaction`.
 */
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 8 })

pool.on('error', (err) => {
  // An idle client dying is not fatal — the pool replaces it — but silence
  // here turns a database outage into a mystery.
  console.error('postgres pool error', err)
})

export function query<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  return pool.query<T>(text, values)
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Migrations live beside this file, `NNNN_name.sql`, applied in order. */
const MIGRATIONS = fileURLToPath(new URL('./migrations/', import.meta.url))
const NAME = /^\d{4}_[\w-]+\.sql$/

/**
 * Brings the database up to date: every migration not yet applied, in order,
 * each in its own transaction with its row in `schema_migrations`, so a
 * migration that fails leaves nothing half-done and is tried again next boot.
 *
 * Serialised across processes by advisory lock 4201 — two API processes, or
 * the test files running in parallel, must not apply the same file twice.
 * An applied migration is frozen: if its file changes, boot stops and says
 * which, because the database no longer matches what the file claims.
 *
 * Returns the names it applied.
 */
export async function migrate(dir = MIGRATIONS): Promise<string[]> {
  const client = await pool.connect()
  try {
    await client.query('select pg_advisory_lock(4201)')
    return await migrateWith(client, dir)
  } finally {
    await client.query('select pg_advisory_unlock(4201)').catch(() => {})
    client.release()
  }
}

/** The work of `migrate` on a client the caller owns — a test points one at a scratch schema. */
export async function migrateWith(client: pg.ClientBase, dir: string): Promise<string[]> {
  await client.query(`create table if not exists schema_migrations (
    name       text primary key,
    checksum   text not null,
    applied_at timestamptz not null default now()
  )`)
  const done = new Map(
    (await client.query<{ name: string; checksum: string }>('select name, checksum from schema_migrations')).rows.map((r) => [r.name, r.checksum]),
  )
  const files = (await readdir(dir)).filter((f) => NAME.test(f)).sort()
  const applied: string[] = []
  for (const name of files) {
    const sql = await readFile(join(dir, name), 'utf8')
    const checksum = createHash('sha256').update(sql).digest('hex')
    const was = done.get(name)
    if (was !== undefined) {
      if (was !== checksum) throw new Error(`Migration ${name} was changed after it was applied. Put the change in a new migration and restore ${name} as it was.`)
      continue
    }
    try {
      await client.query('begin')
      await client.query(sql)
      await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [name, checksum])
      await client.query('commit')
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw new Error(`Migration ${name} failed: ${err instanceof Error ? err.message : err}`)
    }
    applied.push(name)
  }
  return applied
}

export async function closeDb(): Promise<void> {
  await pool.end()
}
