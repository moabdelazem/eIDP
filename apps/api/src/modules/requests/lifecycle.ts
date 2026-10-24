import type { FiledWith, PipelinePreview, ProjectRequest, RequestRecord, RequestStep, StepName } from '@eidp/contracts/requests'
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { profileOf } from '../../integrations/ldap/index.ts'
import { can, type Access } from '../access/index.ts'
import { db, isUniqueViolation } from '../../lib/db.ts'
import { ApiError } from '../../lib/errors.ts'
import { assess, assessmentsOf, type Assessment } from './risk.ts'
import { check, uniqueNames } from './check.ts'
import { assertCanDecide, decidableBy, mayDecide } from './deciding.ts'
import { execute } from './execute.ts'
import { retryStep } from './pipeline/follow-up.ts'
import { previewPipeline } from './pipeline/write.ts'
import type { Actor, AdoTarget, JiraTarget, NewRequest, Target } from './model.ts'
import { find, same, toRecord, withSteps } from './rows.ts'
import { requests } from './schema.ts'
import { errorFields, log } from '../../lib/log.ts'
import { notifyFiled, notifyRejected, refOf } from './notify.ts'
import { mailsAbout, resendMail } from '../notifications/index.ts'
import type { SentMail } from '@eidp/contracts/notifications'

/**
 * A request's life: filed, listed, decided, withdrawn, retried. Rows are never deleted — the row is the history.
 */

export async function submit(input: NewRequest, actor: Actor): Promise<RequestRecord> {
  if (!input.justification.trim()) {
    throw new ApiError(400, 'invalid_request', 'Say why you need it, so DEVOPS can decide.')
  }
  if (input.kind === 'grant_access' || input.kind === 'revoke_access') return submitAccess(input, actor)
  const team = await ownTeam(input.teamGroup, actor)
  const verdict = await check(input)
  if (!verdict.ok) throw new ApiError(409, 'request_not_possible', verdict.reason)

  try {
    const rows = await db.insert(requests).values(rowOf(input, input.justification, team, actor)).returning()
    return filed(toRecord(rows[0]!))
  } catch (err) {
    throw sameThingRaced(err)
  }
}

/**
 * Whoever is granted access must be the requester's own team: asked of the
 * directory now, so nobody can hand a project to a group they are not in.
 */
async function ownTeam(teamGroup: string | undefined, actor: Actor): Promise<string> {
  if (!teamGroup) throw new ApiError(400, 'invalid_request', 'Choose your team.')
  const groups = (await profileOf(actor.uid))?.groups ?? []
  const team = groups.find((group) => same(group, teamGroup))
  if (!team) throw new ApiError(400, 'invalid_request', `You are not a member of ${teamGroup}. Choose one of your own groups.`)
  return team
}

/** A creation's row, as filed. */
function rowOf(input: Exclude<Target, { kind: 'grant_access' | 'revoke_access' }>, justification: string, team: string, actor: Actor, bundleId: string | null = null) {
  const developers = input.kind === 'create_project' ? uniqueNames(input.developers ?? []) : []
  const lead = input.kind === 'create_jira_project' ? input.lead?.trim() : undefined
  return {
    kind: input.kind,
    collection: input.kind === 'create_jira_project' ? null : input.collection,
    project: input.project,
    projectKey: input.kind === 'create_jira_project' ? input.projectKey : null,
    repository: input.kind === 'create_repository' || input.kind === 'create_pipeline' ? input.repository : null,
    description: input.kind === 'create_pipeline' ? null : input.description?.trim() || null,
    pipeline: input.kind === 'create_pipeline' ? input.pipeline : null,
    grantees: developers.length > 0 ? developers : null,
    // The requester leading it is the default, not a value to store.
    projectLead: lead && !same(lead, actor.uid) ? lead : null,
    justification: justification.trim(),
    requestedBy: actor.uid,
    requestedByName: actor.name,
    teamGroup: team,
    bundleId,
  }
}

