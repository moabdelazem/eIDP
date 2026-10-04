import { api } from '@/lib/api-client.ts'

/** Mirrors the API's services/health.ts. */
export type Status = 'ok' | 'degraded' | 'down' | 'off'
export type Group = 'core' | 'integration' | 'background'

export type Component = {
  id: string
  name: string
  group: Group
  status: Status
  summary: string
  facts: { label: string; value: string }[]
  latencyMs: number | null
  uses: string
}

export type Health = { status: 'ok' | 'degraded' | 'down'; checkedAt: string; components: Component[] }

/** One day of one component, from the samples taken every few minutes. */
export type Day = { day: string; samples: number; down: number; degraded: number; worst: Status | 'none' }

export type Incident = {
  component: string
  name: string
  status: 'down' | 'degraded'
  from: string
  /** Null while it is still going. */
  to: string | null
  summary: string
}

export type History = {
  days: number
  dates: string[]
  components: Record<string, { uptime: number | null; days: Day[]; latency: { at: string; ms: number }[] }>
  incidents: Incident[]
  since: string | null
  sampleMinutes: number
}

export const systemApi = {
  /** `fresh` asks every system now instead of from the 15-second cache. */
  health: (fresh = false) => api<Health>(`/system/health${fresh ? '?fresh=1' : ''}`),
  history: (days = 90) => api<History>(`/system/history?days=${days}`),
}
