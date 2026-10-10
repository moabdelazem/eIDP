/** Signing in and who you are: what `/auth` sends (apps/api routes/auth.ts, integrations/ldap/profile.ts). */

import type { Permission, ScopeType } from './rbac.ts'

/** A session: the token to send as Bearer, and when it stops working (seconds since the epoch). `/auth/login` and `/auth/assume`. */
export type LoginResponse = { token: string; expiresAt: number }

/** You according to the directory, read live — never the token's say-so. */
export type DirectoryProfile = {
  uid: string
  name: string
  mail: string
  title: string | null
  department: string | null
  /** AD has no single "team" field; division is the usual home for it. */
  division: string | null
  company: string | null
  office: string | null
  manager: string | null
  groups: string[]
  approverGroup: string
  isApprover: boolean
  /** How groups were looked up — shown when someone expected to approve and can't. */
  groupLookup: string
}

/** `GET /auth/profile`: the directory's answer, and what you may do in the portal. */
export type Profile = DirectoryProfile & {
  access: {
    /** Every role you hold, and the group or grant it comes through. */
    roles: { role: string; label: string; via: string; scopeType: ScopeType; scope: string | null; expiresAt: string | null }[]
    grants: { permission: Permission; scopeType: ScopeType; scope: string | null }[]
  }
}
