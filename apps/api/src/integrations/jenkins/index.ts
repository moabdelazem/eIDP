import { ApiError } from '../../lib/errors.ts'
import { fullNameFromUrl, jenkinsConfig, jenkinsGet, jenkinsPost, jenkinsTail, jobPath } from './client.ts'

export { jenkinsConfig } from './client.ts'

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
export type HistoryBuild = Build & { builtOn: string | null; causes: string[]; parameters: Parameter[] }

export type Change = { commit: string | null; message: string; author: string | null }

/** A pipeline stage, from the Pipeline Stage View plugin when the server has it. */
export type Stage = { name: string; result: Result; startedAt: string | null; durationMs: number }

export type BuildDetail = HistoryBuild & {
  changes: Change[]
  stages: Stage[]
  /** Why re-running it here is not possible, or null when it is. */
  notReplayable: string | null
}

type RawBuild = {
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

const BUILD = 'number,result,timestamp,duration,building,url,builtOn,actions[parameters[_class,name,value],causes[shortDescription]]'

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
    builtOn: raw.builtOn || null,
    causes: actions.flatMap((a) => (a.causes ?? []).map((c) => c.shortDescription ?? '')).filter(Boolean),
    parameters: actions.flatMap((a) => a.parameters ?? []).map(maskParameter),
  }
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
    items?: { id: number; inQueueSince: number; why?: string | null; stuck?: boolean; blocked?: boolean; task?: { name?: string; url?: string } }[]
  }>('queue/api/json', { tree: 'items[id,inQueueSince,why,stuck,blocked,task[name,url]]' })
  return items.map((item) => ({
    id: item.id,
    job: item.task?.url ? fullNameFromUrl(item.task.url) : null,
    name: item.task?.name ?? `Item ${item.id}`,
    url: item.task?.url ?? null,
    since: new Date(item.inQueueSince).toISOString(),
    why: item.why ?? null,
    stuck: item.stuck ?? false,
    blocked: item.blocked ?? false,
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
  type Items = { items?: { commitId?: string; msg?: string; author?: { fullName?: string } }[] }
  const [raw, stages] = await Promise.all([
    jenkinsGet<RawBuild & { changeSets?: Items[]; changeSet?: Items }>(`${jobPath(job)}/${number}/api/json`, {
      // A pipeline has changeSets, a freestyle job changeSet; Jenkins ignores the one a build lacks.
      tree: `${BUILD},changeSets[items[commitId,msg,author[fullName]]],changeSet[items[commitId,msg,author[fullName]]]`,
    }),
    buildStages(job, number),
  ])
  const sets = [...(raw.changeSets ?? []), ...(raw.changeSet ? [raw.changeSet] : [])]
  const rawParameters = (raw.actions ?? []).flatMap((a) => a?.parameters ?? [])
  return {
    ...toHistory(job, raw),
    changes: sets.flatMap((set) =>
      (set.items ?? []).map((item) => ({ commit: item.commitId ?? null, message: (item.msg ?? '').trim(), author: item.author?.fullName ?? null })),
    ),
    stages,
    notReplayable: notReplayable(rawParameters),
  }
}

/**
 * A pipeline's stages from the Stage View plugin's `wfapi`. Not every server
 * has it, and a freestyle job has no stages: either way, none.
 */
async function buildStages(job: string, number: number): Promise<Stage[]> {
  type Raw = { stages?: { name: string; status: string; startTimeMillis?: number; durationMillis?: number }[] }
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
  }))
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
