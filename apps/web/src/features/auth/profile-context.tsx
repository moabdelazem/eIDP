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
}

type ProfileValue = {
  profile: Profile | undefined
  /**
   * Only ever from the directory. False until the profile has loaded — the
   * token's role is deliberately not used as a stand-in, because someone just
   * removed from DevOps would otherwise see the DevOps section until it did.
   */
  isApprover: boolean
  /** Whether `isApprover` is an answer yet, rather than the default. */
  loaded: boolean
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
