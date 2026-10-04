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

export const systemApi = {
  /** `fresh` asks every system now instead of from the 15-second cache. */
  health: (fresh = false) => api<Health>(`/system/health${fresh ? '?fresh=1' : ''}`),
}
