import { api } from '@/lib/api-client.ts'

// The JSON's shapes are the API's, from @eidp/contracts — one definition, so the two cannot drift.
import type { AuditEntry, Category, Explanation, IgnoreFor, Overview, ParameterFacet, Run, RunDetail, RunQuery, Stats, SyncState, Window } from '@eidp/contracts/jenkins'
export type { Agent, AuditEntry, Bucket, Category, Explanation, Failure, Ignore, IgnoreFor, Overview, Parameter, ParameterFacet, QueueItem, Recovery, Result, Run, RunDetail, RunQuery, Stage, Stats, SyncState, Totals, Window } from '@eidp/contracts/jenkins'

export const IGNORE_FOR_LABEL: Record<IgnoreFor, string> = {
  pass: 'Until it passes again',
  '1d': 'For a day',
  '7d': 'For a week',
  '30d': 'For 30 days',
  always: 'Until someone stops ignoring it',
}

export const WINDOW_LABEL: Record<Window, string> = { '24h': 'Last 24 hours', '7d': 'Last 7 days' }

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
