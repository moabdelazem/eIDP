import { ApiError } from '../../lib/errors.ts'
import { fullNameFromUrl, jenkinsConfig, jenkinsGet, jenkinsHead, jenkinsPost, jenkinsTail, jobPath } from './client.ts'

export { jenkinsConfig, jenkinsVersion } from './client.ts'
export { EVERYONE_SID, readAccess, parseMatrix, type AccessRules, type JobGrant, type SidType } from './access.ts'

/** A build's outcome, with a build still going as `running` rather than Jenkins' null. */
export type Result = 'success' | 'failure' | 'unstable' | 'aborted' | 'not_built' | 'running'

export type Build = {
  job: string
  number: number
  result: Result
  startedAt: string
  durationMs: number
  url: string
}

/** A job as the sweep sees it: enough to tell whether it has built since last time. */
export type JobHead = { fullName: string; url: string; buildable: boolean; inQueue: boolean; lastNumber: number | null }

export type QueueItem = {
  id: number
  job: string | null
  name: string
  url: string | null
  since: string
  why: string | null
  stuck: boolean
  blocked: boolean
  /** What it will run with — a shared job's say which project it is for. Secrets hidden. */
  parameters: Parameter[]
  causes: string[]
}

export type Agent = {
  name: string
  offline: boolean
  /** Taken offline on purpose, rather than lost. */
  temporarilyOffline: boolean
  reason: string | null
  executors: number
  busy: number
}

export type Parameter = { name: string; value: string | null; hidden: boolean }

/** A build as history keeps it: what ran, where, why, and with what. Secrets already hidden. */
export type HistoryBuild = Build & {
  builtOn: string | null
  causes: string[]
  parameters: Parameter[]
  /**
   * Who wrote the commits it built — each author's name, Jenkins user id and
   * email, as Jenkins knows them. A push builds as whoever triggered it (a
   * service account like maika); the author is the person it was for.
   */
  authors: string[]
}

export type Change = { commit: string | null; message: string; author: string | null }

/**
 * A pipeline stage. `branches` are the parallel branches it ran, each a
 * stage of its own (and may have its own) — only the Pipeline Graph View
 * plugin says; Stage View lists stages flat, so there they are always empty.
 */
export type Stage = { name: string; result: Result; startedAt: string | null; durationMs: number; agent: string | null; branches: Stage[] }

/** Where a build's stages came from: Pipeline Graph View (with parallel branches), Stage View (flat), or nowhere. */
export type StagesSource = 'graph' | 'stage-view' | null

export type BuildDetail = HistoryBuild & {
  changes: Change[]
  stages: Stage[]
  stagesFrom: StagesSource
  /** Why re-running it here is not possible, or null when it is. */
  notReplayable: string | null
}

type ChangeItems = { items?: { commitId?: string; msg?: string; authorEmail?: string; author?: { fullName?: string; absoluteUrl?: string } }[] }
type RawBuild = {
  changeSets?: ChangeItems[]
  changeSet?: ChangeItems
  number: number
  result: string | null
  timestamp: number
  duration: number
  building: boolean
  url: string
  builtOn?: string
  actions?: ({ parameters?: RawParameter[]; causes?: { shortDescription?: string }[] } | null)[]
}
type RawJob = {
  _class: string
  name: string
  fullName?: string
  url: string
  buildable?: boolean
  inQueue?: boolean
  lastBuild?: { number: number } | null
  jobs?: RawJob[]
}
type RawParameter = { _class?: string; name: string; value?: unknown }

const JOB = '_class,name,fullName,url,buildable,inQueue,lastBuild[number]'
/**
 * Three levels: a folder, a multibranch project inside it, its branches.
 * `tree` has no recursion, so deeper jobs are not seen.
 */
const JOBS_TREE = `jobs[${JOB},jobs[${JOB},jobs[${JOB}]]]`

/**
 * Every job that builds, flattened out of its folders — with only its last
 * build's number, so the sweep can tell which jobs have anything new and read
 * just those. One light call however many builds there are.
 */
