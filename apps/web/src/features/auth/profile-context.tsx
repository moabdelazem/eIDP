import { createContext, use, useMemo, type ReactNode } from 'react'
import { api } from '@/lib/api-client.ts'
import { useResource } from '@/lib/use-resource.ts'
import type { Profile } from '@eidp/contracts/auth'
import type { Permission } from '@eidp/contracts/rbac'
// One list for both apps: a permission added to the API's PERMISSIONS and not here no longer compiles.
export type { Profile } from '@eidp/contracts/auth'
export type { Permission, ScopeType } from '@eidp/contracts/rbac'
import { useSession } from './session-context.tsx'

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
  const profile = useResource(['auth', 'profile', session?.uid], () => api<Profile>('/auth/profile'), {
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
