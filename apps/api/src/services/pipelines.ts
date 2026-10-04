import { EVERYONE_SID, jenkinsConfig, webUrl } from '../integrations/jenkins/index.ts'
import type { Parameter, QueueItem } from '../integrations/jenkins/index.ts'
import { ollamaConfig } from '../integrations/ollama/index.ts'
import { query } from '../lib/db.ts'
import { ApiError } from '../lib/errors.ts'
import * as explainer from './build-explainer.ts'
import * as jenkins from './jenkins.ts'
import { accessState, grantsReaching, syncJenkinsAccess, type AccessState, type Reach } from './jenkins-access.ts'
import { syncState, type SyncState } from './jenkins-sync.ts'
import { can, canSomewhere, type Access, type Target } from './rbac.ts'
import type { Actor } from './requests.ts'

/**
 * My pipelines: the **runs** that are a person's — not every build of every
 * job they can see — and what they may do about them.
 *
 * A run is someone's own when they started it, or when it built a commit
 * they wrote: a push is built by whoever triggers it (a service account like
 * maika, or an SCM change), so the commit author is the person it was for.
 *
 * A run is their team's when it is for a project their team owns. Shared jobs
 * (one build job, one deploy job for everybody) say which project in their
 * parameters — `APP_NAME=loan-scoring-api`, `REPOSITORY=…/loan-scoring-api.git`
 * — so a run's project is what its parameters name, and only when they name
 * none what the job's own name does (`payments/loan-scoring-api`, multibranch
 * `agriland-api/main`). A run of the shared deploy job for someone else's
 * project is not theirs, however readable the job is. Names are matched
 * against the catalog's applications and repositories; the system that owns
 * the application owns the run, through any environment's team in `team.yml`.
 *
 * Jenkins' own rules (`jenkins-access.ts`), once read, still bound what a team
 * sees: a team's run is shown only if Jenkins lets them read its job. A grant
 * on a job also makes its runs theirs when the run names no project — a grant
 * on a shared job says nothing about whose each run is.
 *
 * Seeing is `pipelines.view`, which every member holds. Acting — run again,
 * stop, dequeue — is `jenkins.operate`: everywhere when bound globally (a
 * build operator), or only on runs of the projects its team or project owns
 * when bound with a scope (a pipeline operator). Writing the commit is not
 * enough to act: an operation can reach production, and that is a binding
 * someone made on purpose. Every action goes through `services/jenkins.ts`,
 * so it is audited exactly as an action on the Jenkins page is.
 */

/** A system a run belongs to, read from the catalog, with the applications that tie it. */
export type Owner = { system: string; project: string; applications: string[]; teams: string[] }

/** Why a run is on someone's list — shown, so nobody wonders why it is there. */
export type Reason =
  | { kind: 'started' }
  /** It built a commit you wrote; `by` is who started it — the service account, usually. */
  | { kind: 'commit'; by: string | null }
  | { kind: 'team'; team: string; project: string }
  /** Jenkins lets this group, or you by name, read the job — for runs that name no project. */
  | { kind: 'jenkins'; sid: string; group: boolean; via: string }
  | { kind: 'scope'; via: string }

export type RunView = jenkins.Run & {
  /** The applications the run is for, and whether its parameters or its job's name said so. */
  applications: string[]
  matchedBy: 'parameters' | 'job' | null
  owners: Owner[]
  reasons: Reason[]
  /** Yours by name: you started it, or it built your commit. */
  personal: boolean
  canOperate: boolean
  /** For a failed or unstable run, the AI's kept answer on why — when the caller may use it and one was made. */
  explanation: explainer.Brief | null
}

/** One job — or, for a shared job, one job for one project — summed over the runs you may see. */
export type PipelineView = {
  key: string
  job: string
  /** For a shared job, the project the runs are for. */
  applications: string[]
  url: string
  owners: Owner[]
  reasons: Reason[]
  last: RunView
  recent: { number: number; result: jenkins.Run['result']; startedAt: string }[]
  running: boolean
  inQueue: boolean
  /** Finished runs in the window, and how many passed. */
  finished: { builds: number; passed: number }
}

