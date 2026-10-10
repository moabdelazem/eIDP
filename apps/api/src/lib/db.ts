import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SQL } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { PgDialect } from 'drizzle-orm/pg-core'
import pg from 'pg'
import { config } from './config.ts'
import { instance } from './instance.ts'
import { gauge } from './metrics.ts'
import { errorFields, log } from './log.ts'

/**
 * One pool for the process, and Drizzle over it (`db`). The app's queries go
 * through `db` — the query builder for reading and writing rows, `sql` for
 * what reads better as SQL, `db.transaction` for anything all-or-nothing.
 * Each module's tables are in its `schema.ts` (docs/platform.md). `query`,
 * plain SQL text, is for the migration runner and for tests setting up rows.
 *
 * Bounded every way a database outage could hang the API: waiting for a
 * connection, and a statement running away. Each connection names its
 * process, so `pg_stat_activity` says which replica a query came from.
 */
const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  connectionTimeoutMillis: 5_000,
  statement_timeout: config.DB_STATEMENT_TIMEOUT_SECONDS * 1000 || undefined,
  application_name: `eidp-api ${instance}`.slice(0, 63),
})

gauge('eidp_db_pool_connections', 'Postgres connections in this process’s pool, by state.', () => [
  { labels: { state: 'total' }, value: pool.totalCount },
  { labels: { state: 'idle' }, value: pool.idleCount },
  { labels: { state: 'waiting' }, value: pool.waitingCount },
])

pool.on('error', (err) => {
  // An idle client dying is not fatal — the pool replaces it — but silence
  // here turns a database outage into a mystery.
  log.error('postgres pool error', errorFields(err))
})

export const db = drizzle({ client: pool })

const dialect = new PgDialect()

/**
 * A query that reads better as SQL than as a builder chain — a union across
 * modules' tables, a window function, a CTE — written with Drizzle's `sql`
 * (values are always parameters; tables and columns may be the schema's
 * objects), and its rows as Postgres' driver types them: timestamps as Dates,
 * names as written. `db.execute` would hand timestamps back as text.
 */
export async function sqlRows<T extends pg.QueryResultRow>(q: SQL): Promise<T[]> {
  const { sql: text, params } = dialect.sqlToQuery(q)
  return (await pool.query<T>(text, params)).rows
}

/** A unique index refused the row — Postgres' 23505, which Drizzle passes on as the error's cause. */
export function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown) => (e as { code?: string } | null)?.code
  return code(err) === '23505' || code((err as { cause?: unknown } | null)?.cause) === '23505'
}

export function query<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  return pool.query<T>(text, values)
}

/** Migrations live beside this file, `NNNN_name.sql`, applied in order. */

/**
 * Applied files corrected since, by the checksums they had: a database that
 * applied the old text takes the new one as applied — and records it — rather
 * than refusing to boot. Only for a fix that changes nothing on a database
 * that already ran the file. Never for a schema change: that is a new file.
 *
 * 0001: an index was created above its table, so a fresh database could not
 * be made at all; one that existed before migrations already had the table.
 */
const CORRECTED: Record<string, string[]> = {
  '0001_baseline.sql': ['4ad961250ad7451edb7a906dc84932dc6bcba0de86776cff0caf239c951b9094'],
}
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
    // A migration may rewrite a large table; the pool's statement limit is for requests.
    await client.query('set statement_timeout = 0')
    await client.query('select pg_advisory_lock(4201)')
    return await migrateWith(client, dir)
  } finally {
    await client.query('select pg_advisory_unlock(4201)').catch(() => {})
    // Back to the pool's limit before another caller gets this connection.
    await client.query('reset statement_timeout').catch(() => {})
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
      if (was === checksum) continue
      if (CORRECTED[name]?.includes(was)) {
        await client.query('update schema_migrations set checksum = $2 where name = $1', [name, checksum])
        continue
      }
      throw new Error(`Migration ${name} was changed after it was applied. Put the change in a new migration and restore ${name} as it was.`)
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

/** Whether Postgres answers, within `ms` — what readiness asks. */
export async function pingDb(ms = 2_000): Promise<boolean> {
  try {
    await Promise.race([pool.query('select 1'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref())])
    return true
  } catch {
    return false
  }
}

export async function closeDb(): Promise<void> {
  await pool.end()
}