export async function listJobs(): Promise<JobHead[]> {
  const { jobs = [] } = await jenkinsGet<{ jobs?: RawJob[] }>('api/json', { tree: JOBS_TREE })
  const found: JobHead[] = []
  const walk = (list: RawJob[], parent: string | null) => {
    for (const job of list) {
      const fullName = job.fullName ?? (parent ? `${parent}/${job.name}` : job.name)
      // Folders and multibranch projects hold jobs; only the leaves build.
      if (job.jobs) walk(job.jobs, fullName)
      else {
        found.push({
          fullName,
          url: job.url,
          buildable: job.buildable ?? true,
          inQueue: job.inQueue ?? false,
          lastNumber: job.lastBuild?.number ?? null,
        })
      }
    }
  }
  walk(jobs, null)
  return found
}

const CHANGE_ITEMS = 'items[commitId,msg,authorEmail,author[fullName,absoluteUrl]]'
/** A pipeline has changeSets, a freestyle job changeSet; Jenkins ignores the one a build lacks. */
const CHANGES = `changeSets[${CHANGE_ITEMS}],changeSet[${CHANGE_ITEMS}]`
const BUILD = `number,result,timestamp,duration,building,url,builtOn,actions[parameters[_class,name,value],causes[shortDescription]],${CHANGES}`

/** The newest `count` builds of one job, newest first, as history keeps them. */
export async function jobBuilds(job: string, count: number): Promise<HistoryBuild[]> {
  const { builds = [] } = await jenkinsGet<{ builds?: RawBuild[] }>(`${jobPath(job)}/api/json`, {
    tree: `builds[${BUILD}]{0,${count}}`,
  })
  return builds.map((raw) => toHistory(job, raw))
}

function toHistory(job: string, raw: RawBuild): HistoryBuild {
  const actions = (raw.actions ?? []).filter((a) => a !== null)
  return {
    ...toBuild(job, raw),
    // Only freestyle builds report builtOn, and "" there means the built-in
    // node. A Pipeline run never has it: see `pipelineAgents`.
    builtOn: raw.builtOn === '' ? BUILT_IN : raw.builtOn || null,
    causes: actions.flatMap((a) => (a.causes ?? []).map((c) => c.shortDescription ?? '')).filter(Boolean),
    parameters: actions.flatMap((a) => a.parameters ?? []).map(maskParameter),
    authors: authorsOf(raw),
  }
}

function changeItems(raw: RawBuild) {
  return [...(raw.changeSets ?? []), ...(raw.changeSet ? [raw.changeSet] : [])].flatMap((set) => set.items ?? [])
}

/** Every way Jenkins names each commit's author, once each: name, user id, email. */
function authorsOf(raw: RawBuild): string[] {
  const names = new Map<string, string>()
  for (const item of changeItems(raw)) {
    const id = /\/user\/([^/]+)\/?$/.exec(item.author?.absoluteUrl ?? '')?.[1]
    for (const name of [item.author?.fullName, id ? decodeURIComponent(id) : undefined, item.authorEmail]) {
      if (name?.trim()) names.set(name.trim().toLowerCase(), name.trim())
    }
  }
  return [...names.values()]
}

function maskParameter(p: RawParameter): Parameter {
  const hidden = isSecret(p)
  return {
    name: p.name,
    value: hidden ? '[hidden]' : p.value === undefined || p.value === null ? null : String(p.value),
    hidden,
  }
}

