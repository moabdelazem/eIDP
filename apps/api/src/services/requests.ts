import type { DatabaseError } from 'pg'
import {
  addToProjectGroup,
  CONTRIBUTOR,
  createProject,
  createRepository,
  findIdentity,
  grantRepository,
  listProjects,
  listRepositories,
  READER,
  webUrlFor,
  type Principal,
} from '../integrations/ado/index.ts'
import * as jira from '../integrations/jira/index.ts'
import { dnOf, profileOf } from '../integrations/ldap/index.ts'
import { can, teamsOwning, type Access } from './rbac.ts'
import { query } from '../lib/db.ts'
import { ApiError } from '../lib/errors.ts'
import { jiraKeyProblem, jiraNameProblem, nameProblem } from './request-rules.ts'
import { assess, assessmentsOf, type Assessment } from './request-risk.ts'

export type RequestKind = 'create_repository' | 'create_project' | 'grant_access' | 'create_jira_project'
export type AccessLevel = 'read' | 'contribute'

/** Enough for a team; a larger grant is a group's job, not a list of names. */
const MAX_GRANTEES = 20
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'completed' | 'failed' | 'cancelled'

export type Actor = { uid: string; name: string }

export type RequestRecord = {
  id: string
  kind: RequestKind
  status: RequestStatus
  /** The ADO collection; null for Jira, which has none. */
  collection: string | null
  project: string
  /** create_jira_project only: the key every issue will carry, like PAY. */
  projectKey: string | null
  repository: string | null
  description: string | null
  justification: string
  /** The directory group granted access with the requester; null on older rows. */
  teamGroup: string | null
  /** grant_access only: the accounts to be granted, and at what level. */
  grantees: string[] | null
  accessLevel: AccessLevel | null
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
  /** For people who may decide it: what to weigh before approving. Absent for everyone else. */
  assessment?: Assessment | null
}

/** What is being asked for in Azure DevOps. */
export type AdoTarget = {
  kind: Exclude<RequestKind, 'create_jira_project'>
  collection: string
  project: string
  repository?: string
  description?: string
  /** grant_access only. */
  grantees?: string[]
  accessLevel?: AccessLevel
}

/** A Jira project: `project` is its name, `projectKey` its key. */
export type JiraTarget = {
  kind: 'create_jira_project'
  project: string
  projectKey: string
  description?: string
}

export type Target = AdoTarget | JiraTarget

export type NewRequest = Target & {
  justification: string
  /** Creations only. */
  teamGroup?: string
}

export type Check = { ok: true } | { ok: false; reason: string }

/**
 * Whether a request could be filed as it stands: the name is one ADO accepts,
 * the target does not exist yet, and nobody has already asked for it. The form
 * calls this as someone types, and `submit` runs the same thing, so the answer
 * on screen is the answer on submit.
 */
export async function check(input: Target): Promise<Check> {
  if (input.kind === 'create_jira_project') return checkJiraProject(input)
  if (input.kind === 'grant_access') return checkGrant(input)
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

/**
 * Access to something that already exists: the project, and the repository if
 * one is named, must be there, and every grantee must be an account the
 * directory knows — ADO would otherwise fail it only after approval.
 */
async function checkGrant(input: AdoTarget): Promise<Check> {
  const grantees = uniqueNames(input.grantees ?? [])
  if (grantees.length === 0) return { ok: false, reason: 'Name at least one person to grant access to.' }
  if (grantees.length > MAX_GRANTEES) {
    return { ok: false, reason: `At most ${MAX_GRANTEES} people per request; for more, grant their group.` }
  }

  const project = (await listProjects(input.collection)).find((p) => same(p.name, input.project))
  if (!project) return { ok: false, reason: `There is no project ${input.project} in ${input.collection}.` }
  if (input.repository) {
    const repos = await listRepositories(input.collection, project.name)
    if (!repos.some((r) => same(r.name, input.repository!))) {
      return { ok: false, reason: `${project.name} has no repository called ${input.repository}.` }
    }
  }

  const unknown: string[] = []
  for (const name of grantees) if (!(await dnOf(name))) unknown.push(name)
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `The directory has no account called ${unknown.join(', ')}. Use login names, like jsmith.`,
    }
  }
  return { ok: true }
}