export type QueueView = QueueItem & Pick<RunView, 'applications' | 'matchedBy' | 'owners' | 'reasons' | 'personal' | 'canOperate'>

export const RUN_WINDOWS = { '24h': 24, '7d': 168, '30d': 720 } as const
export type RunWindow = keyof typeof RUN_WINDOWS

export type MyRuns = {
  url: string
  sync: SyncState
  /** Where who-sees-what came from, and whether it is current. */
  access: AccessState & { decides: 'jenkins' | 'catalog' }
  window: RunWindow
  runs: RunView[]
  /** More runs matched than are listed; the newest are. */
  truncated: boolean
  pipelines: PipelineView[]
  queue: QueueView[]
  /** Why the queue could not be read, when it could not. History still shows. */
  queueError: string | null
  /** Whether the caller can ask the AI why a run failed: null when they may not, else whether it is set up. */
  ai: { configured: boolean; model: string | null } | null
}

/** Who someone is, every way Jenkins may write them: login, display name, email. */
export type Me = { uid: string; name: string; mail?: string | null }

const RUN_LIMIT = 500
const RECENT = 10

// ---- the catalog's applications, by every name a run may use ------------------------

type AppRef = { application: string; system: string; project: string; teams: string[] }

/**
 * ponytail: per process, a minute. The catalog changes when it syncs, which
 * is not often; 1100 rows per request would be wasteful.
 */
let appIndex: { at: number; byName: Map<string, AppRef[]> } | null = null

async function applications(): Promise<Map<string, AppRef[]>> {
  if (appIndex && Date.now() - appIndex.at < 60_000) return appIndex.byName
  const { rows } = await query<{ name: string; repository: string | null; system: string; project: string; teams: Record<string, string> }>(
    `select distinct a.name, a.repository, s.dir as system, s.project_name as project, s.teams
       from catalog_applications a join catalog_systems s on s.dir = a.system_dir`,
  )
  const byName = new Map<string, AppRef[]>()
  for (const row of rows) {
    const ref = { application: row.repository || row.name, system: row.system, project: row.project, teams: [...new Set(Object.values(row.teams ?? {}))] }
    for (const name of new Set([row.name, row.repository].filter((n): n is string => !!n).map((n) => n.toLowerCase()))) {
      const list = byName.get(name) ?? []
      if (!list.some((r) => r.system === ref.system && r.application === ref.application)) list.push(ref)
      byName.set(name, list)
    }
  }
  appIndex = { at: Date.now(), byName }
  return byName
}

/** Forget the index — for tests that change the catalog under it. */
export function forgetApplications(): void {
  appIndex = null
}

/** A parameter value as a name: `https://git/x/loan-scoring-api.git` → `loan-scoring-api`. */
function candidates(value: string): string[] {
  const v = value.trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '')
  return [...new Set([v, v.split(/[/:]/).pop() ?? v])]
}

/** What a run is for: what its parameters name, else what its job's name does. */
function resolve(byName: Map<string, AppRef[]>, job: string, parameters: Parameter[]): { refs: AppRef[]; matchedBy: RunView['matchedBy'] } {
  const fromParameters = parameters.filter((p) => !p.hidden && p.value).flatMap((p) => candidates(p.value!).flatMap((name) => byName.get(name) ?? []))
  if (fromParameters.length > 0) return { refs: fromParameters, matchedBy: 'parameters' }
  const fromJob = job
    .toLowerCase()
    .split('/')
    .flatMap((segment) => byName.get(segment) ?? [])
  return { refs: fromJob, matchedBy: fromJob.length > 0 ? 'job' : null }
}

function ownersOf(refs: AppRef[]): Owner[] {
  const bySystem = new Map<string, Owner>()
  for (const ref of refs) {
    const owner = bySystem.get(ref.system) ?? { system: ref.system, project: ref.project, applications: [], teams: ref.teams }
    if (!owner.applications.includes(ref.application)) owner.applications.push(ref.application)
    bySystem.set(ref.system, owner)
  }
  return [...bySystem.values()]
}

