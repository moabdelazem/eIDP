import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError } from '@/lib/api-client.ts'
import { login } from './api.ts'
import { useSession } from './session-context.tsx'
import logo from '@/assets/logo.png'
import { usePageTitle } from '@/lib/use-page-title.ts'

export function LoginPage() {
  usePageTitle('Sign in')
  const { session, signIn } = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  // Whoever sent us here wanted a particular page; go back to it.
  const from = (location.state as { from?: string } | null)?.from ?? '/'

  if (session) return <Navigate to={from} replace />

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    try {
      signIn(await login(String(form.get('username')), String(form.get('password'))))
      navigate(from, { replace: true })
    } catch (err) {
      // The API already wrote a message fit to read; don't invent another.
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="hidden flex-col justify-between border-r border-rail-border bg-rail p-12 text-rail-foreground lg:flex">
        <img src={logo} alt="" className="size-9" />
        <div className="max-w-sm">
          <h1 className="text-4xl leading-[1.05] font-semibold tracking-tight">
            Everything the platform team used to do by ticket.
          </h1>
          <p className="mt-5 text-rail-muted">
            Find any project in the organization, then ask for what you need to ship it.
          </p>
        </div>
      </aside>

      <main className="flex items-center justify-center px-6 py-16 sm:px-12">
        <form onSubmit={submit} className="w-full max-w-sm">
          <img src={logo} alt="" className="mb-8 size-9 lg:hidden" />
          <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Use the same account you use for the rest of the organization.
          </p>

          <div className="mt-8 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input id="username" name="username" autoComplete="username" autoFocus required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
          </div>

          {error && (
            <p role="alert" className="mt-4 border-l-2 border-destructive pl-3 text-sm">
              {error}
            </p>
          )}

          <Button type="submit" disabled={pending} className="mt-6 w-full">
            {pending ? 'Checking the directory' : 'Sign in'}
          </Button>
        </form>
      </main>
    </div>
  )
}