export async function listQueue(): Promise<QueueItem[]> {
  const { items = [] } = await jenkinsGet<{
    items?: {
      id: number
      inQueueSince: number
      why?: string | null
      stuck?: boolean
      blocked?: boolean
      task?: { name?: string; url?: string }
      actions?: RawBuild['actions']
    }[]
  }>('queue/api/json', { tree: 'items[id,inQueueSince,why,stuck,blocked,task[name,url],actions[parameters[_class,name,value],causes[shortDescription]]]' })
  return items.map((item) => ({
    id: item.id,
    job: item.task?.url ? fullNameFromUrl(item.task.url) : null,
    name: item.task?.name ?? `Item ${item.id}`,
    url: item.task?.url ?? null,
    since: new Date(item.inQueueSince).toISOString(),
    why: item.why ?? null,
    stuck: item.stuck ?? false,
    blocked: item.blocked ?? false,
    parameters: (item.actions ?? []).flatMap((a) => a?.parameters ?? []).map(maskParameter),
    causes: (item.actions ?? []).flatMap((a) => (a?.causes ?? []).map((c) => c.shortDescription ?? '')).filter(Boolean),
  }))
}

export async function listAgents(): Promise<Agent[]> {
  const { computer = [] } = await jenkinsGet<{
    computer?: {
      displayName: string
      offline: boolean
      temporarilyOffline?: boolean
      offlineCauseReason?: string
      numExecutors: number
      executors?: { idle: boolean }[]
    }[]
  }>('computer/api/json', {
    tree: 'computer[displayName,offline,temporarilyOffline,offlineCauseReason,numExecutors,executors[idle]]',
  })
  return computer.map((c) => ({
    name: c.displayName,
    offline: c.offline,
    temporarilyOffline: c.temporarilyOffline ?? false,
    reason: c.offlineCauseReason || null,
    executors: c.numExecutors,
    busy: (c.executors ?? []).filter((e) => !e.idle).length,
  }))
}

/**
 * One build in full: what started it, where it ran, what it was given, the
 * commits it built, its pipeline stages, and whether it can be run again.
 */
export async function buildDetail(job: string, number: number): Promise<BuildDetail> {
  const [raw, { stages, from }] = await Promise.all([jenkinsGet<RawBuild>(`${jobPath(job)}/${number}/api/json`, { tree: BUILD }), pipelineStages(job, number)])
  const rawParameters = (raw.actions ?? []).flatMap((a) => a?.parameters ?? [])
  const history = toHistory(job, raw)
  const agents = [...new Set(everyStage(stages).flatMap((stage) => (stage.agent ? [stage.agent] : [])))]
  return {
    ...history,
    builtOn: history.builtOn ?? (agents.length ? agents.join(', ') : null),
    changes: changeItems(raw).map((item) => ({ commit: item.commitId ?? null, message: (item.msg ?? '').trim(), author: item.author?.fullName ?? null })),
    stages,
    stagesFrom: from,
    notReplayable: notReplayable(rawParameters),
  }
}

/** Every stage and branch, depth first. */
export function everyStage(stages: Stage[]): Stage[] {
  return stages.flatMap((stage) => [stage, ...everyStage(stage.branches)])
}

/**
 * A pipeline's stages, from the Pipeline Graph View plugin when the server
 * has it — the only one that says which stages ran in parallel — else from
 * Stage View's flat list. A freestyle job has neither: no stages.
 */
async function pipelineStages(job: string, number: number): Promise<{ stages: Stage[]; from: StagesSource }> {
  const graph = await graphStages(job, number)
  if (graph) return { stages: graph, from: 'graph' }
  const flat = await buildStages(job, number)
  return { stages: flat, from: flat.length ? 'stage-view' : null }
}

type RawGraphStage = {
  name?: string
  title?: string
  state?: string
  type?: string
  startTimeMillis?: number | string
  totalDurationMillis?: number | string
  agent?: string | null
  synthetic?: boolean
  children?: RawGraphStage[]
}

