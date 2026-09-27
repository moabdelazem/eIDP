import { createContext, use, useCallback, useMemo, useState, type ReactNode } from 'react'
import { logout } from './api.ts'
import { restoreSession, type Session } from './session.ts'

type SessionContextValue = {
  session: Session | null
  signIn: (session: Session) => void
  signOut: () => void
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(restoreSession)

  const signOut = useCallback(() => {
    logout()
    setSession(null)
  }, [])

  const value = useMemo(() => ({ session, signIn: setSession, signOut }), [session, signOut])
  return <SessionContext value={value}>{children}</SessionContext>
}

export function useSession(): SessionContextValue {
  const value = use(SessionContext)
  if (!value) throw new Error('useSession must be used inside <SessionProvider>')
  return value
}
