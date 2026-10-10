/** Jenkins: what `/jenkins` sends (apps/api services/jenkins.ts, jenkins-sync.ts, build-explainer.ts, integrations/jenkins). A build still going is `running`. */

/** From the API's services/jenkins.ts. A build still going is `running`. */
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
