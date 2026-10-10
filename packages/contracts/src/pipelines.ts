/** My pipelines: what `/pipelines` sends (apps/api modules/pipelines/service.ts, modules/jenkins/access.ts). */

import type { Explanation, QueueItem, Result, Run, SyncState } from './jenkins.ts'

/** A system a run belongs to, with the applications that tie it. */
export type Owner = { system: string; project: string; applications: string[]; teams: string[] }

/** Why a run is on someone's list — shown, so nobody wonders why it is there. */
export type Reason =
  | { kind: 'started' }
  /** It built a commit you wrote; `by` is who started it — the service account, usually. */
  | { kind: 'commit'; by: string | null }
  | { kind: 'team'; team: string; project: string }
  /** Jenkins lets this group, or you by name, read the job — for runs that name no project. */
  | { kind: 'jenkins'; sid: string; group: boolean; via: string }
  | { kind: 'scope'; via: string }

/** What a list carries of an explanation; the build page has the rest. */
export type Brief = Pick<Explanation, 'summary' | 'category' | 'confidence' | 'nextSteps' | 'createdAt' | 'automatic'>

export type RunView = Run & {
  /** The applications the run is for, and whether its parameters or its job's name said so. */
  applications: string[]
  matchedBy: 'parameters' | 'job' | null
  owners: Owner[]
  reasons: Reason[]
  /** Yours by name: you started it, or it built your commit. */
  personal: boolean
  canOperate: boolean
  /** For a failed or unstable run, the AI's kept answer on why — when the caller may use it and one was made. */
  explanation: Brief | null
}

/** One job — or, for a shared job, one job for one project — summed over the runs you may see. */
export type PipelineView = {
  key: string
  job: string
  /** For a shared job, the project the runs are for. */
  applications: string[]
  url: string
  owners: Owner[]
  reasons: Reason[]
  last: RunView
  recent: { number: number; result: Result; startedAt: string }[]
  running: boolean
  inQueue: boolean
  /** Finished runs in the window, and how many passed. */
  finished: { builds: number; passed: number }
}

export type QueueView = QueueItem & Pick<RunView, 'applications' | 'matchedBy' | 'owners' | 'reasons' | 'personal' | 'canOperate'>

export type RunWindow = '24h' | '7d' | '30d'

/** Who Jenkins lets read which job, as last read from its own authorization. */
export type AccessState = {
  readAt: string | null
  source: 'role-strategy' | 'matrix' | 'none' | null
  grants: number
  ok: boolean
  error: string | null
  warnings: string[]
}

export type MyRuns = {
  url: string
  sync: SyncState
  /** Where who-sees-what came from — Jenkins' rules when they can be read, else the catalog's teams — and whether it is current. */
  access: AccessState & { decides: 'jenkins' | 'catalog' }
  window: RunWindow
  runs: RunView[]
  /** More runs matched than are listed; the newest are. */
  truncated: boolean
  pipelines: PipelineView[]
  queue: QueueView[]
  /** Why the queue could not be read, when it could not. History still shows. */
  queueError: string | null
  /** Whether the caller can ask the AI why a run failed: null when they may not, else whether it is set up. */
  ai: { configured: boolean; model: string | null } | null
}
