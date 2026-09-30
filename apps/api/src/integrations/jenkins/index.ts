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

export type Job = { fullName: string; url: string; buildable: boolean; inQueue: boolean; builds: Build[] }

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

export type BuildDetail = Build & {
  causes: string[]
  parameters: Parameter[]
  /** Why re-running it here is not possible, or null when it is. */
  notReplayable: string | null
}

type RawBuild = { number: number; result: string | null; timestamp: number; duration: number; building: boolean; url: string }
type RawJob = {
  _class: string
  name: string
  fullName?: string
  url: string
  buildable?: boolean
  inQueue?: boolean
  builds?: RawBuild[]
  jobs?: RawJob[]
}
type RawParameter = { _class?: string; name: string; value?: unknown }

/** How many recent builds per job are read — enough to tell a streak from a blip. */
export const BUILDS_PER_JOB = 10

const JOB = `_class,name,fullName,url,buildable,inQueue,builds[number,result,timestamp,duration,building,url]{0,${BUILDS_PER_JOB}}`
/**
 * Three levels: a folder, a multibranch project inside it, its branches.
 * `tree` has no recursion, so deeper jobs are not seen.
 */
const JOBS_TREE = `jobs[${JOB},jobs[${JOB},jobs[${JOB}]]]`

/** Every job that builds, flattened out of its folders, with its recent builds. */
export async function listJobs(): Promise<Job[]> {
  const { jobs = [] } = await jenkinsGet<{ jobs?: RawJob[] }>('api/json', { tree: JOBS_TREE })
  const found: Job[] = []
  const walk = (list: RawJob[], parent: string | null) => {
    for (const job of list) {
      const fullName = job.fullName ?? (parent ? `${parent}/${job.name}` : job.name)
      // Folders and multibranch projects hold jobs; only the leaves build.
      if (job.jobs) walk(job.jobs, fullName)
      else if (job.builds) {
        found.push({
          fullName,
          url: job.url,
          buildable: job.buildable ?? true,
          inQueue: job.inQueue ?? false,
          builds: job.builds.map((build) => toBuild(fullName, build)),
        })
      }
    }
  }
  walk(jobs, null)
  return found
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

/** One build: what started it, what it was given, and whether it can be run again from here. */
export async function buildDetail(job: string, number: number): Promise<BuildDetail> {
  const raw = await jenkinsGet<RawBuild & { actions?: ({ parameters?: RawParameter[]; causes?: { shortDescription?: string }[] } | null)[] }>(
    `${jobPath(job)}/${number}/api/json`,
    { tree: 'number,result,timestamp,duration,building,url,actions[parameters[_class,name,value],causes[shortDescription]]' },
  )
  const actions = (raw.actions ?? []).filter((a) => a !== null)
  const rawParameters = actions.flatMap((a) => a.parameters ?? [])
  return {
    ...toBuild(job, raw),
    causes: actions.flatMap((a) => (a.causes ?? []).map((c) => c.shortDescription ?? '')).filter(Boolean),
    parameters: rawParameters.map((p) => ({
      name: p.name,
      value: isSecret(p) ? '[hidden]' : p.value === undefined || p.value === null ? null : String(p.value),
      hidden: isSecret(p),
    })),
    notReplayable: notReplayable(rawParameters),
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
export function logTail(job: string, number: number, maxBytes = 64 * 1024) {
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
