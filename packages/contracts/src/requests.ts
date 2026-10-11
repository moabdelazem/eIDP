/** Requests: what `/requests` sends and takes (apps/api modules/requests/service.ts, modules/requests/risk.ts). */

export type RequestKind = 'create_repository' | 'create_project' | 'grant_access' | 'create_jira_project' | 'create_pipeline'
export type AccessLevel = 'read' | 'contribute'
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'completed' | 'failed' | 'cancelled'

// ---- pipelines ---------------------------------------------------------------

/** Where the application is deployed. */
export type DeployTarget = 'OCP' | 'K8s'

/**
 * What a new project's `group_vars/all/team.yml` is written from. Lists are
 * one name per entry; an empty list is written as YAML's empty list.
 */
export type ProjectTeams = {
  company: string
  devTeam: string
  qcTeam: string
  uatTeam: string
  prdTeam: string
  /** An explicit choice, as the old form had it: null until made, and a request is refused while it is. */
  automaticDeployToQc: boolean | null
  devTeamList: string[]
  opsTeamList: string[]
  prdOnly: string[]
  prdApprovers: string[]
  projectManagers: string[]
}

/** One environment's namespace for a new project. The token is never asked for: it is written as a placeholder and set by hand. */
export type Namespace = { name: string; user: string | null }

/**
 * A pipeline asked for: an application in the inventories repo, for a
 * repository that already exists. `newProject` is set when the project has
 * no files in inventories yet, and carries what its project files need.
 */
export type PipelineSpec = {
  application: string
  deployTarget: DeployTarget
  /** A key of the technology registry (`GET /requests/pipeline/technologies`). */
  technology: string
  version: string | null
  library: boolean
  /** The technology's own fields, by name. */
  fields: Record<string, string>
  newProject: { teams: ProjectTeams; namespaces: Record<string, Namespace> } | null
}

/** A field a technology asks for. `options` makes it a choice; `default` may name `{application}`. */
export type TechnologyField = { name: string; label: string; options: string[] | null; default: string | null; help: string | null }

/** A build technology the portal can write a pipeline for. */
export type Technology = {
  key: string
  label: string
  /** Versions to offer; empty when the technology has none to choose. */
  versions: string[]
  fields: TechnologyField[]
  /** Deploy targets it supports. */
  targets: DeployTarget[]
  /** Namespaces are not written for it (DBScripts runs on the deploy host). */
  noNamespaces: boolean
}

/** What the form knows about a project before asking for its details. */
export type PipelineProject = {
  /** Whether inventories already has the project's files — and so whether team.yml and namespaces are asked for. */
  exists: boolean
  /** The system directory in inventories, when it exists. */
  system: string | null
  /** The environments a new project's namespaces are asked for, per deploy target. */
  environments: Record<DeployTarget, { key: string; label: string }[]>
}

/** One file a pipeline request writes, for the approver to read. */
export type PipelineFile = { path: string; content: string }

/** What approving would write, worked out from inventories as they are now. */
export type PipelinePreview = { files: PipelineFile[]; errors: string[]; commit: string | null }

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
  /** create_pipeline only: the application and how it is built and deployed. */
  pipeline: PipelineSpec | null
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
  /** For a repository that exists: `repository` is its name in `collection`/`project`. */
  | { kind: 'create_pipeline'; collection: string; project: string; repository: string; pipeline: PipelineSpec }

export type Check = { ok: true } | { ok: false; reason: string }
