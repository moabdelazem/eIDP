import { api } from '@/lib/api-client.ts'

// The JSON's shapes are the API's, from @eidp/contracts — one definition, so the two cannot drift.
import type { Result } from '@eidp/contracts/jenkins'
import type { MyRuns, PipelineView, QueueView, Reason, RunView, RunWindow } from '@eidp/contracts/pipelines'
export type { Brief, MyRuns, Owner, Reason, RunWindow } from '@eidp/contracts/pipelines'

/** The web's names for the API's views. */
export type MyRun = RunView
export type MyPipeline = PipelineView
export type MyQueueItem = QueueView

export const RUN_WINDOW_LABEL: Record<RunWindow, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' }

export const pipelinesApi = {
  mine: (window: RunWindow) => api<MyRuns>(`/pipelines?window=${window}`),
}

/** The groups that make this yours — by catalog ownership or a Jenkins grant. */
export function groupsOf(item: { reasons: Reason[] }): string[] {
  const names = item.reasons.flatMap((r) => (r.kind === 'team' ? [r.team] : r.kind === 'jenkins' && r.group ? [r.sid] : []))
  return [...new Map(names.map((n) => [n.toLowerCase(), n])).values()]
}

/** Yours by name: you started it, or it built your commit. */
export function isPersonal(item: { reasons: Reason[] }): boolean {
  return item.reasons.some((r) => r.kind === 'started' || r.kind === 'commit')
}

export const isBroken = (result: Result) => result === 'failure' || result === 'unstable'
