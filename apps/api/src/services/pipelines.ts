import { jenkinsConfig, webUrl } from '../integrations/jenkins/index.ts'
import type { QueueItem } from '../integrations/jenkins/index.ts'
import { query } from '../lib/db.ts'
import { ApiError } from '../lib/errors.ts'
import * as jenkins from './jenkins.ts'
import { accessState, grantsReaching, syncJenkinsAccess, type AccessState, type Reach } from './jenkins-access.ts'
import { syncState, type SyncState } from './jenkins-sync.ts'
import { can, canSomewhere, type Access, type Target } from './rbac.ts'
import type { Actor } from './requests.ts'

/**
 * A person's own pipelines: the Jenkins jobs that are theirs, and what they
 * may do about them.
 *
 * Jenkins knows nothing of our teams, so a job is tied to a system through
 * the catalog: a job belongs to every application whose repository name is
 * one of the segments of its full name — `payments/loan-scoring-api` and the
 * multibranch `agriland-api/main` both name their repository. Whoever owns
 * that system (any environment's team in `team.yml`) owns the pipeline.
 *
 * A pipeline is someone's when:
 *   - Jenkins lets one of their groups, or them by name, read it — its own
 *     role-based or matrix authorization (`jenkins-access.ts`),
 *   - a team they are in owns it in the catalog,
 *   - a scoped binding lets them operate it (a `pipeline-operator` bound to
 *     its team or project), or
 *   - they started a build of it that history still holds.
 *
 * When Jenkins' rules can be read and name anyone, **Jenkins decides what a
 * team sees**: catalog ownership alone no longer puts a pipeline on the list
 * (it still labels the ones that are there), because the portal reads with a
 * service account that sees everything, and must not show a team what
 * Jenkins hides from it. Without readable rules, the catalog decides.
 *
 * Seeing is `pipelines.view`, which every member holds. Acting — run again,
 * stop, dequeue — is `jenkins.operate`: everywhere when bound globally (a
 * build operator), or only on the pipelines its team or project owns when
 * bound with a scope (a pipeline operator). Being in the owning team is not enough to
 * act: an operation reaches production, and that is a binding someone made
 * on purpose. Every action goes through `services/jenkins.ts`, so it is
 * audited exactly as an action on the Jenkins page is.
 */

/** A system a pipeline belongs to, read from the catalog. */
export type Owner = { system: string; project: string; applications: string[]; teams: string[] }

/** Why a pipeline is on someone's list — shown, so nobody wonders why it is there. */
export type Reason =
  | { kind: 'team'; team: string; project: string }
  /** Jenkins' own authorization lets this group, or this person, read it. */
  | { kind: 'jenkins'; sid: string; group: boolean; via: string }
  | { kind: 'scope'; via: string }
  | { kind: 'started'; builds: number; last: string }

export type Pipeline = {
  job: string
  url: string
  owners: Owner[]
  reasons: Reason[]
  canOperate: boolean
  last: jenkins.Run | null
  /** The last few builds, newest first, for a row of dots. */
  recent: { number: number; result: jenkins.Run['result']; startedAt: string }[]
  running: boolean
  inQueue: boolean
  /** Finished builds in the last seven days, and how many passed. */
  week: { builds: number; passed: number }
}

export type MyPipelines = {
  url: string
  sync: SyncState
  /** Where who-sees-what came from, and whether it is current. */
  access: AccessState & { decides: 'jenkins' | 'catalog' }
  pipelines: Pipeline[]
  /** What is waiting in Jenkins for these pipelines, each saying whether the caller may take it out. */
  queue: (QueueItem & { canOperate: boolean })[]
  /** Why the queue could not be read, when it could not. History still shows. */
  queueError: string | null
  /** Builds the caller started in the last seven days, newest first. */
  startedByYou: (jenkins.Run & { canOperate: boolean })[]
}

/** Who someone is, as Jenkins writes them into "Started by user …". */
export type Me = { uid: string; name: string }

const RECENT = 10
const STARTED_LIMIT = 10

// ---- what ties a pipeline to a person ------------------------------------------