/**
 * A Jira project needs a name and a key nobody has, and a key Jira's own rules
 * accept — which only the server knows, since the pattern, the length and the
 * reserved words are its configuration. It also sees archived projects, whose
 * keys stay taken though the project list leaves them out.
 */
async function checkJiraProject(input: JiraTarget): Promise<Check> {
  const problem = jiraNameProblem(input.project) ?? jiraKeyProblem(input.projectKey)
  if (problem) return { ok: false, reason: problem }

  const existing = (await jira.listProjects()).find((p) => same(p.name, input.project))
  if (existing) return { ok: false, reason: `Jira already has a project called ${existing.name} (${existing.key}).` }
  const keyProblem = await jira.keyProblem(input.projectKey)
  if (keyProblem) return { ok: false, reason: keyProblem }

  const { rows } = await query<{ requested_by_name: string }>(
    `select requested_by_name from requests
      where kind = 'create_jira_project' and (lower(project) = lower($1) or lower(project_key) = lower($2))
        and status in ('pending', 'approved')`,
    [input.project, input.projectKey],
  )
  if (rows[0]) {
    return { ok: false, reason: `${rows[0].requested_by_name} has already asked for this; it is waiting on approval.` }
  }
  return { ok: true }
}

function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, string>()
  for (const raw of names) {
    const name = raw.trim()
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name)
  }
  return [...seen.values()]
}

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

/**
 * Creates the thing, then gives the requester and their team Contributor
 * access to it. Nobody asks for a repository they cannot push to.
 *
 * Identities are resolved before anything is created, so a team ADO cannot
 * find fails the request with nothing made. `result_url` is written the moment
 * creation succeeds: if granting then fails, a retry sees it and only grants,
 * rather than trying to create something that now exists.
 */
