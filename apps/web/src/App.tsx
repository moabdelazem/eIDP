import { useState } from 'react'
import { Dashboard } from '@/components/dashboard'
import { Login } from '@/components/login'
import { logout, storedSession, type Session } from '@/auth'

export default function App() {
  const [session, setSession] = useState<Session | null>(storedSession)

  if (!session) return <Login onSignedIn={setSession} />

  return (
    <Dashboard
      session={session}
      onSignOut={() => {
        logout()
        setSession(null)
      }}
    />
  )
}
