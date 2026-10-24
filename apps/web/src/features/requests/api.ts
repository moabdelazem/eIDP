import { api } from '@/lib/api-client.ts'

// The JSON's shapes are the API's, from @eidp/contracts — one definition, so the two cannot drift.
import type { Assessment, Check, PipelinePreview, PipelineProject, ProjectRequest, RequestChanges, RequestStatus, RequestStep, RequestView, StepName, Target, Technology } from '@eidp/contracts/requests'
export type { AccessLevel, Adjustment, Assessment, Check, DeployTarget, FiledWith, Namespace, PipelineFile, PipelinePreview, PipelineProject, PipelineSpec, ProjectRequest, ProjectTeams, RequestChanges, RequestKind, RequestStatus, RequestStep, StepName, StepStatus, Target, Technology } from '@eidp/contracts/requests'

/** A request as the web holds it: the record, and on a single one whether the viewer may decide it. */
export type PortalRequest = RequestView

export const requestsApi = {
  collections: () =>
    api<{ collections: string[]; defaultCollection: string; serverUrl: string }>('/ado/collections'),
  projects: (collection: string) =>
    api<{ name: string; description: string | null }[]>(
      `/ado/collections/${encodeURIComponent(collection)}/projects`,
    ),
  repositories: (collection: string, project: string) =>
    api<{ name: string; webUrl: string | null }[]>(
      `/ado/collections/${encodeURIComponent(collection)}/projects/${encodeURIComponent(project)}/repositories`,
    ),
  /** The build technologies a pipeline can be asked for, and the fields each asks. */
  technologies: () => api<Technology[]>('/requests/pipeline/technologies'),
  /** Whether inventories has the project yet — a new one is asked for its teams and namespaces. */
  pipelineProject: (project: string) => api<PipelineProject>(`/requests/pipeline/project?project=${encodeURIComponent(project)}`),
  /** What approving would write into inventories, as they are now. For the people who may decide it. */
  pipelinePreview: (id: string) => api<PipelinePreview>(`/requests/${encodeURIComponent(id)}/pipeline`),
  /** Which Jira the portal talks to; fails when it cannot reach it. */
  jira: () => api<{ baseUrl: string; serverTitle: string; version: string }>('/jira'),
  check: (target: Target) =>
    api<Check>('/requests/check', { method: 'POST', body: JSON.stringify(target) }),
  submit: (target: Target, justification: string, teamGroup?: string) =>
    api<PortalRequest>('/requests', {
      method: 'POST',
      body: JSON.stringify({ ...target, justification, teamGroup }),
    }),
  /** A project in Azure DevOps, Jira or both: one request per system, filed together. */
  submitProject: (input: ProjectRequest) => api<PortalRequest[]>('/requests/project', { method: 'POST', body: JSON.stringify(input) }),
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
  /** A decider's changes to a waiting request — each checked as a new request would be, and recorded. */
  adjust: (id: string, changes: RequestChanges) => api<PortalRequest>(`/requests/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),
  /** Runs a pushed pipeline's provisioning or test build again. */
  retryStep: (id: string, step: StepName) => api<RequestStep[]>(`/requests/${id}/steps/${step}/retry`, { method: 'POST' }),
}

/** Login names, however they were typed: commas, spaces, one per line — each once, as first spelled. */
export function parseNames(text: string): string[] {
  const seen = new Map<string, string>()
  for (const name of text.split(/[\s,;]+/)) {
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name)
  }
  return [...seen.values()]
}

/** Whether a step is still on its way in Jenkins — the page keeps watching until none is. */
export const stepMoving = (step: Pick<RequestStep, 'status'>) => step.status === 'pending' || step.status === 'queued' || step.status === 'running'

/** Where the pipeline form opens for a repository that exists, filled in. */
export const pipelineFormFor = (r: Pick<PortalRequest, 'collection' | 'project' | 'repository'>) =>
  `/requests/new/jenkins/pipeline?${new URLSearchParams({ collection: r.collection ?? '', project: r.project, repository: r.repository ?? '' })}`

/** Jira's requests act in Jira; everything else is Azure DevOps. */
export function isJira(request: Pick<PortalRequest, 'kind'>): boolean {
  return request.kind === 'create_jira_project'
}

/** A pipeline request writes into the inventories repository rather than creating something in a provider. */
export function isPipeline(request: Pick<PortalRequest, 'kind'>): boolean {
  return request.kind === 'create_pipeline'
}

/** Where a request acts, by name — for sentences like "created in Jira". */
export function systemOf(request: Pick<PortalRequest, 'kind'>): string {
  return isJira(request) ? 'Jira' : isPipeline(request) ? 'Jenkins' : 'Azure DevOps'
}

type Located = Pick<PortalRequest, 'kind' | 'collection' | 'project' | 'projectKey' | 'repository'> & { pipeline?: PortalRequest['pipeline'] }

/**
 * The thing being created, as a path — the one line that identifies a request.
 * A Jira project has no collection; its key stands where the collection would.
 */
export function targetPath(request: Located): string[] {
  if (isJira(request)) return [request.projectKey ?? '', request.project]
  // A pipeline is named for its application, built from the repository before it.
  if (isPipeline(request) && request.pipeline) return [request.collection ?? '', request.project, request.repository ?? '', request.pipeline.application]
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
