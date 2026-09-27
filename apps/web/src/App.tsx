import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Login } from '@/components/login'
import { logout, storedSession, type Session } from '@/auth'
import logo from '@/assets/logo.png'

export default function App() {
  const [session, setSession] = useState<Session | null>(storedSession)

  if (!session) return <Login onSignedIn={setSession} />

  return (
    <div className="min-h-dvh">
      <header className="flex items-center gap-4 bg-rail px-6 py-3 text-rail-foreground">
        <img src={logo} alt="" className="size-7" />
        <span className="font-semibold tracking-tight">e-IDP</span>
        <div className="ml-auto flex items-center gap-4">
          <span className="text-sm text-rail-muted">{session.name}</span>
          <Button
            variant="ghost"
            size="sm"
            className="text-rail-foreground hover:bg-rail-border hover:text-rail-foreground"
            onClick={() => {
              logout()
              setSession(null)
            }}
          >
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-20">
        <h1 className="text-2xl font-semibold tracking-tight">Project map</h1>
        <p className="mt-3 max-w-prose text-muted-foreground">
          The map is built from the <code>engine</code> repository. Nothing is connected yet, so
          there is nothing to show.
        </p>
      </main>
    </div>
  )
}
