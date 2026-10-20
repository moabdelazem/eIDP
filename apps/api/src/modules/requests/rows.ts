import type { PipelineFile, RequestRecord, RequestStep } from '@eidp/contracts/requests'
import { asc, eq, inArray } from 'drizzle-orm'
import { db } from '../../lib/db.ts'
import { ApiError } from '../../lib/errors.ts'
import { requests, requestSteps } from './schema.ts'

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

/** A pipeline request's files as a decider edited them — the writer's and the preview's, never the requester's. */
export async function editsOf(id: string): Promise<PipelineFile[]> {
  const [row] = await db.select({ edits: requests.pipelineEdits }).from(requests).where(eq(requests.id, id))
  return row?.edits ?? []
}

export function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export type Row = typeof requests.$inferSelect

/** A row as the API sends it. A decider's file edits go out as paths only: their contents are in the preview, for deciders. */
export function toRecord(row: Row): RequestRecord {
  const { heartbeatAt: _, pipelineEdits, requestedAt, decidedAt, completedAt, ...rest } = row
  return {
    ...rest,
    requestedAt: requestedAt.toISOString(),
    decidedAt: decidedAt?.toISOString() ?? null,
    completedAt: completedAt?.toISOString() ?? null,
    editedFiles: (pipelineEdits ?? []).map((f) => f.path),
    steps: [],
  }
}

/** The order a pipeline's steps run in after its push; `provision` is from requests approved before the portal made branches itself. */
export const STEP_ORDER: string[] = ['provision', 'branches', 'hooks', 'test']

/** The records with what ran in Jenkins after their push — pipelines only; the rest have none. */
export async function withSteps<T extends RequestRecord>(records: T[]): Promise<T[]> {
  const ids = records.filter((r) => r.kind === 'create_pipeline').map((r) => r.id)
  if (ids.length === 0) return records
  const rows = await db.select().from(requestSteps).where(inArray(requestSteps.requestId, ids)).orderBy(asc(requestSteps.requestId))
  const byRequest = new Map<string, RequestStep[]>()
  for (const row of rows) byRequest.set(row.requestId, [...(byRequest.get(row.requestId) ?? []), toStep(row)])
  return records.map((r) => {
    const steps = byRequest.get(r.id)
    return steps ? { ...r, steps: steps.sort((a, b) => STEP_ORDER.indexOf(a.step) - STEP_ORDER.indexOf(b.step)) } : r
  })
}

export function toStep(row: typeof requestSteps.$inferSelect): RequestStep {
  return {
    step: row.step,
    status: row.status,
    job: row.job,
    number: row.number,
    url: row.url,
    note: row.note,
    attempts: row.attempts,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }
}
