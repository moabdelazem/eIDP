import { api } from '@/lib/api-client.ts'

/** Mirrors the API's services/health.ts (now) and the health service's history, machines and alerts (apps/health). */
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
  components: Record<string, { name?: string; uptime: number | null; days: Day[]; latency: { at: string; ms: number }[] }>
  incidents: Incident[]
  since: string | null
  sampleMinutes: number
}

/** What a machine's last check read, from its ports, URL and node_exporter. */
export type Metrics = {
  ports: { port: number; ok: boolean; ms: number | null; error: string | null }[]
  http: { ok: boolean; status: number | null; ms: number | null; error: string | null } | null
  exporter: { ok: boolean; error: string | null } | null
  cpu: number | null
  cores: number | null
  load1: number | null
  memory: number | null
  disk: { mount: string; used: number } | null
  uptimeSeconds: number | null
}

/** A machine the health service watches, as entered on this page. */
export type MachineInput = {
  name: string
  host: string
  ports: number[]
  httpUrl: string | null
  exporterUrl: string | null
  group: string
  environment: string | null
  notify: string[]
  notes: string | null
  enabled: boolean
}

export type Machine = MachineInput & {
  id: string
  createdBy: string
  createdAt: string
  updatedBy: string | null
  updatedAt: string | null
  latest: { at: string; status: Status; summary: string; latencyMs: number | null; metrics: Metrics | null } | null
}

export type Alert = {
  id: string
  at: string
  component: string
  name: string
  kind: 'down' | 'degraded' | 'recovered'
  summary: string
  recipients: string[]
  state: 'pending' | 'sending' | 'sent' | 'failed'
  attempts: number
  lastError: string | null
  sentAt: string | null
}

export const systemApi = {
  /** `fresh` asks every system now instead of from the 15-second cache. */
  health: (fresh = false) => api<Health>(`/system/health${fresh ? '?fresh=1' : ''}`),
  history: (days = 90) => api<History>(`/system/history?days=${days}`),
  machines: () => api<Machine[]>('/system/machines'),
  addMachine: (m: MachineInput) => api<Machine>('/system/machines', { method: 'POST', body: JSON.stringify(m) }),
  updateMachine: (id: string, m: MachineInput) => api<Machine>(`/system/machines/${id}`, { method: 'PUT', body: JSON.stringify(m) }),
  removeMachine: (id: string) => api<void>(`/system/machines/${id}`, { method: 'DELETE' }),
  checkMachine: (id: string) => api<{ status: Status; summary: string }>(`/system/machines/${id}/check`, { method: 'POST' }),
  alerts: () => api<{ alerts: Alert[]; pending: number }>('/system/alerts'),
}
