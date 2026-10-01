import { api } from '@/lib/api-client.ts'
import type { QueueItem, Result, Run, SyncState } from '@/features/jenkins/api.ts'

/** Mirrors the API's services/pipelines.ts. */

/** A system a pipeline belongs to: matched through an application's repository name. */
export type Owner = { system: string; project: string; applications: string[]; teams: string[] }

export type Reason =
  | { kind: 'team'; team: string; project: string }
  /** Jenkins' own authorization lets this group (or you, by name) read it. */
  | { kind: 'jenkins'; sid: string; group: boolean; via: string }
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
  /** Where who-sees-what came from: Jenkins' rules when they can be read, else the catalog's teams. */
  access: {
    decides: 'jenkins' | 'catalog'
    source: 'role-strategy' | 'matrix' | 'none' | null
    readAt: string | null
    ok: boolean
    error: string | null
    warnings: string[]
  }
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

/** The groups that put this pipeline on your list — by catalog ownership or a Jenkins grant. */
export function groupsOf(p: Pipeline): string[] {
  const names = p.reasons.flatMap((r) => (r.kind === 'team' ? [r.team] : r.kind === 'jenkins' && r.group ? [r.sid] : []))
  return [...new Map(names.map((n) => [n.toLowerCase(), n])).values()]
}

/** "Just you": on your list by your name, not a group's. */
export function isPersonal(p: Pipeline): boolean {
  return p.reasons.some((r) => r.kind === 'started' || (r.kind === 'jenkins' && !r.group))
}
