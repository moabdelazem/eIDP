import type { DatabaseError } from 'pg'
import {
  createProject,
  createRepository,
  listProjects,
  listRepositories,
  webUrlFor,
} from '../integrations/ado/index.ts'
import { isApprover } from '../integrations/ldap/index.ts'
import { query } from '../lib/db.ts'
import { ApiError } from '../lib/errors.ts'
import { nameProblem } from './request-rules.ts'

export type RequestKind = 'create_repository' | 'create_project'
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'completed' | 'failed' | 'cancelled'

export type Actor = { uid: string; name: string }

export type RequestRecord = {
  id: string
  kind: RequestKind
  status: RequestStatus
  collection: string
  project: string
  repository: string | null
  description: string | null
  justification: string
  requestedBy: string
  requestedByName: string
  requestedAt: string
  decidedBy: string | null
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
  completedAt: string | null
  resultUrl: string | null
  error: string | null
}

export type NewRequest = {
  kind: RequestKind
  collection: string
  project: string
  repository?: string
  description?: string
  justification: string
}

export type Check = { ok: true } | { ok: false; reason: string }

/**
 * Whether a request could be filed as it stands: the name is one ADO accepts,
 * the target does not exist yet, and nobody has already asked for it. The form
 * calls this as someone types, and `submit` runs the same thing, so the answer
 * on screen is the answer on submit.
 */
export async function check(input: Omit<NewRequest, 'justification'>): Promise<Check> {
  const creatingRepo = input.kind === 'create_repository'
  const name = creatingRepo ? (input.repository ?? '') : input.project
  const problem = nameProblem(name, creatingRepo ? 'repository' : 'project')
  if (problem) return { ok: false, reason: problem }

  const projects = await listProjects(input.collection)
  const existingProject = projects.find((p) => same(p.name, input.project))

  if (creatingRepo) {
    if (!existingProject) {
      return { ok: false, reason: `There is no project ${input.project} in ${input.collection}.` }
    }
    const repos = await listRepositories(input.collection, existingProject.name)
    if (repos.some((r) => same(r.name, name))) {
      return { ok: false, reason: `${existingProject.name} already has a repository called ${name}.` }
    }
  } else if (existingProject) {
    return { ok: false, reason: `${input.collection} already has a project called ${existingProject.name}.` }
  }

  const { rows } = await query<{ requested_by_name: string }>(
    `select requested_by_name from requests
      where kind = $1 and lower(collection) = lower($2) and lower(project) = lower($3)
        and lower(coalesce(repository, '')) = lower(coalesce($4, ''))
        and status in ('pending', 'approved')`,
    [input.kind, input.collection, input.project, input.repository ?? null],
  )
  if (rows[0]) {
    return { ok: false, reason: `${rows[0].requested_by_name} has already asked for this; it is waiting on approval.` }
  }

  return { ok: true }
}

export async function submit(input: NewRequest, actor: Actor): Promise<RequestRecord> {
  if (!input.justification.trim()) {
    throw new ApiError(400, 'invalid_request', 'Say why you need it, so DEVOPS can decide.')
  }
  const verdict = await check(input)
  if (!verdict.ok) throw new ApiError(409, 'request_not_possible', verdict.reason)

  try {
    const { rows } = await query<Row>(
      `insert into requests
         (kind, collection, project, repository, description, justification,
          requested_by, requested_by_name)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning *`,
      [
        input.kind,
        input.collection,
        input.project,
        input.kind === 'create_repository' ? input.repository : null,
        input.description?.trim() || null,
        input.justification.trim(),
        actor.uid,
        actor.name,
      ],
    )
    return toRecord(rows[0]!)
  } catch (err) {
    // The check passed, but someone filed the same request in the gap. The
    // unique index is what actually decides.
    if ((err as DatabaseError).code === '23505') {
      throw new ApiError(409, 'request_not_possible', 'Someone has just asked for the same thing.')
    }
    throw err
  }
}

export async function listMine(uid: string): Promise<RequestRecord[]> {
  const { rows } = await query<Row>(
    'select * from requests where requested_by = $1 order by requested_at desc limit 200',
    [uid],
  )
  return rows.map(toRecord)
}

/** Everything still open, then the most recent closed ones for context. */
export async function listPool(): Promise<{ open: RequestRecord[]; recent: RequestRecord[] }> {
  const [open, recent] = await Promise.all([
    query<Row>(
      `select * from requests where status in ('pending', 'approved', 'failed')
        order by requested_at asc`,
    ),
    query<Row>(
      `select * from requests where status in ('completed', 'rejected', 'cancelled')
        order by coalesce(completed_at, decided_at, requested_at) desc limit 30`,
    ),
  ])
  return { open: open.rows.map(toRecord), recent: recent.rows.map(toRecord) }
}

/** A request, if this person may see it: their own, or any of them for DEVOPS. */
export async function get(id: string, actor: Actor): Promise<RequestRecord> {
  const request = await find(id)
  if (request.requestedBy !== actor.uid && !(await isApprover(actor.uid))) {
    throw new ApiError(404, 'request_not_found', 'There is no such request.')
  }
  return request
}

