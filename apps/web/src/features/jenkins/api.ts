import { api } from '@/lib/api-client.ts'

/** Mirrors the API's services/jenkins.ts. A build still going is `running`. */
export type Result = 'success' | 'failure' | 'unstable' | 'aborted' | 'not_built' | 'running'

export type Build = { job: string; number: number; result: Result; startedAt: string; durationMs: number; url: string }

export type Failure = {
  job: string
  url: string
  last: Build
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

export type Overview = {
  url: string
  fetchedAt: string
  counts: { jobs: number; failing: number; running: number; queued: number; agentsOffline: number }
  failures: Failure[]
  runs: Build[]
  queue: QueueItem[]
  agents: Agent[]
}

export type Run = Build & {
  causes: string[]
  parameters: { name: string; value: string | null; hidden: boolean }[]
  notReplayable: string | null
  log: string
  logTruncated: boolean
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

const post = (path: string, body?: unknown) =>
  api<unknown>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export const jenkinsApi = {
  /** `fresh` skips the API's 15-second cache — the Refresh button. */
  overview: (fresh = false) => api<Overview>(`/jenkins${fresh ? '?fresh=1' : ''}`),
  run: (job: string, number: number) =>
    api<Run>(`/jenkins/run?${new URLSearchParams({ job, number: String(number) })}`),
  audit: () => api<AuditEntry[]>('/jenkins/audit'),
  rebuild: (job: string, number: number) => post('/jenkins/rebuild', { job, number }),
  stop: (job: string, number: number) => post('/jenkins/stop', { job, number }),
  cancel: (id: number) => post(`/jenkins/queue/${id}/cancel`),
}

/** "1m 32s" — build durations are read at a glance, not to the millisecond. */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