/**
 * The systems that own each job, by repository name. Jobs that match no
 * application are left out — they belong to nobody the catalog knows.
 */
async function ownersOf(server: string, jobs?: string[]): Promise<Map<string, Owner[]>> {
  const { rows } = await query<{ job: string; system: string; project: string; teams: Record<string, string>; applications: string[] }>(
    `select j.full_name as job, s.dir as system, s.project_name as project, s.teams,
            array_agg(distinct a.name order by a.name) as applications
       from jenkins_jobs j
       join catalog_applications a
         on a.repository is not null and a.repository <> ''
        and lower(a.repository) = any(string_to_array(lower(j.full_name), '/'))
       join catalog_systems s on s.dir = a.system_dir
      where j.server = $1 and ($2::text[] is null or j.full_name = any($2))
      group by j.full_name, s.dir, s.project_name, s.teams
      order by j.full_name, s.dir`,
    [server, jobs ?? null],
  )
  const owners = new Map<string, Owner[]>()
  for (const row of rows) {
    const list = owners.get(row.job) ?? []
    list.push({ system: row.system, project: row.project, applications: row.applications, teams: [...new Set(Object.values(row.teams ?? {}))] })
    owners.set(row.job, list)
  }
  return owners
}

/**
 * Jenkins records a person by the name its security realm gives them — the
 * login with some realms, the display name with LDAP — so both are tried.
 */
function startedByCauses(me: Me): string[] {
  return [...new Set([me.uid, me.name].filter(Boolean).map((who) => `started by user ${who.toLowerCase()}`))]
}

async function startedBy(server: string, me: Me, jobs?: string[]): Promise<Map<string, { builds: number; last: string }>> {
  const { rows } = await query<{ job: string; builds: string; last: Date }>(
    `select job, count(*) as builds, max(started_at) as last
       from jenkins_builds
      where server = $1 and ($3::text[] is null or job = any($3))
        and exists (select 1 from unnest(causes) c where lower(c) = any($2))
      group by job`,
    [server, startedByCauses(me), jobs ?? null],
  )
  return new Map(rows.map((row) => [row.job, { builds: Number(row.builds), last: row.last.toISOString() }]))
}

const targetOf = (owner: Owner): Target => ({ project: owner.project, teams: owner.teams })

/** Why this job is the caller's, if it is. Empty means it is not. */
function reasonsFor(access: Access, owners: Owner[], started: { builds: number; last: string } | undefined, reaches: Reach[] = []): Reason[] {
  const reasons: Reason[] = []
  const groups = new Set(access.groups.map((g) => g.toLowerCase()))
  for (const reach of reaches) {
    const group = reach.sidType === 'group' || (reach.sidType === 'either' && groups.has(reach.sid.toLowerCase()))
    if (!reasons.some((r) => r.kind === 'jenkins' && r.sid === reach.sid)) reasons.push({ kind: 'jenkins', sid: reach.sid, group, via: reach.via })
  }
  for (const owner of owners) {
    for (const team of owner.teams) {
      if (groups.has(team.toLowerCase()) && !reasons.some((r) => r.kind === 'team' && r.team.toLowerCase() === team.toLowerCase())) {
        reasons.push({ kind: 'team', team, project: owner.project })
      }
    }
  }
  // A scoped binding names the pipeline as surely as a team does. A global one
  // reaches every job and so says nothing about which are the caller's.
  for (const grant of access.grants) {
    if (grant.scopeType === 'global' || !grant.scope) continue
    if (grant.permission !== 'jenkins.operate') continue
    const scope = grant.scope.toLowerCase()
    const reaches = owners.some((o) =>
      grant.scopeType === 'project' ? o.project.toLowerCase() === scope : o.teams.some((t) => t.toLowerCase() === scope),
    )
    if (reaches && !reasons.some((r) => r.kind === 'scope' && r.via === grant.via)) reasons.push({ kind: 'scope', via: grant.via })
  }
  if (started) reasons.push({ kind: 'started', ...started })
  return reasons
}

