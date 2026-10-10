import type { RequestRecord } from '@eidp/contracts/requests'
import type { DatabaseError } from 'pg'
import { profileOf } from '../../integrations/ldap/index.ts'
import { can, type Access } from '../rbac.ts'
import { query } from '../../lib/db.ts'
import { ApiError } from '../../lib/errors.ts'
import { assess, assessmentsOf, type Assessment } from '../request-risk.ts'
import { check, uniqueNames } from './check.ts'
import { assertCanDecide, decidableBy, mayDecide } from './deciding.ts'
import { execute } from './execute.ts'
import type { Actor, AdoTarget, NewRequest } from './model.ts'
import { type Row, find, same, toRecord } from './rows.ts'

/**
 * A request's life: filed, listed, decided, withdrawn, retried. Rows are never deleted — the row is the history.
 */

export async function submit(input: NewRequest, actor: Actor): Promise<RequestRecord> {
  if (!input.justification.trim()) {
    throw new ApiError(400, 'invalid_request', 'Say why you need it, so DEVOPS can decide.')
  }
  if (input.kind === 'grant_access') return submitGrant(input, actor)
  // Whoever is granted access must be the requester's own team: asked of the
  // directory now, so nobody can hand a repository to a group they are not in.
  if (!input.teamGroup) throw new ApiError(400, 'invalid_request', 'Choose your team.')
  const groups = (await profileOf(actor.uid))?.groups ?? []
  const team = groups.find((group) => same(group, input.teamGroup!))
  if (!team) {
    throw new ApiError(400, 'invalid_request', `You are not a member of ${input.teamGroup}. Choose one of your own groups.`)
  }
  const verdict = await check(input)
  if (!verdict.ok) throw new ApiError(409, 'request_not_possible', verdict.reason)

  try {
    const { rows } = await query<Row>(
      `insert into requests
         (kind, collection, project, project_key, repository, description, justification,
          requested_by, requested_by_name, team_group)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning *`,
      [
        input.kind,
        input.kind === 'create_jira_project' ? null : input.collection,
        input.project,
        input.kind === 'create_jira_project' ? input.projectKey : null,
        input.kind === 'create_repository' ? input.repository : null,
        input.description?.trim() || null,
        input.justification.trim(),
        actor.uid,
        actor.name,
        team,
      ],
    )
    return filed(toRecord(rows[0]!))
  } catch (err) {
    // The check passed, but someone filed the same request in the gap. The
    // unique index is what actually decides.
    if ((err as DatabaseError).code === '23505') {
      throw new ApiError(409, 'request_not_possible', 'Someone has just asked for the same thing.')
    }
    throw err
  }
}

/**
 * An access request is Contribute on the whole project — fixed, not chosen.
 * Rows filed before that was fixed may name a repository or Read, and
 * `executeGrant` still honours them.
 */
async function submitGrant(input: AdoTarget & NewRequest, actor: Actor): Promise<RequestRecord> {
  input = { ...input, repository: undefined, accessLevel: 'contribute' }
  const verdict = await check(input)
  if (!verdict.ok) throw new ApiError(409, 'request_not_possible', verdict.reason)
  const { rows } = await query<Row>(
    `insert into requests
       (kind, collection, project, repository, justification,
        requested_by, requested_by_name, grantees, access_level)
     values ('grant_access', $1, $2, null, $3, $4, $5, $6, 'contribute')
     returning *`,
    [
      input.collection,
      input.project,
      input.justification.trim(),
      actor.uid,
      actor.name,
      uniqueNames(input.grantees ?? []),
    ],
  )
  return filed(toRecord(rows[0]!))
}

/**
 * A request just filed: assessed in the background, so the approver finds
 * the facts and the summary waiting. The filing never waits on it or fails
 * because of it.
 */
function filed(request: RequestRecord): RequestRecord {
  void assess(request).catch((err) => console.error(`assessing request ${request.id} failed:`, err instanceof Error ? err.message : err))
  return request
}

/** The records with their assessments attached — only ever called for people who may decide them. */
async function withAssessments(requests: RequestRecord[]): Promise<RequestRecord[]> {
  const found = await assessmentsOf(requests.map((r) => r.id))
  return requests.map((r) => ({ ...r, assessment: found.get(r.id) ?? null }))
}

/** Assesses a request again — the directory and the catalog may have changed since it was filed. */
export async function reassess(id: string, access: Access): Promise<Assessment> {
  await assertCanDecide(id, access)
  return assess(await find(id))
}

export async function listMine(uid: string): Promise<RequestRecord[]> {
  const { rows } = await query<Row>(
    'select * from requests where requested_by = $1 order by requested_at desc limit 200',
    [uid],
  )
  return rows.map(toRecord)
}

/**
 * Everything still open, then the most recent closed ones for context — or,
 * for someone who may decide only within a scope, just the requests they may
 * decide. A team lead's queue holds their teams' access requests, nothing else.
 */
export async function listPool(access: Access): Promise<{ open: RequestRecord[]; recent: RequestRecord[] }> {
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
  const all = { open: open.rows.map(toRecord), recent: recent.rows.map(toRecord) }
  // Assessments ride on the open ones only: that is where a decision is still to be made.
  if (can(access, 'requests.decide')) return { open: await withAssessments(all.open), recent: all.recent }
  const decidable = await decidableBy(access, [...all.open, ...all.recent])
  return {
    open: await withAssessments(all.open.filter((r) => decidable.has(r.id))),
    recent: all.recent.filter((r) => decidable.has(r.id)),
  }
}

/**
 * Every request `access` may decide, newest first — the approvals history.
 * DevOps see all of them; a team lead, only access requests in their scope.
 *
 * ponytail: the newest `HISTORY_LIMIT`, filtered in the browser. Past that,
 * page it here with the filters as query parameters.
 */
export async function listHistory(access: Access): Promise<RequestRecord[]> {
  const { rows } = await query<Row>('select * from requests order by requested_at desc limit $1', [HISTORY_LIMIT])
  const all = rows.map(toRecord)
  if (can(access, 'requests.decide')) return all
  const decidable = await decidableBy(access, all)
  return all.filter((r) => decidable.has(r.id))
}

export const HISTORY_LIMIT = 1000

/** A request, if this person may see it: their own, or one they may decide — and whether they may. */
export async function get(id: string, actor: Actor, access: Access): Promise<RequestRecord & { canDecide: boolean }> {
  const request = await find(id)
  const canDecide = await mayDecide(request, access)
  if (request.requestedBy !== actor.uid && !canDecide) {
    throw new ApiError(404, 'request_not_found', 'There is no such request.')
  }
  if (!canDecide) return { ...request, canDecide }
  const [withAssessment] = await withAssessments([request])
  return { ...withAssessment!, canDecide }
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
export async function approve(id: string, actor: Actor, access: Access, note?: string): Promise<RequestRecord> {
  await assertCanDecide(id, access)
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

export async function reject(id: string, actor: Actor, access: Access, note: string): Promise<RequestRecord> {
  if (!note.trim()) {
    throw new ApiError(400, 'invalid_request', 'Say why, so the person can fix it and ask again.')
  }
  await assertCanDecide(id, access)
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
export async function retry(id: string, access: Access): Promise<RequestRecord> {
  await assertCanDecide(id, access)
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
