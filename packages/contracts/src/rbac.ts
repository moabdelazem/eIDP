/** Who may do what: what `/rbac` and the profile send (apps/api modules/access/service.ts). */

/** One thing the portal can do. The API's `PERMISSIONS` describes each, and must name exactly these. */
export type Permission =
  | 'catalog.view'
  | 'catalog.sync'
  | 'requests.create'
  | 'requests.decide'
  | 'requests.decide_access'
  | 'rbac.manage'
  | 'rbac.view_as'
  | 'jenkins.view'
  | 'jenkins.operate'
  | 'pipelines.view'
  | 'ai.use'
  | 'ai.chat'
  | 'activity.view'
  | 'digests.all'

export type ScopeType = 'global' | 'team' | 'project'
export type SubjectType = 'group' | 'user'

export type Binding = {
  id: string
  subjectType: SubjectType
  subject: string
  role: string
  scopeType: ScopeType
  scope: string | null
  reason: string | null
  expiresAt: string | null
  createdBy: string
  createdAt: string
  /** Defined in code, shown for completeness, and cannot be removed. */
  builtIn: boolean
}

/** What `POST /rbac/bindings` takes. */
export type NewBinding = {
  subjectType: SubjectType
  subject: string
  role: string
  scopeType: ScopeType
  scope?: string | null
  reason?: string | null
  expiresAt?: string | null
}

/** A permission someone holds, and how far it reaches. */
export type Grant = { permission: Permission; scopeType: ScopeType; scope: string | null; via: string }

export type RoleInfo = { id: string; label: string; description: string; permissions: Permission[] }
/** Roles and permissions are code; `GET /rbac/roles` lists them so the page can explain them. */
export type Catalogue = { permissions: { id: Permission; description: string }[]; roles: RoleInfo[] }

/** "Why can bob approve?" — every permission, with the group or binding behind each grant. */
export type Explanation = {
  uid: string
  groups: string[]
  bindings: Binding[]
  permissions: { permission: Permission; description: string; grants: Grant[] }[]
}

export type AuditEntry =
  | { id: string; at: string; actor: string; action: 'grant' | 'revoke'; binding: Binding; previous: null; target: null }
  | { id: string; at: string; actor: string; action: 'update'; binding: Binding; previous: Binding; target: null }
  | { id: string; at: string; actor: string; action: 'assume'; binding: null; previous: null; target: string }

/** Names the grant form offers as someone types. */
export type Suggestions = { teams: string[]; projects: string[]; groups: string[] }