/**
 * Whether these reasons put the pipeline on the list. When Jenkins decides,
 * the catalog's team label alone does not: Jenkins may hide it from that team.
 */
function visible(reasons: Reason[], decides: 'jenkins' | 'catalog'): boolean {
  return reasons.some((r) => decides === 'catalog' || r.kind !== 'team')
}

/** Jenkins decides once its rules have been read and name someone; until then, the catalog. */
async function whoDecides(): Promise<AccessState & { decides: 'jenkins' | 'catalog' }> {
  const state = await accessState()
  // Never read: start a read now, so the next look has it.
  if (!state.readAt && !state.error) void syncJenkinsAccess().catch(() => {})
  const decides = state.readAt && (state.source === 'role-strategy' || state.source === 'matrix') && state.grants > 0 ? 'jenkins' : 'catalog'
  return { ...state, decides }
}

/** Whether the caller may run again, stop or dequeue builds of a job owned by these systems. */
function mayOperate(access: Access, owners: Owner[]): boolean {
  return can(access, 'jenkins.operate') || owners.some((owner) => can(access, 'jenkins.operate', targetOf(owner)))
}

// ---- the list ------------------------------------------------------------------

/** The caller's pipelines, failing ones first, then by latest activity. */
export async function mine(access: Access, me: Me): Promise<MyPipelines> {
  const url = jenkinsConfig().url
  const [sync, rules, owners, started, reaches] = await Promise.all([
    syncState(),
    whoDecides(),
    ownersOf(url),
    startedBy(url, me),
    grantsReaching(me.uid, access.groups),
  ])
  const reachByJob = new Map<string, Reach[]>()
  for (const reach of reaches) reachByJob.set(reach.job, [...(reachByJob.get(reach.job) ?? []), reach])

  const related = new Map<string, { owners: Owner[]; reasons: Reason[] }>()
  for (const job of new Set([...owners.keys(), ...started.keys(), ...reachByJob.keys()])) {
    const jobOwners = owners.get(job) ?? []
    const reasons = reasonsFor(access, jobOwners, started.get(job), reachByJob.get(job))
    if (visible(reasons, rules.decides)) related.set(job, { owners: jobOwners, reasons })
  }
  const jobs = [...related.keys()]

  const [heads, recent, weeks, own] = await Promise.all([
    query<{ full_name: string; url: string; in_queue: boolean }>(
      'select full_name, url, in_queue from jenkins_jobs where server = $1 and full_name = any($2)',
      [url, jobs],
    ),
    query<jenkins.RunRow & { rank: string }>(
      `select * from (
         select b.*, row_number() over (partition by job order by number desc) as rank
           from jenkins_builds b where server = $1 and job = any($2)
       ) ranked where rank <= $3 order by job, number desc`,
      [url, jobs, RECENT],
    ),
    query<{ job: string; builds: string; passed: string }>(
      `select job, count(*) as builds, count(*) filter (where result = 'success') as passed
         from jenkins_builds
        where server = $1 and job = any($2) and started_at >= now() - interval '7 days'
          and result not in ('running', 'not_built')
        group by job`,
      [url, jobs],
    ),
    query<jenkins.RunRow>(
      `select * from jenkins_builds
        where server = $1 and started_at >= now() - interval '7 days'
          and exists (select 1 from unnest(causes) c where lower(c) = any($2))
        order by started_at desc limit $3`,
      [url, startedByCauses(me), STARTED_LIMIT],
    ),
  ])

  const byJob = new Map<string, jenkins.Run[]>()
  for (const row of recent.rows) byJob.set(row.job, [...(byJob.get(row.job) ?? []), jenkins.toRun(row)])
  const week = new Map(weeks.rows.map((row) => [row.job, { builds: Number(row.builds), passed: Number(row.passed) }]))
  const head = new Map(heads.rows.map((row) => [row.full_name, row]))
  const operable = (job: string) => mayOperate(access, related.get(job)?.owners ?? [])

  const pipelines: Pipeline[] = jobs.map((job) => {
    const builds = byJob.get(job) ?? []
    const { owners: jobOwners, reasons } = related.get(job)!
    return {
      job,
      url: head.get(job)?.url ?? webUrl(job),
      owners: jobOwners,
      reasons,
      canOperate: operable(job),
      last: builds[0] ?? null,
      recent: builds.map((b) => ({ number: b.number, result: b.result, startedAt: b.startedAt })),
      running: builds.some((b) => b.result === 'running'),
      inQueue: head.get(job)?.in_queue ?? false,
      week: week.get(job) ?? { builds: 0, passed: 0 },
    }
  })
  pipelines.sort((a, b) => Number(broken(b)) - Number(broken(a)) || (b.last?.startedAt ?? '').localeCompare(a.last?.startedAt ?? '') || a.job.localeCompare(b.job))

  let queue: MyPipelines['queue'] = []
  let queueError: string | null = null
  try {
    queue = (await jenkins.queueNow())
      .filter((item) => item.job !== null && related.has(item.job))
      .map((item) => ({ ...item, canOperate: operable(item.job!) }))
    // The live queue is newer than the sync's flag; it decides what is waiting.
    const waiting = new Set(queue.map((item) => item.job))
    for (const p of pipelines) p.inQueue = waiting.has(p.job)
  } catch (err) {
    queueError = err instanceof Error ? err.message : String(err)
  }

  return {
    url,
    sync,
    access: rules,
    pipelines,
    queue,
    queueError,
    startedByYou: own.rows.map((row) => ({ ...jenkins.toRun(row), canOperate: operable(row.job) })),
  }
}

