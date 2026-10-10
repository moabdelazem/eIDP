/** Weekly digest: what `/digests` sends (apps/api modules/digest/service.ts). */

import type { Result } from './jenkins.ts'
import type { RequestKind, RequestStatus } from './requests.ts'

export type Totals = { builds: number; passed: number; failed: number; unstable: number; aborted: number; successRate: number | null }

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
}

/** One digest as `GET /digests/:team` sends it: with the weeks on offer for the team, newest first. */
export type DigestView = Digest & { weeks: string[] }

export type DigestIndex = { teams: string[]; mine: string[]; weeks: string[]; current: string; canRegenerate: boolean }
