import type { AccessLevel, RequestKind, RequestRecord, RequestStatus } from '@eidp/contracts/requests'
import { query } from '../../lib/db.ts'
import { ApiError } from '../../lib/errors.ts'

/**
 * A request row as stored, and as the API sends it.
 */

export async function find(id: string): Promise<RequestRecord> {
  // A malformed id is simply not found, not a database error.
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, 'request_not_found', 'There is no such request.')
  const { rows } = await query<Row>('select * from requests where id = $1', [id])
  if (!rows[0]) throw new ApiError(404, 'request_not_found', 'There is no such request.')
  return toRecord(rows[0])
}

export function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export type Row = {
  id: string
  kind: RequestKind
  status: RequestStatus
  collection: string | null
  project: string
  project_key: string | null
  repository: string | null
  description: string | null
  justification: string
  team_group: string | null
  grantees: string[] | null
  access_level: AccessLevel | null
  requested_by: string
  requested_by_name: string
  requested_at: Date
  decided_by: string | null
  decided_by_name: string | null
  decided_at: Date | null
  decision_note: string | null
  completed_at: Date | null
  result_url: string | null
  error: string | null
}

export function toRecord(row: Row): RequestRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    collection: row.collection,
    project: row.project,
    projectKey: row.project_key,
    repository: row.repository,
    description: row.description,
    justification: row.justification,
    teamGroup: row.team_group,
    grantees: row.grantees,
    accessLevel: row.access_level,
    requestedBy: row.requested_by,
    requestedByName: row.requested_by_name,
    requestedAt: row.requested_at.toISOString(),
    decidedBy: row.decided_by,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionNote: row.decision_note,
    completedAt: row.completed_at?.toISOString() ?? null,
    resultUrl: row.result_url,
    error: row.error,
  }
}