// ---- what ties a run to a person -----------------------------------------------------

const lower = (values: (string | null | undefined)[]) => [...new Set(values.filter((v): v is string => !!v?.trim()).map((v) => v.trim().toLowerCase()))]

/** Jenkins writes a person by the name its realm gives — login with some, display name with LDAP. */
function startedByCauses(me: Me): string[] {
  return lower([me.uid, me.name]).map((who) => `started by user ${who}`)
}

/** Every way a commit author may be the caller: login, display name, email. */
function identities(me: Me): string[] {
  return lower([me.uid, me.name, me.mail])
}

const targetOf = (owner: Owner): Target => ({ project: owner.project, teams: owner.teams })

function mayOperate(access: Access, owners: Owner[]): boolean {
  return can(access, 'jenkins.operate') || owners.some((owner) => can(access, 'jenkins.operate', targetOf(owner)))
}

type Context = {
  access: Access
  me: Me
  byName: Map<string, AppRef[]>
  decides: 'jenkins' | 'catalog'
  /** Jenkins grants reaching the caller (or everyone), by job. */
  reaches: Map<string, Reach[]>
}

/** Why a run (or queued item) is the caller's, and whether they may see and act on it. */
function judge(ctx: Context, item: { job: string; parameters: Parameter[]; causes: string[]; authors: string[] }) {
  const { refs, matchedBy } = resolve(ctx.byName, item.job, item.parameters)
  const owners = ownersOf(refs)
  const reasons: Reason[] = []
  const causes = new Set(item.causes.map((c) => c.toLowerCase()))
  const started = startedByCauses(ctx.me).some((c) => causes.has(c))
  if (started) reasons.push({ kind: 'started' })
  const mine = new Set(identities(ctx.me))
  if (!started && item.authors.some((a) => mine.has(a.toLowerCase()))) {
    // Who started it, when an account did — maika, usually; null for an SCM trigger or a timer.
    const by = item.causes.map((c) => /^Started by user (.+)$/i.exec(c)?.[1]).find(Boolean) ?? null
    reasons.push({ kind: 'commit', by })
  }

  const groups = new Set(ctx.access.groups.map((g) => g.toLowerCase()))
  const reaches = ctx.reaches.get(item.job) ?? []
  // Jenkins lets the caller read this job — needed for a team's run once Jenkins decides.
  const readable = ctx.decides === 'catalog' || reaches.length > 0
  for (const owner of owners) {
    for (const team of owner.teams) {
      if (groups.has(team.toLowerCase()) && readable && !reasons.some((r) => r.kind === 'team' && r.team.toLowerCase() === team.toLowerCase())) {
        reasons.push({ kind: 'team', team, project: owner.project })
      }
    }
  }
  // A grant on the job makes its runs the caller's only when the run names no
  // project: on a shared job, the grant says nothing about whose each run is.
  if (matchedBy !== 'parameters') {
    for (const reach of reaches) {
      if (reach.sid === EVERYONE_SID) continue
      const group = reach.sidType === 'group' || (reach.sidType === 'either' && groups.has(reach.sid.toLowerCase()))
      if (!reasons.some((r) => r.kind === 'jenkins' && r.sid === reach.sid)) reasons.push({ kind: 'jenkins', sid: reach.sid, group, via: reach.via })
    }
  }
  // A scoped binding names the run's project as surely as a team does.
  for (const grant of ctx.access.grants) {
    if (grant.permission !== 'jenkins.operate' || grant.scopeType === 'global' || !grant.scope) continue
    const scope = grant.scope.toLowerCase()
    const covers = owners.some((o) => (grant.scopeType === 'project' ? o.project.toLowerCase() === scope : o.teams.some((t) => t.toLowerCase() === scope)))
    if (covers && !reasons.some((r) => r.kind === 'scope' && r.via === grant.via)) reasons.push({ kind: 'scope', via: grant.via })
  }

  return {
    applications: [...new Set(refs.map((r) => r.application))],
    matchedBy,
    owners,
    reasons,
    personal: reasons.some((r) => r.kind === 'started' || r.kind === 'commit'),
    canOperate: mayOperate(ctx.access, owners),
  }
}

