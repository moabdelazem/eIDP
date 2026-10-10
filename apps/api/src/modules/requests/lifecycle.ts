import type { RequestRecord } from '@eidp/contracts/requests'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { profileOf } from '../../integrations/ldap/index.ts'
import { can, type Access } from '../access/index.ts'
import { db, isUniqueViolation } from '../../lib/db.ts'
import { ApiError } from '../../lib/errors.ts'
import { assess, assessmentsOf, type Assessment } from './risk.ts'
import { check, uniqueNames } from './check.ts'
import { assertCanDecide, decidableBy, mayDecide } from './deciding.ts'
import { execute } from './execute.ts'
import type { Actor, AdoTarget, NewRequest } from './model.ts'
import { find, same, toRecord } from './rows.ts'
import { requests } from './schema.ts'
import { errorFields, log } from '../../lib/log.ts'

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
    const rows = await db
      .insert(requests)
      .values({
        kind: input.kind,
        collection: input.kind === 'create_jira_project' ? null : input.collection,
        project: input.project,
        projectKey: input.kind === 'create_jira_project' ? input.projectKey : null,
        repository: input.kind === 'create_repository' ? input.repository : null,
        description: input.description?.trim() || null,
        justification: input.justification.trim(),
        requestedBy: actor.uid,
        requestedByName: actor.name,
        teamGroup: team,
      })
      .returning()
    return filed(toRecord(rows[0]!))
  } catch (err) {
    // The check passed, but someone filed the same request in the gap. The
    // unique index is what actually decides.
    if (isUniqueViolation(err)) {
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
  const rows = await db
    .insert(requests)
    .values({
      kind: 'grant_access',
      collection: input.collection,
      project: input.project,
      repository: null,
      justification: input.justification.trim(),
      requestedBy: actor.uid,
      requestedByName: actor.name,
      grantees: uniqueNames(input.grantees ?? []),
      accessLevel: 'contribute',
    })
    .returning()
  return filed(toRecord(rows[0]!))
}

/**
 * A request just filed: assessed in the background, so the approver finds
 * the facts and the summary waiting. The filing never waits on it or fails
 * because of it.
 */
function filed(request: RequestRecord): RequestRecord {
  void assess(request).catch((err) => log.error('assessing a request failed', { request: request.id, ...errorFields(err) }))
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
  const rows = await db.select().from(requests).where(eq(requests.requestedBy, uid)).orderBy(desc(requests.requestedAt)).limit(200)
  return rows.map(toRecord)
}

/**
 * Everything still open, then the most recent closed ones for context — or,
 * for someone who may decide only within a scope, just the requests they may
 * decide. A team lead's queue holds their teams' access requests, nothing else.
 */
export async function listPool(access: Access): Promise<{ open: RequestRecord[]; recent: RequestRecord[] }> {
  const [open, recent] = await Promise.all([
    db.select().from(requests).where(inArray(requests.status, ['pending', 'approved', 'failed'])).orderBy(asc(requests.requestedAt)),
    db
      .select()
      .from(requests)
      .where(inArray(requests.status, ['completed', 'rejected', 'cancelled']))
      .orderBy(desc(sql`coalesce(${requests.completedAt}, ${requests.decidedAt}, ${requests.requestedAt})`))
      .limit(30),
  ])
  const all = { open: open.map(toRecord), recent: recent.map(toRecord) }
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
  const rows = await db.select().from(requests).orderBy(desc(requests.requestedAt)).limit(HISTORY_LIMIT)
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
  const rows = await db
    .update(requests)
    .set({ status: 'cancelled', decidedAt: sql`now()`, decidedBy: actor.uid, decidedByName: actor.name })
    .where(and(eq(requests.id, id), eq(requests.requestedBy, actor.uid), eq(requests.status, 'pending')))
    .returning()
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
  const rows = await decide(id, { status: 'approved', decidedBy: actor.uid, decidedByName: actor.name, decisionNote: note?.trim() || null })
  if (!rows[0]) throw new ApiError(409, 'request_not_pending', 'Someone has already decided this request.')

  void execute(toRecord(rows[0]))
  return toRecord(rows[0])
}

export async function reject(id: string, actor: Actor, access: Access, note: string): Promise<RequestRecord> {
  if (!note.trim()) {
    throw new ApiError(400, 'invalid_request', 'Say why, so the person can fix it and ask again.')
  }
  await assertCanDecide(id, access)
  const rows = await decide(id, { status: 'rejected', decidedBy: actor.uid, decidedByName: actor.name, decisionNote: note.trim() })
  if (!rows[0]) throw new ApiError(409, 'request_not_pending', 'Someone has already decided this request.')
  return toRecord(rows[0])
}

/**
 * A pending request decided. The `status = 'pending'` guard is the lock: of
 * two approvers clicking at once, exactly one update matches.
 */
function decide(id: string, decision: { status: 'approved' | 'rejected'; decidedBy: string; decidedByName: string; decisionNote: string | null }) {
  return db
    .update(requests)
    .set({ ...decision, decidedAt: sql`now()` })
    .where(and(eq(requests.id, id), eq(requests.status, 'pending')))
    .returning()
}

/** Tries a failed creation again. The original approval stands. */
export async function retry(id: string, access: Access): Promise<RequestRecord> {
  await assertCanDecide(id, access)
  const rows = await db
    .update(requests)
    .set({ status: 'approved', error: null })
    .where(and(eq(requests.id, id), eq(requests.status, 'failed')))
    .returning()
  if (!rows[0]) throw new ApiError(409, 'request_not_failed', 'Only a failed request can be retried.')
  void execute(toRecord(rows[0]))
  return toRecord(rows[0])
}