/** The check passed, but someone filed the same thing in the gap: the unique index is what actually decides. */
function sameThingRaced(err: unknown): unknown {
  return isUniqueViolation(err) ? new ApiError(409, 'request_not_possible', 'Someone has just asked for the same thing.') : err
}

/**
 * A project in Azure DevOps, in Jira, or both, from one form — the old
 * portal's "Request New DevOps Project". One request per system, filed
 * together or not at all, and linked (`bundle_id`) so each request page shows
 * the other. Each is decided, adjusted and retried on its own: approving the
 * Jira project does not wait on Azure DevOps, nor fail with it.
 */
export async function submitProject(input: ProjectRequest, actor: Actor): Promise<RequestRecord[]> {
  if (!input.justification.trim()) throw new ApiError(400, 'invalid_request', 'Say why you need it, so DEVOPS can decide.')
  if (!input.ado && !input.jira) throw new ApiError(400, 'invalid_request', 'Choose where the project goes: Azure DevOps, Jira, or both.')
  const team = await ownTeam(input.teamGroup, actor)
  const targets: (AdoTarget | JiraTarget)[] = []
  if (input.ado) targets.push({ kind: 'create_project', collection: input.ado.collection, project: input.project, description: input.description, developers: input.ado.developers })
  if (input.jira) targets.push({ kind: 'create_jira_project', project: input.project, projectKey: input.jira.projectKey, description: input.description, lead: input.jira.lead })

  // Every part checked before any is filed, each refusal named by its system.
  const verdicts = await Promise.all(targets.map((target) => check(target)))
  const refused = verdicts.flatMap((verdict, i) => (verdict.ok ? [] : [`${targets[i]!.kind === 'create_jira_project' ? 'Jira' : 'Azure DevOps'}: ${verdict.reason}`]))
  if (refused.length > 0) throw new ApiError(409, 'request_not_possible', refused.join(' '))

  const bundleId = targets.length > 1 ? randomUUID() : null
  try {
    const rows = await db.transaction((tx) => tx.insert(requests).values(targets.map((target) => rowOf(target, input.justification, team, actor, bundleId))).returning())
    return rows.map((row) => filed(toRecord(row)))
  } catch (err) {
    throw sameThingRaced(err)
  }
}

/** The other requests filed from the same New project form. */
async function filedWith(request: RequestRecord): Promise<FiledWith[]> {
  if (!request.bundleId) return []
  const rows = await db
    .select({ id: requests.id, kind: requests.kind, status: requests.status, collection: requests.collection, project: requests.project, projectKey: requests.projectKey })
    .from(requests)
    .where(and(eq(requests.bundleId, request.bundleId), ne(requests.id, request.id)))
    .orderBy(asc(requests.kind))
  return rows
}

/**
 * Access given or taken away. An access request is Contribute on the whole
 * project — fixed, not chosen. Rows filed before that was fixed may name a
 * repository or Read, and `executeGrant` still honours them. A removal takes
 * the people named out of the project's Contributors and Readers.
 */
