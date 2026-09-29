import { createContext, use, useCallback, useMemo, useState, type ReactNode } from 'react'
import { logout } from './api.ts'
import { restoreSession, type Session } from './session.ts'
import { tokenStore } from '@/lib/token-store.ts'

type SessionContextValue = {
  session: Session | null
  signIn: (session: Session) => void
  signOut: () => void
  /** Starts viewing the portal as someone else, with a token from POST /auth/assume. */
  viewAs: (token: string) => void
  /** Ends it, back to the admin's own session. */
  returnToSelf: () => void
}

/**
 * Switching who you are reloads the app from the Overview: every cached
 * resource — profile, queue, catalog — belongs to the previous identity, and
 * a page open as one person may not exist for the other.
 */
function restart(): void {
  window.location.assign('/')
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(restoreSession)

  const signOut = useCallback(() => {
    logout()
    setSession(null)
  }, [])

  const value = useMemo(
    () => ({
      session,
      signIn: setSession,
      signOut,
      viewAs: (token: string) => {
        tokenStore.assume(token)
        restart()
      },
      returnToSelf: () => {
        tokenStore.clear()
        restart()
      },
    }),
    [session, signOut],
  )
  return <SessionContext value={value}>{children}</SessionContext>
}

export function useSession(): SessionContextValue {
  const value = use(SessionContext)
  if (!value) throw new Error('useSession must be used inside <SessionProvider>')
  return value
}
