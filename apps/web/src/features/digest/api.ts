import { api } from '@/lib/api-client.ts'
import type { Result } from '@/features/jenkins/api.ts'
import type { RequestKind, RequestStatus } from '@/features/requests/api.ts'
import type { Incident } from '@/features/system/api.ts'

/** Mirrors the API's services/digest.ts. */

type Totals = { builds: number; passed: number; failed: number; unstable: number; aborted: number; successRate: number | null }

export type FailingPipeline = {
  job: string
  applications: string[]
  failures: number
  builds: number
  last: { number: number; result: Result; at: string }
  broken: boolean
}

export type BuildFacts = {
  current: Totals
  previous: Totals
  pipelines: number
  failing: FailingPipeline[]
  fixes: { count: number; medianMs: number | null; longestMs: number | null }
  busiest: { application: string; builds: number }[]
}

export type RequestItem = { id: string; kind: RequestKind; status: RequestStatus; target: string; by: string; at: string; error: string | null }

export type DigestFacts = {
  team: string
  week: string
  ends: string
  projects: string[]
  builds: BuildFacts | null
  buildsError: string | null
  requests: {
    filed: number
    byKind: Partial<Record<RequestKind, number>>
    completed: number
    rejected: number
    failed: RequestItem[]
    waiting: RequestItem[]
  }
  incidents: Incident[]
}

export type Digest = {
  team: string
  week: string
  live: boolean
  facts: DigestFacts
  summary: string | null
  highlights: string[]
  model: string | null
  error: string | null
  createdAt: string
  /** Weeks on offer for this team, newest first. */
  weeks: string[]
}

export type DigestIndex = { teams: string[]; mine: string[]; weeks: string[]; current: string; canRegenerate: boolean }

export const digestApi = {
  index: () => api<DigestIndex>('/digests'),
  digest: (team: string, week: string) => api<Digest>(`/digests/${encodeURIComponent(team)}?week=${week}`),
  regenerate: (team: string, week: string) =>
    api<Digest>(`/digests/${encodeURIComponent(team)}/regenerate`, { method: 'POST', body: JSON.stringify({ week }) }),
}
