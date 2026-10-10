/** Requests: what `/requests` sends and takes (apps/api services/requests.ts, request-risk.ts). */

export type RequestKind = 'create_repository' | 'create_project' | 'grant_access' | 'create_jira_project'
export type AccessLevel = 'read' | 'contribute'
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'completed' | 'failed' | 'cancelled'

export type RiskLevel = 'low' | 'medium' | 'high'
export type Fact = { level: 'caution' | 'info'; text: string }

/** What an approver should weigh. The level comes from the facts; the model adds only words. */
export type Assessment = {
  level: RiskLevel
  facts: Fact[]
  /** The model's one line, or null when it was not asked or did not answer. */
  summary: string | null
  /** The model's reading of the reason given — at most two notes. */
  reasonConcerns: string[]
  model: string | null
  /** Why there is no summary, when the model was asked and failed. */
  error: string | null
  createdAt: string
}

export type RequestRecord = {
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
  /** For people who may decide it: what to weigh before approving. Absent for everyone else. */
  assessment?: Assessment | null
}

/** One request as `GET /requests/:id` sends it: with whether the viewer may decide it. */
export type RequestView = RequestRecord & { canDecide?: boolean }

/** What the form sends to `/requests/check` and `/requests`: exactly one kind's fields. */
export type Target =
  | { kind: 'create_repository'; collection: string; project: string; repository: string }
  | { kind: 'create_project'; collection: string; project: string; description?: string }
  /** Always Contribute on the whole project; neither is the requester's choice. */
  | { kind: 'grant_access'; collection: string; project: string; grantees: string[] }
  /** `project` is the Jira project's name; `projectKey` its key. */
  | { kind: 'create_jira_project'; project: string; projectKey: string; description?: string }

export type Check = { ok: true } | { ok: false; reason: string }
