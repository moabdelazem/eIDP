import type { RequestRecord } from '@eidp/contracts/requests'
import { listRepositories } from '../../integrations/ado/index.ts'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../lib/db.ts'
import { ApiError } from '../../lib/errors.ts'
import { same } from './rows.ts'
import { requests } from './schema.ts'

/** Steps every executor shares: finding what a first attempt made, and recording it. */

export async function existingRepository(request: RequestRecord) {
  const repos = await listRepositories(request.collection!, request.project)
  const repo = repos.find((r) => same(r.name, request.repository!))
  if (!repo) throw new ApiError(404, 'ado_repository_missing', `${request.repository} is no longer in ${request.project}.`)
  return repo
}

export function recordCreated(id: string, resultUrl: string) {
  return db.update(requests).set({ resultUrl }).where(eq(requests.id, id))
}

/** The request done: what was made is at `resultUrl`. */
export function recordCompleted(id: string, resultUrl: string) {
  return db.update(requests).set({ status: 'completed', completedAt: sql`now()`, resultUrl, error: null }).where(eq(requests.id, id))
}

/** Says what already happened when a later step fails, so DevOps know a retry only has to grant. */
export async function withContext(context: string, step: () => Promise<void>): Promise<void> {
  try {
    await step()
  } catch (err) {
    throw new Error(`${context}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
