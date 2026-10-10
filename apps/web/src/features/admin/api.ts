import { api } from '@/lib/api-client.ts'

// The JSON's shapes are the API's, from @eidp/contracts — one definition, so the two cannot drift.
import type { LoginResponse } from '@eidp/contracts/auth'
import type { AuditEntry, Binding, Catalogue, Explanation, NewBinding, Suggestions } from '@eidp/contracts/rbac'
export type { AuditEntry, Binding, Catalogue, Explanation, Grant, NewBinding, RoleInfo, SubjectType, Suggestions } from '@eidp/contracts/rbac'

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
  assume: (uid: string) => api<LoginResponse>('/auth/assume', { method: 'POST', body: JSON.stringify({ uid }) }),
}