async function execute(request: RequestRecord): Promise<void> {
  try {
    if (request.kind === 'create_jira_project') return await executeJiraProject(request)
    if (request.kind === 'grant_access') return await executeGrant(request)
    const collection = request.collection!
    const principals: Principal[] = []
    for (const name of [request.requestedBy, request.teamGroup]) {
      if (name) principals.push(await findIdentity(collection, name))
    }
    const created = request.resultUrl !== null

    let resultUrl: string
    if (request.kind === 'create_repository') {
      const repo = created
        ? await existingRepository(request)
        : await createRepository(collection, request.project, request.repository!)
      resultUrl = repo.webUrl ?? webUrlFor(collection, request.project, repo.name)
      if (!created) await recordCreated(request.id, resultUrl)
      await withContext(`Created ${repo.name}, but could not grant access`, () =>
        grantRepository(collection, repo.project.id, repo.id, principals),
      )
    } else {
      const project = created
        ? { name: request.project }
        : await createProject(collection, request.project, request.description ?? '')
      resultUrl = webUrlFor(collection, project.name)
      if (!created) await recordCreated(request.id, resultUrl)
      await withContext(`Created ${project.name}, but could not grant access`, () =>
        addToProjectGroup(collection, project.name, 'Contributors', principals),
      )
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

/**
 * Grants access to something that exists. Every grantee is resolved first, so
 * one unknown name grants nobody rather than half the list. Granting is
 * idempotent in ADO — a merged ACE, a group someone may already be in — so a
 * retry simply runs it again.
 */
async function executeGrant(request: RequestRecord): Promise<void> {
  const collection = request.collection!
  const principals: Principal[] = []
  for (const name of request.grantees ?? []) principals.push(await findIdentity(collection, name))
  const read = request.accessLevel === 'read'

  let resultUrl: string
  if (request.repository) {
    const repo = await existingRepository(request)
    await grantRepository(collection, repo.project.id, repo.id, principals, read ? READER : CONTRIBUTOR)
    resultUrl = repo.webUrl ?? webUrlFor(collection, request.project, repo.name)
  } else {
    await addToProjectGroup(collection, request.project, read ? 'Readers' : 'Contributors', principals)
    resultUrl = webUrlFor(collection, request.project)
  }
  await query(
    `update requests set status = 'completed', completed_at = now(), result_url = $2, error = null
      where id = $1`,
    [request.id, resultUrl],
  )
}

/**
 * Creates the Jira project, led by the requester, then puts the requester and
 * their team in its member role. As with Azure DevOps, both are found in Jira
 * before anything is created, and `result_url` is written the moment the
 * project exists, so a retry after a failed grant only grants.
 */
async function executeJiraProject(request: RequestRecord): Promise<void> {
  const lead = await jira.findUser(request.requestedBy)
  const members = [lead, ...(request.teamGroup ? [await jira.findGroup(request.teamGroup)] : [])]
  const key = request.projectKey!
  const resultUrl = jira.browseUrl(key)

  if (request.resultUrl === null) {
    await jira.createProject({ key, name: request.project, description: request.description ?? '', lead: lead.name })
    await recordCreated(request.id, resultUrl)
  }
  const { memberRole } = jira.jiraConfig()
  await withContext(`Created ${key}, but could not grant access`, () => jira.addToRole(key, memberRole, members))
  await query(
    `update requests set status = 'completed', completed_at = now(), result_url = $2, error = null
      where id = $1`,
    [request.id, resultUrl],
  )
}

async function existingRepository(request: RequestRecord) {
  const repos = await listRepositories(request.collection!, request.project)
  const repo = repos.find((r) => same(r.name, request.repository!))
  if (!repo) throw new ApiError(404, 'ado_repository_missing', `${request.repository} is no longer in ${request.project}.`)
  return repo
}

function recordCreated(id: string, resultUrl: string) {
  return query('update requests set result_url = $2 where id = $1', [id, resultUrl])
}

/** Says what already happened when a later step fails, so DevOps know a retry only has to grant. */
async function withContext(context: string, step: () => Promise<void>): Promise<void> {
  try {
    await step()
  } catch (err) {
    throw new Error(`${context}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Whether `access` may decide this request. Creations are DevOps' alone
 * (`requests.decide`); an access request may also be decided by whoever holds
 * `requests.decide_access` for its project or for a team that owns it.
 *
 * Deciding your own request is allowed: the team chose speed over a second
 * pair of eyes, and decided_by still records who approved what.
 */
async function mayDecide(request: RequestRecord, access: Access): Promise<boolean> {
  if (can(access, 'requests.decide')) return true
  if (request.kind !== 'grant_access') return false
  return can(access, 'requests.decide_access', { project: request.project, teams: await teamsOwning(request.project) })
}

/** The ids among `requests` that `access` may decide, looking each project's teams up once. */
async function decidableBy(access: Access, requests: RequestRecord[]): Promise<Set<string>> {
  const teams = new Map<string, string[]>()
  const ids = new Set<string>()
  for (const request of requests) {
    if (request.kind !== 'grant_access') continue
    const key = request.project.toLowerCase()
    if (!teams.has(key)) teams.set(key, await teamsOwning(request.project))
    if (can(access, 'requests.decide_access', { project: request.project, teams: teams.get(key)! })) ids.add(request.id)
  }
  return ids
}

async function assertCanDecide(id: string, access: Access): Promise<void> {
  const request = await find(id) // 404 when it does not exist
  if (!(await mayDecide(request, access))) {
    throw new ApiError(
      403,
      'forbidden',
      request.kind === 'grant_access'
        ? 'You can’t decide this request: it is for a project outside the teams you approve for.'
        : 'Only DevOps can decide requests to create repositories and projects.',
    )
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

function toRecord(row: Row): RequestRecord {
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