export async function cancel(id: string, actor: Actor): Promise<RequestRecord> {
  const { rows } = await query<Row>(
    `update requests set status = 'cancelled', decided_at = now(),
            decided_by = $2, decided_by_name = $3
      where id = $1 and requested_by = $2 and status = 'pending'
      returning *`,
    [id, actor.uid, actor.name],
  )
  if (rows[0]) return toRecord(rows[0])
  await find(id) // 404 when it does not exist
  throw new ApiError(409, 'request_not_pending', 'Only your own waiting requests can be withdrawn.')
}

/**
 * Approves and starts creating.
 *
 * Returns as soon as the request is claimed; the creation carries on in the
 * background and the request records how it ended. A project can take a
 * minute in ADO, and an approver should not sit on a spinner for it.
 */
export async function approve(id: string, actor: Actor, note?: string): Promise<RequestRecord> {
  await assertCanDecide(id, actor)
  // The `status = 'pending'` guard is the lock: of two approvers clicking at
  // once, exactly one update matches, so ADO is asked once.
  const { rows } = await query<Row>(
    `update requests set status = 'approved', decided_by = $2, decided_by_name = $3,
            decided_at = now(), decision_note = $4
      where id = $1 and status = 'pending'
      returning *`,
    [id, actor.uid, actor.name, note?.trim() || null],
  )
  if (!rows[0]) throw new ApiError(409, 'request_not_pending', 'Someone has already decided this request.')

  void execute(toRecord(rows[0]))
  return toRecord(rows[0])
}

export async function reject(id: string, actor: Actor, note: string): Promise<RequestRecord> {
  if (!note.trim()) {
    throw new ApiError(400, 'invalid_request', 'Say why, so the person can fix it and ask again.')
  }
  await assertCanDecide(id, actor)
  const { rows } = await query<Row>(
    `update requests set status = 'rejected', decided_by = $2, decided_by_name = $3,
            decided_at = now(), decision_note = $4
      where id = $1 and status = 'pending'
      returning *`,
    [id, actor.uid, actor.name, note.trim()],
  )
  if (!rows[0]) throw new ApiError(409, 'request_not_pending', 'Someone has already decided this request.')
  return toRecord(rows[0])
}

/** Tries a failed creation again. The original approval stands. */
export async function retry(id: string, actor: Actor): Promise<RequestRecord> {
  if (!(await isApprover(actor.uid))) {
    throw new ApiError(403, 'not_an_approver', 'Only DEVOPS can retry a request.')
  }
  const { rows } = await query<Row>(
    `update requests set status = 'approved', error = null
      where id = $1 and status = 'failed'
      returning *`,
    [id],
  )
  if (!rows[0]) throw new ApiError(409, 'request_not_failed', 'Only a failed request can be retried.')
  void execute(toRecord(rows[0]))
  return toRecord(rows[0])
}

/**
 * Anything left `approved` when the process starts was interrupted mid-way —
 * a single process has nothing else in flight. Mark it failed so DEVOPS sees
 * it and can retry, rather than it waiting forever.
 *
 * ponytail: assumes one API process. With several, this would fail another
 * instance's live work; that needs a lease column and a heartbeat.
 */
export async function recoverInterrupted(): Promise<number> {
  const { rowCount } = await query(
    `update requests set status = 'failed',
            error = 'The portal restarted before this finished. Retry to try again.'
      where status = 'approved'`,
  )
  return rowCount ?? 0
}

async function execute(request: RequestRecord): Promise<void> {
  try {
    let resultUrl: string
    if (request.kind === 'create_repository') {
      const repo = await createRepository(request.collection, request.project, request.repository!)
      resultUrl = repo.webUrl ?? webUrlFor(request.collection, request.project, repo.name)
    } else {
      const project = await createProject(request.collection, request.project, request.description ?? '')
      resultUrl = webUrlFor(request.collection, project.name)
    }
    await query(
      `update requests set status = 'completed', completed_at = now(), result_url = $2, error = null
        where id = $1`,
      [request.id, resultUrl],
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`request ${request.id} failed:`, message)
    await query(`update requests set status = 'failed', error = $2 where id = $1`, [request.id, message])
  }
}

async function assertCanDecide(id: string, actor: Actor): Promise<void> {
  if (!(await isApprover(actor.uid))) {
    throw new ApiError(403, 'not_an_approver', 'Only DEVOPS can approve or reject requests.')
  }
  const request = await find(id)
  // Separation of duties: a DEVOPS member's own request needs a second pair of
  // eyes, or "approval" means nothing for exactly the people who can grant it.
  if (request.requestedBy === actor.uid) {
    throw new ApiError(403, 'own_request', 'Someone else in DEVOPS has to decide your own request.')
  }
}

async function find(id: string): Promise<RequestRecord> {
  // A malformed id is simply not found, not a database error.
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, 'request_not_found', 'There is no such request.')
  const { rows } = await query<Row>('select * from requests where id = $1', [id])
  if (!rows[0]) throw new ApiError(404, 'request_not_found', 'There is no such request.')
  return toRecord(rows[0])
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

type Row = {
  id: string
  kind: RequestKind
  status: RequestStatus
  collection: string
  project: string
  repository: string | null
  description: string | null
  justification: string
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

function toRecord(row: Row): RequestRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    collection: row.collection,
    project: row.project,
    repository: row.repository,
    description: row.description,
    justification: row.justification,
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
