import { api } from '@/lib/api-client.ts'
import type { Explanation, QueueItem, Result, Run, SyncState } from '@/features/jenkins/api.ts'

/** Mirrors the API's services/pipelines.ts. */

/** A system a run belongs to, with the applications that tie it. */
export type Owner = { system: string; project: string; applications: string[]; teams: string[] }

export type Reason =
  | { kind: 'started' }
  /** It built a commit you wrote; `by` started it — a service account like maika, usually. */
  | { kind: 'commit'; by: string | null }
  | { kind: 'team'; team: string; project: string }
  /** Jenkins lets this group (or you, by name) read the job — for runs that name no project. */
  | { kind: 'jenkins'; sid: string; group: boolean; via: string }
  | { kind: 'scope'; via: string }

export type MyRun = Run & {
  applications: string[]
  /** Whether the run's parameters or its job's name said which project it is for. */
  matchedBy: 'parameters' | 'job' | null
  owners: Owner[]
  reasons: Reason[]
  personal: boolean
  canOperate: boolean
  /** For a failed or unstable run, the AI's kept answer on why, when one was made. */
  explanation: Brief | null
}

/** What the list carries of an explanation; the build page has the rest. */
export type Brief = Pick<Explanation, 'summary' | 'category' | 'confidence' | 'nextSteps' | 'createdAt' | 'automatic'>

export type MyPipeline = {
  key: string
  job: string
  /** For a shared job, the project these runs are for. */
  applications: string[]
  url: string
  owners: Owner[]
  reasons: Reason[]
  last: MyRun
  recent: { number: number; result: Result; startedAt: string }[]
  running: boolean
  inQueue: boolean
  finished: { builds: number; passed: number }
}

export type MyQueueItem = QueueItem & { applications: string[]; matchedBy: MyRun['matchedBy']; reasons: Reason[]; canOperate: boolean }

export type RunWindow = '24h' | '7d' | '30d'
export const RUN_WINDOW_LABEL: Record<RunWindow, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' }

export type MyRuns = {
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
  window: RunWindow
  runs: MyRun[]
  truncated: boolean
  pipelines: MyPipeline[]
  queue: MyQueueItem[]
  queueError: string | null
  /** Whether you can ask the AI why a run failed: null when you may not, else whether it is set up. */
  ai: { configured: boolean; model: string | null } | null
}

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
