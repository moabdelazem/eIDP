import { api } from '@/lib/api-client.ts'
import type { QueueItem, Result, Run, SyncState } from '@/features/jenkins/api.ts'

/** Mirrors the API's services/pipelines.ts. */

/** A system a pipeline belongs to: matched through an application's repository name. */
export type Owner = { system: string; project: string; applications: string[]; teams: string[] }

export type Reason =
  | { kind: 'team'; team: string; project: string }
  | { kind: 'scope'; via: string }
  | { kind: 'started'; builds: number; last: string }

export type Pipeline = {
  job: string
  url: string
  owners: Owner[]
  reasons: Reason[]
  canOperate: boolean
  last: Run | null
  recent: { number: number; result: Result; startedAt: string }[]
  running: boolean
  inQueue: boolean
  week: { builds: number; passed: number }
}

export type MyPipelines = {
  url: string
  sync: SyncState
  pipelines: Pipeline[]
  queue: (QueueItem & { canOperate: boolean })[]
  queueError: string | null
  startedByYou: (Run & { canOperate: boolean })[]
}

export const pipelinesApi = {
  mine: () => api<MyPipelines>('/pipelines'),
}

/** Failing now: the latest finished build did not pass. */
export function isBroken(p: Pipeline): boolean {
  const finished = p.recent.find((b) => b.result !== 'running' && b.result !== 'not_built')
  return finished?.result === 'failure' || finished?.result === 'unstable'
}