/** Jenkins decides once its rules have been read and name someone; until then, the catalog. */
async function whoDecides(): Promise<AccessState & { decides: 'jenkins' | 'catalog' }> {
  const state = await accessState()
  // Never read: start a read now, so the next look has it.
  if (!state.readAt && !state.error) void syncJenkinsAccess().catch(() => {})
  const decides = state.readAt && (state.source === 'role-strategy' || state.source === 'matrix') && state.grants > 0 ? 'jenkins' : 'catalog'
  return { ...state, decides }
}

async function context(access: Access, me: Me, jobs?: string[]): Promise<Context & { rules: AccessState & { decides: 'jenkins' | 'catalog' } }> {
  const [byName, rules, reaches] = await Promise.all([applications(), whoDecides(), grantsReaching(me.uid, access.groups, jobs)])
  const byJob = new Map<string, Reach[]>()
  for (const reach of reaches) byJob.set(reach.job, [...(byJob.get(reach.job) ?? []), reach])
  return { access, me, byName, decides: rules.decides, reaches: byJob, rules }
}

/** The names of applications whose runs could be the caller's team's — to narrow the query, not to decide. */
function teamApplicationNames(ctx: Context): string[] {
  const groups = new Set(ctx.access.groups.map((g) => g.toLowerCase()))
  const scopes = ctx.access.grants.filter((g) => g.permission === 'jenkins.operate' && g.scopeType !== 'global' && g.scope).map((g) => g.scope!.toLowerCase())
  const names: string[] = []
  for (const [name, refs] of ctx.byName) {
    if (refs.some((r) => r.teams.some((t) => groups.has(t.toLowerCase()) || scopes.includes(t.toLowerCase())) || scopes.includes(r.project.toLowerCase()))) names.push(name)
  }
  return names
}

// ---- the list ------------------------------------------------------------------------

/** The caller's runs in the window, newest first, and the pipelines they make up. */
export async function mine(access: Access, me: Me, window: RunWindow = '7d'): Promise<MyRuns> {
  const url = jenkinsConfig().url
  const [sync, ctx] = await Promise.all([syncState(), context(access, me)])
  const names = teamApplicationNames(ctx)

  // A wide net in SQL — started, authored, or naming one of the team's
  // applications in a parameter or the job — then the exact rules in code.
  const { rows } = await query<jenkins.RunRow & { authors: string[] }>(
    `select * from jenkins_builds
      where server = $1 and started_at >= now() - make_interval(hours => $2)
        and (exists (select 1 from unnest(causes) c where lower(c) = any($3))
          or exists (select 1 from unnest(authors) a where lower(a) = any($4))
          or job = any($5)
          or string_to_array(lower(job), '/') && $6::text[]
          or exists (select 1 from jsonb_array_elements(parameters) p
                      where not (p->>'hidden')::boolean
                        and (lower(p->>'value') = any($6)
                          or lower(regexp_replace(regexp_replace(p->>'value', '(\\.git)?/*$', ''), '^.*[/:]', '')) = any($6))))
      order by started_at desc, job, number desc
      limit $7`,
    [url, RUN_WINDOWS[window], startedByCauses(me), identities(me), [...ctx.reaches.keys()], names, RUN_LIMIT + 1],
  )
  const truncated = rows.length > RUN_LIMIT

  const runs: RunView[] = []
  for (const row of rows.slice(0, RUN_LIMIT)) {
    const run = jenkins.toRun(row)
    const verdict = judge(ctx, { job: run.job, parameters: run.parameters, causes: run.causes, authors: row.authors })
    if (verdict.reasons.length > 0) runs.push({ ...run, ...verdict, explanation: null })
  }

  // Why each failed run failed, where the AI has already said — one query for the lot.
  const ai = can(access, 'ai.chat') ? ollamaConfig() : undefined
  if (ai) {
    const kept = await explainer.keptFor(runs.filter((r) => r.result === 'failure' || r.result === 'unstable'))
    for (const run of runs) run.explanation = kept.get(`${run.job}#${run.number}`) ?? null
  }

  let queue: QueueView[] = []
  let queueError: string | null = null
  try {
    queue = (await jenkins.queueNow())
      .filter((item) => item.job !== null)
      .map((item) => ({ ...item, ...judge(ctx, { job: item.job!, parameters: item.parameters, causes: item.causes, authors: [] }) }))
      .filter((item) => item.reasons.length > 0)
  } catch (err) {
    queueError = err instanceof Error ? err.message : String(err)
  }

  return {
    url, sync, access: ctx.rules, window, runs, truncated, pipelines: pipelinesOf(runs, queue), queue, queueError,
    ai: ai === undefined ? null : { configured: ai !== null, model: ai?.model ?? null },
  }
}

