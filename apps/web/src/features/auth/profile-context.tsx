import { createContext, use, useMemo, type ReactNode } from 'react'
import { api } from '@/lib/api-client.ts'
import { useResource } from '@/lib/use-resource.ts'
import { useSession } from './session-context.tsx'

export type Profile = {
  uid: string
  name: string
  mail: string
  title: string | null
  department: string | null
  division: string | null
  company: string | null
  office: string | null
  manager: string | null
  groups: string[]
  approverGroup: string
  isApprover: boolean
  groupLookup: string
  access: {
    /** Every role you hold, and the group or grant it comes through. */
    roles: { role: string; label: string; via: string; scopeType: ScopeType; scope: string | null; expiresAt: string | null }[]
    grants: { permission: Permission; scopeType: ScopeType; scope: string | null }[]
  }
}

/** Mirrors `PERMISSIONS` in the API's services/rbac.ts. */
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
  | 'system.health'
  | 'ai.use'
  | 'ai.chat'
  | 'activity.view'
  | 'machines.manage'
  | 'digests.all'
export type ScopeType = 'global' | 'team' | 'project'

type ProfileValue = {
  profile: Profile | undefined
  /**
   * Only ever from the directory. False until the profile has loaded — the
   * token's role is deliberately not used as a stand-in, because someone just
   * removed from DevOps would otherwise see the DevOps section until it did.
   */
  isApprover: boolean
  /** Whether `isApprover` and `can` are answers yet, rather than the default. */
  loaded: boolean
  /** Holds `permission` everywhere. False until the profile has loaded. */
  can: (permission: Permission) => boolean
  /**
   * Holds it anywhere — enough to show the page it lives on (a team lead's
   * approvals queue). Which items they may act on is the API's answer.
   */
  canSomewhere: (permission: Permission) => boolean
  error: string | null
  reload: () => void
}

const ProfileContext = createContext<ProfileValue | null>(null)

/** Who you are according to AD right now, shared by everything signed in. */
export function ProfileProvider({ children }: { children: ReactNode }) {
  const { session } = useSession()
  // Refreshed every few minutes: being added to DEVOPS should show up without
  // signing out and back in.
  const profile = useResource(() => api<Profile>('/auth/profile'), [session?.uid], {
    pollMs: 5 * 60_000,
  })

  const value = useMemo<ProfileValue>(
    () => ({
      profile: profile.data,
      isApprover: profile.data?.isApprover ?? false,
      loaded: profile.data !== undefined || profile.error !== null,
      can: (permission) =>
        profile.data?.access.grants.some((g) => g.permission === permission && g.scopeType === 'global') ?? false,
      canSomewhere: (permission) => profile.data?.access.grants.some((g) => g.permission === permission) ?? false,
      error: profile.error,
      reload: profile.reload,
    }),
    [profile.data, profile.error, profile.reload],
  )

  return <ProfileContext value={value}>{children}</ProfileContext>
}

export function useProfile(): ProfileValue {
  const value = use(ProfileContext)
  if (!value) throw new Error('useProfile must be used inside <ProfileProvider>')
  return value
}
