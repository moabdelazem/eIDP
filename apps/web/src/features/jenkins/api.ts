import { api } from '@/lib/api-client.ts'

/** Mirrors the API's services/jenkins.ts. A build still going is `running`. */
export type Result = 'success' | 'failure' | 'unstable' | 'aborted' | 'not_built' | 'running'

export type Parameter = { name: string; value: string | null; hidden: boolean }

/** A build as history holds it. */
export type Run = {
  job: string
  number: number
  result: Result
  startedAt: string
  durationMs: number
  url: string
  builtOn: string | null
  causes: string[]
  parameters: Parameter[]
}

export type Failure = {
  job: string
  url: string
  last: Run
  streak: number
  streakAtLeast: boolean
  since: string
  lastSuccess: string | null
  running: boolean
  inQueue: boolean
}

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
  temporarilyOffline: boolean
  reason: string | null
  executors: number
  busy: number
}

export type SyncState = {
  startedAt: string | null
  finishedAt: string | null
  ok: boolean
  error: string | null
  builds: number
  jobsRead: number
}

export type Overview = {
  url: string
  sync: SyncState
  counts: { jobs: number; failing: number; running: number; queued: number; agentsOffline: number }
  failures: Failure[]
  queue: QueueItem[]
  agents: Agent[]
}

export type Window = '24h' | '7d'
export const WINDOW_LABEL: Record<Window, string> = { '24h': 'Last 24 hours', '7d': 'Last 7 days' }

export type Totals = {
  builds: number
  success: number
  failure: number
  unstable: number
  aborted: number
  successRate: number | null
  p50Ms: number | null
  p95Ms: number | null
  jobs: number
}

export type Bucket = { at: string; success: number; failure: number; unstable: number; aborted: number; successRate: number | null }

export type Stats = {
  window: Window
  from: string
  to: string
  current: Totals
  previous: Totals
  running: number
  timeline: Bucket[]
  topFailing: { job: string; builds: number; broken: number; rate: number; lastBroken: string }[]
  slowest: { job: string; builds: number; p50Ms: number; p95Ms: number }[]
}

export type ParameterFacet = { name: string; builds: number; values: { value: string; builds: number }[] }

export type Stage = { name: string; result: Result; startedAt: string | null; durationMs: number }

export type RunDetail = Run & {
  changes: { commit: string | null; message: string; author: string | null }[]
  stages: Stage[]
  notReplayable: string | null
  log: string
  logTruncated: boolean
  logUrl: string
}

export type AuditEntry = {
  id: number
  at: string
  actor: string
  actorName: string
  action: 'rebuild' | 'stop' | 'cancel'
  job: string
  build: number | null
  queueId: number | null
  ok: boolean
  error: string | null
}

export type RunQuery = { window: Window; q?: string; result?: Result; limit: number; offset: number }

const post = (path: string, body?: unknown) =>
  api<unknown>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

const params = (values: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined && v !== '') as [string, string][])

export const jenkinsApi = {
  /** `fresh` asks Jenkins for the queue and agents now rather than from the 15-second cache. */
  overview: (fresh = false) => api<Overview>(`/jenkins${fresh ? '?fresh=1' : ''}`),
  stats: (window: Window) => api<Stats>(`/jenkins/stats?window=${window}`),
  runs: (query: RunQuery) => api<{ total: number; runs: Run[] }>(`/jenkins/runs?${params(query)}`),
  parameters: (window: Window) => api<ParameterFacet[]>(`/jenkins/parameters?window=${window}`),
  run: (job: string, number: number) => api<RunDetail>(`/jenkins/run?${params({ job, number })}`),
  audit: () => api<AuditEntry[]>('/jenkins/audit'),
  /** Pull build history from Jenkins now instead of waiting for the timer. */
  sync: () => post('/jenkins/sync') as Promise<SyncState>,
  rebuild: (job: string, number: number) => post('/jenkins/rebuild', { job, number }),
  stop: (job: string, number: number) => post('/jenkins/stop', { job, number }),
  cancel: (id: number) => post(`/jenkins/queue/${id}/cancel`),
}

/** Where a build's own page is. The job carries folders, so it rides in the query. */
export function buildPath(build: { job: string; number: number }): string {
  return `/jenkins/build?${params({ job: build.job, number: build.number })}`
}

/** "1m 32s" — build durations are read at a glance, not to the millisecond. */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** "92%" — whole percent is what anyone reads a success rate to. */
export function percent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}