/** The Pipeline Graph View plugin's tree (`pipeline-graph/tree`), or null when the server has no such plugin. */
async function graphStages(job: string, number: number): Promise<Stage[] | null> {
  let tree: { data?: { stages?: RawGraphStage[] }; stages?: RawGraphStage[] }
  try {
    tree = await jenkinsGet(`${jobPath(job)}/${number}/pipeline-graph/tree`)
  } catch (err) {
    if (err instanceof ApiError && err.code === 'jenkins_not_found') return null
    throw err
  }
  const stages = tree.data?.stages ?? tree.stages
  if (!Array.isArray(stages)) return null
  const toStage = (raw: RawGraphStage): Stage => {
    const started = Number(raw.startTimeMillis)
    return {
      name: raw.name ?? raw.title ?? 'Unnamed',
      result: graphResult(raw.state ?? ''),
      startedAt: started > 0 ? new Date(started).toISOString() : null,
      durationMs: Number(raw.totalDurationMillis) || 0,
      agent: raw.agent || null,
      // Synthetic stages are the plugin's own wrappers ("Declarative: Post Actions" stays; its "Parallel" block does not).
      branches: (raw.children ?? []).filter((child) => !child.synthetic).map(toStage),
    }
  }
  return stages.filter((raw) => !raw.synthetic).map(toStage)
}

function graphResult(state: string): Result {
  switch (state.toLowerCase()) {
    case 'success':
      return 'success'
    case 'failure':
      return 'failure'
    case 'unstable':
      return 'unstable'
    case 'aborted':
      return 'aborted'
    case 'running':
    case 'paused':
    case 'queued':
      return 'running'
    default:
      return 'not_built'
  }
}

/**
 * A pipeline's stages from the Stage View plugin's `wfapi`. Not every server
 * has it, and a freestyle job has no stages: either way, none.
 */
async function buildStages(job: string, number: number): Promise<Stage[]> {
  type Raw = { stages?: { name: string; status: string; startTimeMillis?: number; durationMillis?: number; execNode?: string }[] }
  let described: Raw
  try {
    described = await jenkinsGet<Raw>(`${jobPath(job)}/${number}/wfapi/describe`)
  } catch (err) {
    if (err instanceof ApiError && err.code === 'jenkins_not_found') return []
    throw err
  }
  return (described.stages ?? []).map((stage) => ({
    name: stage.name,
    result: stageResult(stage.status),
    startedAt: stage.startTimeMillis ? new Date(stage.startTimeMillis).toISOString() : null,
    durationMs: stage.durationMillis ?? 0,
    // Stage View names the agent a stage ran on; "" is the built-in node, or
    // a stage that never reached one.
    agent: stage.execNode || null,
    branches: [],
  }))
}

/** How the portal names Jenkins' own node, wherever Jenkins leaves it blank. */
export const BUILT_IN = 'built-in'
/** Enough of a log's start to hold its "Running on" lines. */
const LOG_HEAD_BYTES = 64 * 1024

/**
 * The agents a Pipeline run ran on. Jenkins reports `builtOn` only for
 * freestyle builds, so for a Pipeline it comes from the stages' `execNode`
 * (Stage View), else from the log's "Running on <agent> in <workspace>" lines
 * — read from its start only. Empty when neither says.
 */
export async function pipelineAgents(job: string, number: number): Promise<string[]> {
  const fromStages = (await buildStages(job, number)).flatMap((s) => (s.agent ? [s.agent] : []))
  if (fromStages.length > 0) return [...new Set(fromStages)]
  let head: string
  try {
    head = await jenkinsHead(`${jobPath(job)}/${number}/consoleText`, LOG_HEAD_BYTES)
  } catch (err) {
    if (err instanceof ApiError && err.code === 'jenkins_not_found') return []
    throw err
  }
  return agentsInLog(head)
}

/** "Running on linux-02 in /var/…" → linux-02; Jenkins' own node reads "Running on Jenkins". */
export function agentsInLog(log: string): string[] {
  const names = [...log.matchAll(/^Running on (.+?) in \S/gm)].map((m) => (m[1] === 'Jenkins' ? BUILT_IN : m[1]!.trim()))
  return [...new Set(names)]
}

function stageResult(status: string): Result {
  switch (status) {
    case 'SUCCESS':
      return 'success'
    case 'FAILED':
      return 'failure'
    case 'UNSTABLE':
      return 'unstable'
    case 'ABORTED':
      return 'aborted'
    case 'IN_PROGRESS':
    case 'PAUSED_PENDING_INPUT':
      return 'running'
    default:
      return 'not_built'
  }
}