/** Failing now: the latest finished build did not pass. */
function broken(p: Pipeline): boolean {
  const finished = p.recent.find((b) => b.result !== 'running' && b.result !== 'not_built')
  return finished?.result === 'failure' || finished?.result === 'unstable'
}

// ---- one pipeline --------------------------------------------------------------

/** What the caller may do with one job: see it at all, and act on it. */
export async function accessTo(access: Access, me: Me, job: string): Promise<{ view: boolean; operate: boolean }> {
  const viewAll = can(access, 'jenkins.view')
  const mayView = viewAll || canSomewhere(access, 'pipelines.view')
  const mayAct = canSomewhere(access, 'jenkins.operate')
  if (!mayView && !mayAct) return { view: false, operate: false }

  const url = jenkinsConfig().url
  const [owners, started, reaches, rules] = await Promise.all([
    ownersOf(url, [job]),
    startedBy(url, me, [job]),
    grantsReaching(me.uid, access.groups, [job]),
    whoDecides(),
  ])
  const jobOwners = owners.get(job) ?? []
  const operate = mayOperate(access, jobOwners)
  const view = viewAll || operate || (mayView && visible(reasonsFor(access, jobOwners, started.get(job), reaches), rules.decides))
  return { view, operate }
}

/**
 * Refuses unless the caller may act on this job. The route has already
 * refused anyone holding `jenkins.operate` nowhere; this is the per-job half.
 */
export async function demandOperate(access: Access, me: Me, job: string): Promise<void> {
  if (!(await accessTo(access, me, job)).operate) {
    throw new ApiError(403, 'forbidden', `You may not run, stop or dequeue builds of ${job} — none of your bindings covers the team or project that owns it.`)
  }
}

/** Refuses unless the caller may see this job's builds. A job that is not theirs reads as not found. */
export async function demandView(access: Access, me: Me, job: string): Promise<{ operate: boolean }> {
  const allowed = await accessTo(access, me, job)
  if (!allowed.view) throw new ApiError(404, 'pipeline_not_found', 'There is no pipeline of yours by that name.')
  return { operate: allowed.operate }
}

export async function rebuild(access: Access, me: Me, job: string, number: number, actor: Actor) {
  await demandOperate(access, me, job)
  return jenkins.rebuild(job, number, actor)
}

export async function stop(access: Access, me: Me, job: string, number: number, actor: Actor) {
  await demandOperate(access, me, job)
  return jenkins.stop(job, number, actor)
}

export function cancel(access: Access, me: Me, id: number, actor: Actor) {
  return jenkins.cancel(id, actor, (job) => demandOperate(access, me, job))
}
