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
export type TechnologyField = {
  name: string
  label: string
  options: string[] | null
  default: string | null
  help: string | null
  /** A regular expression (source) the value must match; `help` says what it expects. */
  pattern: string | null
}

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

/**
 * What approving would write, worked out from the repositories as they are
 * now: `files` to inventories, `manifests` to ocp-templates (none for a
 * library or a technology without manifests). `commit` is the inventories
 * commit, once the push has landed.
 */
export type PipelinePreview = {
  files: PipelineFile[]
  manifests: PipelineFile[]
  errors: string[]
  commit: string | null
  /** Paths whose content is a decider's edit rather than what the templates write. */
  edited: string[]
}

/**
 * One template on the Pipeline templates page: what a technology writes for a
 * deploy target (its group_vars to inventories, or its manifests to
 * ocp-templates), or a new project's files. `dir` is its key.
 */
export type TemplateSlot = {
  dir: string
  kind: 'group_vars' | 'manifests' | 'project'
  /** The technology's key and label; null for the project template. */
  technology: string | null
  label: string
  target: DeployTarget | null
  /** Flutter on OCP: one per app_path. */
  appPath: string | null
  /** Where "Import from the reference" reads it from. */
  repository: 'inventories' | 'ocp-templates'
  reference: string
  saved: { files: number; updatedByName: string; updatedAt: string } | null
}

export type TemplateChange = { changedBy: string; changedByName: string; changedAt: string; files: number | null }

export type PipelineTemplate = { slot: TemplateSlot; files: PipelineFile[]; history: TemplateChange[] }

/** A reference read as a template: not saved, for the editor. `notes` says what to check. */
export type TemplateImport = { files: PipelineFile[]; notes: string[] }

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
  /**
   * Who else is given access, by login name: on grant_access, everyone it
   * grants; on create_project, the developers who get Contributor with the
   * requester and their team.
   */
  grantees: string[] | null
  accessLevel: AccessLevel | null
  /** create_pipeline only: the application and how it is built and deployed. */
  pipeline: PipelineSpec | null
  /** create_jira_project: who leads it, by login name; null when the requester does. */
  projectLead: string | null
  /** Set on the requests one New project form filed together — its Azure DevOps project and its Jira project. */
  bundleId: string | null
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
  /** What a decider changed before approving, oldest first — shown to the requester too. */
  adjustments: Adjustment[]
  /** create_pipeline only: the files a decider edited in what approving writes, by path. Their contents are in the preview. */
  editedFiles: string[]
  /** create_pipeline only: what runs in Jenkins after the push — provisioning, then a first test build. */
  steps: RequestStep[]
}

/**
 * One change a decider made to a waiting request before approving it — a
 * name, a version, or the files a pipeline writes — and who made it.
 */
export type Adjustment = { field: string; label: string; from: string | null; to: string | null; by: string; byName: string; at: string }

/**
 * What a decider may change on a waiting request (`PATCH /requests/:id`),
 * by kind: a repository's or project's names, a Jira project's name and
 * key, a pipeline's application name and version, and the files it writes.
 * Each change is checked as a new request would be.
 */
export type RequestChanges = {
  collection?: string
  project?: string
  repository?: string
  projectKey?: string
  application?: string
  version?: string
  /** The files approving writes, as edited: replaces every earlier edit; [] goes back to what the templates write. */
  files?: PipelineFile[]
}

/** What runs in Jenkins after an approved pipeline is pushed. */
export type StepName = 'provision' | 'test'

/**
 * Where a step is:
 * - `waiting` for the step before it (the test build waits on provisioning);
 * - `pending`: due to be sent to Jenkins;
 * - `queued` in Jenkins' queue, then `running` as a build;
 * - `succeeded`, `failed`, or `skipped` (not configured — `note` says how to do it by hand).
 */
export type StepStatus = 'waiting' | 'pending' | 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'

export type RequestStep = {
  step: StepName
  status: StepStatus
  /** The Jenkins job, and the build once it started. */
  job: string | null
  number: number | null
  /** Jenkins' page for the build. */
  url: string | null
  /** Why it failed or was skipped. */
  note: string | null
  attempts: number
  startedAt: string | null
  finishedAt: string | null
}

/** Another request filed from the same New project form, as its request page links to it. */
export type FiledWith = Pick<RequestRecord, 'id' | 'kind' | 'status' | 'collection' | 'project' | 'projectKey'>

/** One request as `GET /requests/:id` sends it: with whether the viewer may decide it, and what was filed with it. */
export type RequestView = RequestRecord & { canDecide?: boolean; filedWith?: FiledWith[] }

/** What the form sends to `/requests/check` and `/requests`: exactly one kind's fields. */
export type Target =
  | { kind: 'create_repository'; collection: string; project: string; repository: string }
  /** `developers`: login names that get Contributor with the requester and their team. */
  | { kind: 'create_project'; collection: string; project: string; description?: string; developers?: string[] }
  /** Always Contribute on the whole project; neither is the requester's choice. */
  | { kind: 'grant_access'; collection: string; project: string; grantees: string[] }
  /** `project` is the Jira project's name; `projectKey` its key. */
  /** `lead`: who leads it, by login name, when not the requester. */
  | { kind: 'create_jira_project'; project: string; projectKey: string; description?: string; lead?: string }
  /** For a repository that exists: `repository` is its name in `collection`/`project`. */
  | { kind: 'create_pipeline'; collection: string; project: string; repository: string; pipeline: PipelineSpec }

export type Check = { ok: true } | { ok: false; reason: string }

/**
 * `POST /requests/project`: one project, in Azure DevOps, in Jira, or both —
 * the old portal's "Request New DevOps Project". One name and description for
 * both; each system's own details beside it. Filed as one request per system,
 * together or not at all, and decided one by one.
 */
export type ProjectRequest = {
  project: string
  description?: string
  ado?: { collection: string; developers?: string[] }
  jira?: { projectKey: string; lead?: string }
  justification: string
  teamGroup: string
}
