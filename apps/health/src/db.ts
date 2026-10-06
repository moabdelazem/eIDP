import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { config } from './config.ts'

/** One pool for the process; the health service asks little of the database. */
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 4 })
pool.on('error', (err) => console.error('postgres pool error', err))

export function query<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  return pool.query<T>(text, values)
}

/**
 * Applies schema.sql — re-runnable, top to bottom, like the portal's — under
 * the same advisory lock the portal uses, so the two never apply at once.
 */
export async function ensureSchema(): Promise<void> {
  const sql = await readFile(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8')
  const client = await pool.connect()
  try {
    await client.query('select pg_advisory_lock(4201)')
    await client.query(sql)
  } finally {
    await client.query('select pg_advisory_unlock(4201)').catch(() => {})
    client.release()
  }
}

export async function closeDb(): Promise<void> {
  await pool.end()
}