/** A job's runs, split per project when its runs name one — so a shared job is a row per project. */
function pipelinesOf(runs: RunView[], queue: QueueView[]): PipelineView[] {
  const keyOf = (job: string, matchedBy: RunView['matchedBy'], applications: string[]) =>
    matchedBy === 'parameters' ? `${job}|${[...applications].sort().join(',')}` : job
  const groups = new Map<string, RunView[]>()
  for (const run of runs) {
    const key = keyOf(run.job, run.matchedBy, run.applications)
    groups.set(key, [...(groups.get(key) ?? []), run])
  }
  const waiting = new Set(queue.map((item) => keyOf(item.job!, item.parameters.length ? 'parameters' : null, item.applications)))
  const pipelines = [...groups.entries()].map(([key, list]): PipelineView => {
    const last = list[0]!
    const finished = list.filter((r) => r.result !== 'running' && r.result !== 'not_built')
    const reasons: Reason[] = []
    for (const r of list.flatMap((run) => run.reasons)) if (!reasons.some((seen) => JSON.stringify(seen) === JSON.stringify(r))) reasons.push(r)
    return {
      key,
      job: last.job,
      applications: last.matchedBy === 'parameters' ? last.applications : [],
      url: webUrl(last.job),
      owners: last.owners,
      reasons,
      last,
      recent: list.slice(0, RECENT).map((r) => ({ number: r.number, result: r.result, startedAt: r.startedAt })),
      running: list.some((r) => r.result === 'running'),
      inQueue: waiting.has(key) || waiting.has(last.job),
      finished: { builds: finished.length, passed: finished.filter((r) => r.result === 'success').length },
    }
  })
  const broken = (p: PipelineView) => {
    const done = p.recent.find((b) => b.result !== 'running' && b.result !== 'not_built')
    return done?.result === 'failure' || done?.result === 'unstable'
  }
  return pipelines.sort((a, b) => Number(broken(b)) - Number(broken(a)) || b.last.startedAt.localeCompare(a.last.startedAt) || a.key.localeCompare(b.key))
}

// ---- one run --------------------------------------------------------------------------

/**
 * What the caller may do with one run: see it, and act on it. A run history
 * does not hold yet (it started a moment ago) is judged by its job alone.
 */
export async function accessTo(access: Access, me: Me, job: string, number?: number): Promise<{ view: boolean; operate: boolean }> {
  const viewAll = can(access, 'jenkins.view')
  const mayView = viewAll || canSomewhere(access, 'pipelines.view')
  if (!mayView && !canSomewhere(access, 'jenkins.operate')) return { view: false, operate: false }

  const url = jenkinsConfig().url
  const ctx = await context(access, me, [job])
  const row =
    number === undefined
      ? undefined
      : (await query<jenkins.RunRow & { authors: string[] }>('select * from jenkins_builds where server = $1 and job = $2 and number = $3', [url, job, number])).rows[0]
  const verdict = judge(ctx, row ? { job, parameters: row.parameters, causes: row.causes, authors: row.authors } : { job, parameters: [], causes: [], authors: [] })
  return { view: viewAll || verdict.canOperate || (mayView && verdict.reasons.length > 0), operate: verdict.canOperate }
}