async function submitAccess(input: AdoTarget & NewRequest, actor: Actor): Promise<RequestRecord> {
  const granting = input.kind === 'grant_access'
  input = { ...input, repository: undefined, accessLevel: granting ? 'contribute' : undefined }
  const verdict = await check(input)
  if (!verdict.ok) throw new ApiError(409, 'request_not_possible', verdict.reason)
  const rows = await db
    .insert(requests)
    .values({
      kind: input.kind,
      collection: input.collection,
      project: input.project,
      repository: null,
      justification: input.justification.trim(),
      requestedBy: actor.uid,
      requestedByName: actor.name,
      grantees: uniqueNames(input.grantees ?? []),
      accessLevel: granting ? 'contribute' : null,
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
  void notifyFiled(request)
  return request
}

/**
 * The records with their assessments attached — only ever called for DevOps
 * (`requests.decide`). The assessment is DevOps' tool for weighing a request;
 * nobody else sees it, not even a team lead deciding their own team's access.
 */
async function withAssessments(requests: RequestRecord[]): Promise<RequestRecord[]> {
  const found = await assessmentsOf(requests.map((r) => r.id))
  return requests.map((r) => ({ ...r, assessment: found.get(r.id) ?? null }))
}

/** Assesses a request again — the directory and the catalog may have changed since it was filed. */
export async function reassess(id: string, access: Access): Promise<Assessment> {
  await assertCanDecide(id, access)
  if (!can(access, 'requests.decide')) throw new ApiError(403, 'forbidden', 'The risk assessment is for DevOps.')
  return assess(await find(id))
}

export async function listMine(uid: string): Promise<RequestRecord[]> {
  const rows = await db.select().from(requests).where(eq(requests.requestedBy, uid)).orderBy(desc(requests.requestedAt)).limit(200)
  return withSteps(rows.map(toRecord))
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
  const all = { open: await withSteps(open.map(toRecord)), recent: await withSteps(recent.map(toRecord)) }
  // Assessments ride on the open ones only: that is where a decision is still to be made.
  if (can(access, 'requests.decide')) return { open: await withAssessments(all.open), recent: all.recent }
  const decidable = await decidableBy(access, [...all.open, ...all.recent])
  return {
    open: all.open.filter((r) => decidable.has(r.id)),
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
  const all = await withSteps(rows.map(toRecord))
  if (can(access, 'requests.decide')) return all
  const decidable = await decidableBy(access, all)
  return all.filter((r) => decidable.has(r.id))
}

export const HISTORY_LIMIT = 1000

/** A request, if this person may see it: their own, or one they may decide — and whether they may. */
export async function get(id: string, actor: Actor, access: Access): Promise<RequestRecord & { canDecide: boolean; filedWith: FiledWith[] }> {
  const request = (await withSteps([await find(id)]))[0]!
  const canDecide = await mayDecide(request, access)
  if (request.requestedBy !== actor.uid && !canDecide) {
    throw new ApiError(404, 'request_not_found', 'There is no such request.')
  }
  const together = await filedWith(request)
  // The risk assessment is DevOps' alone: not the requester's, nor a team lead's.
  if (!canDecide || !can(access, 'requests.decide')) return { ...request, canDecide, filedWith: together }
  const [withAssessment] = await withAssessments([request])
  return { ...withAssessment!, canDecide, filedWith: together }
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
  const rejected = toRecord(rows[0])
  void notifyRejected(rejected)
  return rejected
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

/** What approving a pipeline request would write — for the people who may decide it, who read the files before approving. */
export async function pipelinePreview(id: string, access: Access): Promise<PipelinePreview> {
  await assertCanDecide(id, access)
  const request = await find(id)
  if (request.kind !== 'create_pipeline') throw new ApiError(404, 'not_a_pipeline', 'That request is not for a pipeline.')
  return previewPipeline(request)
}

/** Runs one of a pushed pipeline's Jenkins steps again — for the people who may decide it. */
export async function retryPipelineStep(id: string, step: StepName, access: Access): Promise<RequestStep[]> {
  await assertCanDecide(id, access)
  return retryStep(id, step)
}

/**
 * The mail sent about a request — to whom, and whether it went — for the
 * people who may decide it: it carries DevOps' own addresses, and resending
 * is theirs to do.
 */
export async function requestEmails(id: string, access: Access): Promise<SentMail[]> {
  await assertCanDecide(id, access)
  return mailsAbout(refOf(id))
}

/** Sends one of a request's emails again: a failed one from scratch, a sent one as a fresh copy. */
export async function resendRequestEmail(id: string, mailId: number, access: Access): Promise<SentMail> {
  await assertCanDecide(id, access)
  return resendMail(mailId, refOf(id))
}
