import { api } from '@/lib/api-client.ts'

export type RequestKind = 'create_repository' | 'create_project'
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'completed' | 'failed' | 'cancelled'

export type PortalRequest = {
  id: string
  kind: RequestKind
  status: RequestStatus
  collection: string
  project: string
  repository: string | null
  description: string | null
  justification: string
  requestedBy: string
  requestedByName: string
  requestedAt: string
  decidedBy: string | null
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
  completedAt: string | null
  resultUrl: string | null
  error: string | null
}

export type Target =
  | { kind: 'create_repository'; collection: string; project: string; repository: string }
  | { kind: 'create_project'; collection: string; project: string; description?: string }

export type Check = { ok: true } | { ok: false; reason: string }

export const requestsApi = {
  collections: () =>
    api<{ collections: string[]; defaultCollection: string; serverUrl: string }>('/ado/collections'),
  projects: (collection: string) =>
    api<{ name: string; description: string | null }[]>(
      `/ado/collections/${encodeURIComponent(collection)}/projects`,
    ),
  check: (target: Target) =>
    api<Check>('/requests/check', { method: 'POST', body: JSON.stringify(target) }),
  submit: (target: Target, justification: string) =>
    api<PortalRequest>('/requests', {
      method: 'POST',
      body: JSON.stringify({ ...target, justification }),
    }),
  mine: () => api<PortalRequest[]>('/requests/mine'),
  pool: () => api<{ open: PortalRequest[]; recent: PortalRequest[] }>('/requests/pool'),
  get: (id: string) => api<PortalRequest>(`/requests/${encodeURIComponent(id)}`),
  cancel: (id: string) => api<PortalRequest>(`/requests/${id}/cancel`, { method: 'POST' }),
  approve: (id: string) =>
    api<PortalRequest>(`/requests/${id}/approve`, { method: 'POST', body: '{}' }),
  reject: (id: string, note: string) =>
    api<PortalRequest>(`/requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) }),
  retry: (id: string) => api<PortalRequest>(`/requests/${id}/retry`, { method: 'POST' }),
}

/** The thing being created, as a path — the one line that identifies a request. */
export function targetPath(request: Pick<PortalRequest, 'collection' | 'project' | 'repository'>): string[] {
  return [request.collection, request.project, ...(request.repository ? [request.repository] : [])]
}

/** Still moving, so worth watching. */
export function isInFlight(status: RequestStatus): boolean {
  return status === 'pending' || status === 'approved'
}
