import { api } from '@/lib/api-client.ts'

export type RequestKind = 'create_repository' | 'create_project' | 'grant_access' | 'create_jira_project'
export type AccessLevel = 'read' | 'contribute'
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'completed' | 'failed' | 'cancelled'

export type PortalRequest = {
  id: string
  kind: RequestKind
  status: RequestStatus
  /** The Azure DevOps collection; null for Jira, which has none. */
  collection: string | null
  project: string
  /** Jira projects only: the key every issue carries, like PAY. */
  projectKey: string | null
  repository: string | null
  description: string | null
  justification: string
  /** The requester's directory group, granted access with them. Null on older requests. */
  teamGroup: string | null
  /** grant_access only: who is to be granted, and at what level. */
  grantees: string[] | null
  accessLevel: AccessLevel | null
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
  /** On a single request only: whether the viewer may decide it. */
  canDecide?: boolean
  /** For people who may decide it: what to weigh before approving. Absent for everyone else. */
  assessment?: Assessment | null
}

/** Mirrors services/request-risk.ts. The level comes from the facts; the model adds only words. */
export type Assessment = {
  level: 'low' | 'medium' | 'high'
  facts: { level: 'caution' | 'info'; text: string }[]
  summary: string | null
  reasonConcerns: string[]
  model: string | null
  error: string | null
  createdAt: string
}

export type Target =
  | { kind: 'create_repository'; collection: string; project: string; repository: string }
  | { kind: 'create_project'; collection: string; project: string; description?: string }
  /** Always Contribute on the whole project; neither is the requester's choice. */
  | { kind: 'grant_access'; collection: string; project: string; grantees: string[] }
  /** `project` is the Jira project's name; `projectKey` its key. */
  | { kind: 'create_jira_project'; project: string; projectKey: string; description?: string }

export type Check = { ok: true } | { ok: false; reason: string }

export const requestsApi = {
  collections: () =>
    api<{ collections: string[]; defaultCollection: string; serverUrl: string }>('/ado/collections'),
  projects: (collection: string) =>
    api<{ name: string; description: string | null }[]>(
      `/ado/collections/${encodeURIComponent(collection)}/projects`,
    ),
  /** Which Jira the portal talks to; fails when it cannot reach it. */
  jira: () => api<{ baseUrl: string; serverTitle: string; version: string }>('/jira'),
  check: (target: Target) =>
    api<Check>('/requests/check', { method: 'POST', body: JSON.stringify(target) }),
  submit: (target: Target, justification: string, teamGroup?: string) =>
    api<PortalRequest>('/requests', {
      method: 'POST',
      body: JSON.stringify({ ...target, justification, teamGroup }),
    }),
  mine: () => api<PortalRequest[]>('/requests/mine'),
  pool: () => api<{ open: PortalRequest[]; recent: PortalRequest[] }>('/requests/pool'),
  /** Every request the viewer may decide, newest first — capped at the API's HISTORY_LIMIT. */
  history: () => api<PortalRequest[]>('/requests/history'),
  get: (id: string) => api<PortalRequest>(`/requests/${encodeURIComponent(id)}`),
  cancel: (id: string) => api<PortalRequest>(`/requests/${id}/cancel`, { method: 'POST' }),
  approve: (id: string) =>
    api<PortalRequest>(`/requests/${id}/approve`, { method: 'POST', body: '{}' }),
  reject: (id: string, note: string) =>
    api<PortalRequest>(`/requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) }),
  retry: (id: string) => api<PortalRequest>(`/requests/${id}/retry`, { method: 'POST' }),
  /** Assess again — the directory and the catalog may have changed since it was filed. */
  assess: (id: string) => api<Assessment>(`/requests/${id}/assess`, { method: 'POST' }),
}

/** Jira's requests act in Jira; everything else is Azure DevOps. */
export function isJira(request: Pick<PortalRequest, 'kind'>): boolean {
  return request.kind === 'create_jira_project'
}

/** Where a request acts, by name — for sentences like "created in Jira". */
export function systemOf(request: Pick<PortalRequest, 'kind'>): string {
  return isJira(request) ? 'Jira' : 'Azure DevOps'
}

type Located = Pick<PortalRequest, 'kind' | 'collection' | 'project' | 'projectKey' | 'repository'>

/**
 * The thing being created, as a path — the one line that identifies a request.
 * A Jira project has no collection; its key stands where the collection would.
 */
export function targetPath(request: Located): string[] {
  if (isJira(request)) return [request.projectKey ?? '', request.project]
  return [request.collection ?? '', request.project, ...(request.repository ? [request.repository] : [])]
}

/** Everything in the path but the name: the context beneath it in a list. */
export function whereOf(request: Located): string {
  return targetPath(request).slice(0, -1).join(' / ')
}

/** Still moving, so worth watching. */
export function isInFlight(status: RequestStatus): boolean {
  return status === 'pending' || status === 'approved'
}