/** The parameters a build ran with, as Jenkins would take them back. Null for an unparameterised build. */
export async function replayParameters(job: string, number: number): Promise<URLSearchParams | null> {
  const raw = await jenkinsGet<{ actions?: ({ parameters?: RawParameter[] } | null)[] }>(`${jobPath(job)}/${number}/api/json`, {
    tree: 'actions[parameters[_class,name,value]]',
  })
  const parameters = (raw.actions ?? []).flatMap((a) => a?.parameters ?? [])
  const refusal = notReplayable(parameters)
  if (refusal) throw new ApiError(409, 'jenkins_not_replayable', refusal)
  if (parameters.length === 0) return null
  return new URLSearchParams(parameters.map((p) => [p.name, String(p.value)]))
}

/**
 * A password is never sent back by Jenkins and a file is not kept, so a build
 * with either cannot be repeated faithfully. Running it with those blank would
 * be a different build wearing the old one's name — it is refused instead.
 */
function notReplayable(parameters: RawParameter[]): string | null {
  const password = parameters.find((p) => p._class?.includes('PasswordParameterValue'))
  if (password) return `It has a password parameter (${password.name}), which Jenkins does not give back. Run it in Jenkins.`
  const other = parameters.find((p) => p.value === undefined || p.value === null || typeof p.value === 'object')
  if (other) return `Its ${other.name} parameter cannot be sent again from here. Run it in Jenkins.`
  return null
}

/**
 * Hidden from the page, like the inventories parser does: Jenkins keeps
 * passwords itself, but a secret passed as a plain string parameter is still a
 * secret to people who could not see it in Jenkins.
 */
function isSecret(p: RawParameter): boolean {
  return Boolean(p._class?.includes('PasswordParameterValue')) || /pass|secret|token|credential|api[-_]?key/i.test(p.name)
}

/** The end of a build's console log, where a failure says why. */
export function logTail(job: string, number: number, maxBytes = LOG_TAIL_BYTES) {
  return jenkinsTail(`${jobPath(job)}/${number}/consoleText`, maxBytes)
}

/** Queues a build, with parameters when given. Returns the queue item Jenkins made, when it says. */
export async function triggerBuild(job: string, parameters: URLSearchParams | null): Promise<{ queueId: number | null }> {
  const res = await jenkinsPost(`${jobPath(job)}/${parameters ? 'buildWithParameters' : 'build'}`, parameters ?? undefined)
  const location = res.headers.get('location') ?? ''
  const id = /\/queue\/item\/(\d+)/.exec(location)?.[1]
  return { queueId: id ? Number(id) : null }
}

/** Asks a running build to stop. Jenkins aborts it at the next point it can. */
export async function stopBuild(job: string, number: number): Promise<void> {
  await jenkinsPost(`${jobPath(job)}/${number}/stop`)
}

export async function cancelQueueItem(id: number): Promise<void> {
  await jenkinsPost('queue/cancelItem', undefined, { id })
}

/** Where a person would open this in Jenkins. */
export function webUrl(job?: string, number?: number): string {
  const { url } = jenkinsConfig()
  if (!job) return url
  return `${url}/${jobPath(job)}/${number === undefined ? '' : `${number}/`}`
}

/** How much of a log the build page shows: the end, where failures explain themselves. */
export const LOG_TAIL_BYTES = 256 * 1024

function toBuild(job: string, raw: RawBuild): Build {
  return {
    job,
    number: raw.number,
    result: raw.building ? 'running' : resultOf(raw.result),
    startedAt: new Date(raw.timestamp).toISOString(),
    durationMs: raw.duration,
    url: raw.url,
  }
}

function resultOf(result: string | null): Result {
  switch (result) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
      return 'failure'
    case 'UNSTABLE':
      return 'unstable'
    case 'ABORTED':
      return 'aborted'
    default:
      return 'not_built'
  }
}
