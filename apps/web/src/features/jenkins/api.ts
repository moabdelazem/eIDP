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
  /** The model's one line on the latest failure, for people who may read explanations. */
  explanation: { summary: string; category: Category } | null
  /** Set aside on purpose: who, why, until when. */
  ignored: Ignore | null
}

export type Ignore = { reason: string; by: string; byName: string; at: string; untilPass: boolean; expiresAt: string | null }

/** How long an ignore holds. */
export type IgnoreFor = 'pass' | '1d' | '7d' | '30d' | 'always'
export const IGNORE_FOR_LABEL: Record<IgnoreFor, string> = {
  pass: 'Until it passes again',
  '1d': 'For a day',
  '7d': 'For a week',
  '30d': 'For 30 days',
  always: 'Until someone stops ignoring it',
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
  /** What it will run with — a shared job's say which project it is for. */
  parameters: Parameter[]
  causes: string[]
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
  counts: { jobs: number; failing: number; ignored: number; running: number; queued: number; agentsOffline: number }
  /** Failing and not ignored. */
  failures: Failure[]
  /** Failing, but set aside on purpose. */
  ignored: Failure[]
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

export type Bucket = {
  at: string
  success: number
  failure: number
  unstable: number
  aborted: number
  successRate: number | null
  /** Typical and slow-tail time of the builds that finished in the bucket. */
  p50Ms: number | null
  p95Ms: number | null
}

/** From a job breaking to its next pass. */
export type Recovery = { fixes: number; medianMs: number | null; longestMs: number | null }

export type Stats = {
  window: Window
  from: string
  to: string
  current: Totals
  previous: Totals
  running: number
  timeline: Bucket[]
  topFailing: { job: string; builds: number; broken: number; rate: number; lastBroken: string; ignored: boolean }[]
  slowest: { job: string; builds: number; p50Ms: number; p95Ms: number }[]
  recovery: { current: Recovery; previous: Recovery }
  agents: { agent: string; builds: number; broken: number; busyMs: number }[]
  triggers: { trigger: string; builds: number }[]
  /** The model's categories for failed builds — its reading, not a fact. */
  categories: { category: Category; builds: number }[]
}

export type ParameterFacet = { name: string; builds: number; values: { value: string; builds: number }[] }

/** A pipeline stage; `branches` are what it ran in parallel (Pipeline Graph View only). */
export type Stage = { name: string; result: Result; startedAt: string | null; durationMs: number; agent: string | null; branches: Stage[] }

export type RunDetail = Run & {
  changes: { commit: string | null; message: string; author: string | null }[]
  stages: Stage[]
  /** Pipeline Graph View (with parallel branches), Stage View (flat), or none. */
  stagesFrom: 'graph' | 'stage-view' | null
  notReplayable: string | null
  log: string
  logTruncated: boolean
  logUrl: string
  /** Whether the caller may run it again or stop it — worked out per job, since an operator may be bound to one team. */
  canOperate: boolean
}

export type Category = 'test_failure' | 'compilation' | 'dependency' | 'infrastructure' | 'configuration' | 'permission' | 'timeout' | 'flaky' | 'unknown'

/** How a failure category reads. */
export const CATEGORY: Record<Category, string> = {
  test_failure: 'Test failure',
  compilation: 'Compilation',
  dependency: 'Dependency',
  infrastructure: 'Infrastructure',
  configuration: 'Configuration',
  permission: 'Permission',
  timeout: 'Timeout',
  flaky: 'Looks flaky',
  unknown: 'Unclear',
}

/** A model's explanation of a failed build, from services/build-explainer.ts. */
export type Explanation = {
  summary: string
  cause: string
  category: Category
  confidence: 'low' | 'medium' | 'high'
  evidence: { line: number; text: string }[]
  nextSteps: string[]
  model: string
  createdAt: string
  createdByName: string
  durationMs: number
  trimmed: boolean
  /** Made by the automatic run when the build failed. */
  automatic: boolean
}

export type AuditEntry = {
  id: number
  at: string
  actor: string
  actorName: string
  action: 'rebuild' | 'stop' | 'cancel' | 'ignore' | 'unignore'
  /** The reason given, for an ignore. */
  note: string | null
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
  /** The kept explanation, if any, and whether the AI is set up to make one. */
  explanation: (job: string, number: number) =>
    api<{
      ai: { configured: boolean; model: string | null }
      explanation: Explanation | null
      /** `queued`: being explained without anyone asking. `failed`: the automatic try did not work, and why. */
      auto: { state: 'queued' | 'failed' | 'off'; error: string | null }
    }>(`/jenkins/explain?${params({ job, number })}`),
  /** Asks the model — or returns the kept answer unless `fresh`. */
  explain: (job: string, number: number, fresh = false) => post('/jenkins/explain', { job, number, fresh }) as Promise<Explanation>,
  /** Pull build history from Jenkins now instead of waiting for the timer. */
  sync: () => post('/jenkins/sync') as Promise<SyncState>,
  rebuild: (job: string, number: number) => post('/jenkins/rebuild', { job, number }),
  stop: (job: string, number: number) => post('/jenkins/stop', { job, number }),
  cancel: (id: number) => post(`/jenkins/queue/${id}/cancel`),
  ignore: (job: string, until: IgnoreFor, reason: string) => post('/jenkins/ignore', { job, until, reason }),
  unignore: (job: string) => post('/jenkins/unignore', { job }),
}

/**
 * Where a build's own page is. The job carries folders, so it rides in the
 * query. The same page opens under My pipelines for people without the
 * Jenkins page, so the trail and the sidebar stay where they came from.
 */
export function buildPath(build: { job: string; number: number }, base: '/jenkins' | '/pipelines' = '/jenkins'): string {
  return `${base}/build?${params({ job: build.job, number: build.number })}`
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