/**
 * Refuses unless the caller may act on this run. The route has already
 * refused anyone holding `jenkins.operate` nowhere; this is the per-run half.
 */
export async function demandOperate(access: Access, me: Me, job: string, number?: number): Promise<void> {
  if (!(await accessTo(access, me, job, number)).operate) {
    throw new ApiError(403, 'forbidden', `You may not run, stop or dequeue ${job} here — none of your bindings covers the team or project it is for.`)
  }
}

/** Refuses unless the caller may see this run. One that is not theirs reads as not found. */
export async function demandView(access: Access, me: Me, job: string, number: number): Promise<{ operate: boolean }> {
  const allowed = await accessTo(access, me, job, number)
  if (!allowed.view) throw new ApiError(404, 'pipeline_not_found', 'There is no run of yours by that name.')
  return { operate: allowed.operate }
}

export async function rebuild(access: Access, me: Me, job: string, number: number, actor: Actor) {
  await demandOperate(access, me, job, number)
  return jenkins.rebuild(job, number, actor)
}

export async function stop(access: Access, me: Me, job: string, number: number, actor: Actor) {
  await demandOperate(access, me, job, number)
  return jenkins.stop(job, number, actor)
}

/** A queued item is judged by what it will run with, like a run. */
export function cancel(access: Access, me: Me, id: number, actor: Actor) {
  return jenkins.cancel(id, actor, async (_job, item) => {
    const ctx = await context(access, me, [item.job ?? item.name])
    if (!judge(ctx, { job: item.job ?? item.name, parameters: item.parameters, causes: item.causes, authors: [] }).canOperate) {
      throw new ApiError(403, 'forbidden', `You may not take ${item.job ?? item.name} out of the queue — none of your bindings covers the team or project it is for.`)
    }
  })
}

// ---- a team's runs, for its weekly digest ----------------------------------------------

export type TeamRun = jenkins.Run & { applications: string[]; projects: string[]; endedAt: string }

/**
 * Every run in [from, to) that is for a project `team` owns — judged as My
 * pipelines judges a team's run: what its parameters name, else its job's
 * name; and, once Jenkins' rules are read, only on jobs Jenkins lets the team
 * (or everyone) read. Oldest first.
 */
export async function teamRuns(team: string, from: Date, to: Date): Promise<TeamRun[]> {
  const url = jenkinsConfig().url
  const [byName, rules] = await Promise.all([applications(), whoDecides()])
  const owned = (ref: AppRef) => ref.teams.some((t) => t.toLowerCase() === team.toLowerCase())
  const names = [...byName.entries()].filter(([, refs]) => refs.some(owned)).map(([name]) => name)
  if (names.length === 0) return []
  const { rows } = await query<jenkins.RunRow>(
    `select * from jenkins_builds
      where server = $1 and started_at >= $2 and started_at < $3
        and (string_to_array(lower(job), '/') && $4::text[]
          or exists (select 1 from jsonb_array_elements(parameters) p
                      where not (p->>'hidden')::boolean
                        and (lower(p->>'value') = any($4)
                          or lower(regexp_replace(regexp_replace(p->>'value', '(\\.git)?/*$', ''), '^.*[/:]', '')) = any($4))))
      order by started_at, job, number`,
    [url, from, to, names],
  )
  const readable = rules.decides === 'jenkins' ? new Set((await grantsReaching('', [team])).map((r) => r.job)) : null
  const runs: TeamRun[] = []
  for (const row of rows) {
    if (readable && !readable.has(row.job)) continue
    const run = jenkins.toRun(row)
    const refs = resolve(byName, run.job, run.parameters).refs.filter(owned)
    if (refs.length === 0) continue
    runs.push({
      ...run,
      applications: [...new Set(refs.map((r) => r.application))],
      projects: [...new Set(refs.map((r) => r.project))],
      endedAt: new Date(row.started_at.getTime() + Number(row.duration_ms)).toISOString(),
    })
  }
  return runs
}
