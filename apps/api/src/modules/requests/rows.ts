import type { RequestRecord } from '@eidp/contracts/requests'
import { eq } from 'drizzle-orm'
import { db } from '../../lib/db.ts'
import { ApiError } from '../../lib/errors.ts'
import { requests } from './schema.ts'

/**
 * A request row as stored, and as the API sends it.
 */

export async function find(id: string): Promise<RequestRecord> {
  // A malformed id is simply not found, not a database error.
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, 'request_not_found', 'There is no such request.')
  const [row] = await db.select().from(requests).where(eq(requests.id, id))
  if (!row) throw new ApiError(404, 'request_not_found', 'There is no such request.')
  return toRecord(row)
}

export function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export type Row = typeof requests.$inferSelect

export function toRecord(row: Row): RequestRecord {
  const { heartbeatAt: _, requestedAt, decidedAt, completedAt, ...rest } = row
  return {
    ...rest,
    requestedAt: requestedAt.toISOString(),
    decidedAt: decidedAt?.toISOString() ?? null,
    completedAt: completedAt?.toISOString() ?? null,
  }
}
