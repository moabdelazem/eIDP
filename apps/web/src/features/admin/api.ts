import { api } from '@/lib/api-client.ts'
import type { Permission, ScopeType } from '@/features/auth/profile-context.tsx'

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
  builtIn: boolean
}

export type NewBinding = Omit<Binding, 'id' | 'createdBy' | 'createdAt' | 'builtIn'>

export type RoleInfo = { id: string; label: string; description: string; permissions: Permission[] }
export type Catalogue = { permissions: { id: Permission; description: string }[]; roles: RoleInfo[] }

export type Explanation = {
  uid: string
  groups: string[]
  bindings: Binding[]
  permissions: {
    permission: Permission
    description: string
    grants: { permission: Permission; scopeType: ScopeType; scope: string | null; via: string }[]
  }[]
}

export type AuditEntry =
  | { id: string; at: string; actor: string; action: 'grant' | 'revoke'; binding: Binding; previous: null; target: null }
  | { id: string; at: string; actor: string; action: 'update'; binding: Binding; previous: Binding; target: null }
  | { id: string; at: string; actor: string; action: 'assume'; binding: null; previous: null; target: string }

/** Names the grant form offers as someone types. */
export type Suggestions = { teams: string[]; projects: string[]; groups: string[] }

export const rbacApi = {
  catalogue: () => api<Catalogue>('/rbac/roles'),
  bindings: () => api<Binding[]>('/rbac/bindings'),
  add: (binding: NewBinding) => api<Binding>('/rbac/bindings', { method: 'POST', body: JSON.stringify(binding) }),
  update: (id: string, change: { reason?: string | null; expiresAt?: string | null }) =>
    api<Binding>(`/rbac/bindings/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(change) }),
  suggestions: () => api<Suggestions>('/rbac/suggestions'),
  remove: (id: string) => api<void>(`/rbac/bindings/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  explain: (uid: string) => api<Explanation>(`/rbac/explain/${encodeURIComponent(uid)}`),
  audit: () => api<AuditEntry[]>('/rbac/audit'),
  /** A read-only session as `uid`. Needs `rbac.view_as`; audited. */
  assume: (uid: string) => api<{ token: string; expiresAt: number }>('/auth/assume', { method: 'POST', body: JSON.stringify({ uid }) }),
}
