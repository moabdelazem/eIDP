import { readFile } from 'node:fs/promises'
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

/**
 * Applies schema.sql, which is written to be re-runnable.
 *
 * ponytail: no migration tool. Once a column has to change shape rather than
 * appear, this needs real migrations — the file cannot express that.
 */
export async function ensureSchema(): Promise<void> {
  const sql = await readFile(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8')
  await pool.query(sql)
}

export async function closeDb(): Promise<void> {
  await pool.end()
}
