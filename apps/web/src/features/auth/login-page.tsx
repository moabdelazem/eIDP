import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { Eye, EyeOff, FolderTree, ListChecks, Map as MapIcon, TriangleAlert } from 'lucide-react'
import { m } from 'motion/react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { ApiError } from '@/lib/api-client.ts'
import { login } from './api.ts'
import { useSession } from './session-context.tsx'
import logo from '@/assets/logo.png'
import { usePageTitle } from '@/lib/use-page-title.ts'

/** What the portal is for, in the order people use it. */
const DOES = [
  { icon: MapIcon, text: 'Find any project and who owns it, on one map.' },
  { icon: FolderTree, text: 'Ask for a repository, a pipeline or access — no ticket.' },
  { icon: ListChecks, text: 'Follow it from review to done, and see your builds.' },
]

export function LoginPage() {
  usePageTitle('Sign in')
  const { session, signIn } = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [reveal, setReveal] = useState(false)
  const [capsLock, setCapsLock] = useState(false)

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

  // A password typed in capitals fails the directory with no hint why; say so while it is being typed.
  const watchCaps = (event: KeyboardEvent<HTMLInputElement>) => setCapsLock(event.getModifierState('CapsLock'))

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-rail-border bg-rail p-12 text-rail-foreground lg:flex">
        <BranchArt />
        <div className="relative flex items-center gap-3">
          <img src={logo} alt="" className="size-9" />
          <span className="font-display text-lg font-semibold">e-IDP</span>
        </div>
        <div className="relative max-w-md">
          <h1 className="font-display text-5xl leading-[1.02] font-semibold">Everything the platform team used to do by ticket.</h1>
          <ul className="mt-8 flex flex-col gap-3">
            {DOES.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-rail-muted">
                <Icon className="mt-0.5 size-4 shrink-0 text-sidebar-indicator" aria-hidden />
                {text}
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <main className="flex items-center justify-center px-6 py-16 sm:px-12">
        <form onSubmit={submit} className="w-full max-w-sm">
          <img src={logo} alt="" className="mb-8 size-9 lg:hidden" />
          <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
          <p className="mt-2 text-sm text-muted-foreground">Use the same account you use for the rest of the organization.</p>

          <div className="mt-8 flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="username">Username</Label>
              <Input id="username" name="username" autoComplete="username" autoFocus required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={reveal ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  className="pr-10"
                  onKeyUp={watchCaps}
                  onKeyDown={watchCaps}
                  onBlur={() => setCapsLock(false)}
                  aria-describedby={capsLock ? 'caps-lock' : undefined}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute top-1/2 right-1 size-7 -translate-y-1/2 text-muted-foreground"
                  onClick={() => setReveal((shown) => !shown)}
                  aria-label={reveal ? 'Hide the password' : 'Show the password'}
                  aria-pressed={reveal}
                >
                  {reveal ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              {capsLock && (
                <p id="caps-lock" className="flex items-center gap-1.5 text-xs text-warning">
                  <TriangleAlert className="size-3.5" aria-hidden /> Caps Lock is on.
                </p>
              )}
            </div>
          </div>

          {error && (
            <Alert variant="destructive" className="mt-5" role="alert">
              <TriangleAlert />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={pending} className="mt-6 w-full">
            {pending && <Spinner />}
            {pending ? 'Checking the directory…' : 'Sign in'}
          </Button>
        </form>
      </main>
    </div>
  )
}

/**
 * A branch of the projects map — a system, its applications, their
 * environments — drawn faintly behind the panel's words: the portal's own
 * picture of the organization, not a decoration from anywhere else. It draws
 * itself once when the page opens; with reduced motion it is simply there.
 */
function BranchArt() {
  // Root at the left, two levels of children: the shape mind-map.tsx draws.
  const root = { x: 60, y: 300 }
  const apps = [
    { x: 250, y: 150, envs: [70, 130, 190] },
    { x: 250, y: 330, envs: [290, 350] },
    { x: 250, y: 470, envs: [440, 500, 560] },
  ]
  const link = (a: { x: number; y: number }, b: { x: number; y: number }) => `M${a.x},${a.y} C${(a.x + b.x) / 2},${a.y} ${(a.x + b.x) / 2},${b.y} ${b.x},${b.y}`
  const draw = (i: number) => ({ initial: { pathLength: 0, opacity: 0 }, animate: { pathLength: 1, opacity: 1 }, transition: { duration: 0.9, delay: 0.15 + i * 0.08, ease: [0.22, 1, 0.36, 1] as const } })
  let i = 0
  return (
    <svg viewBox="0 0 520 640" className="pointer-events-none absolute top-10 right-10 h-[52%] text-rail-muted/45" fill="none" aria-hidden>
      {apps.map((app) => (
        <g key={app.y}>
          <m.path d={link(root, app)} stroke="currentColor" strokeWidth="2" {...draw(i++)} />
          {app.envs.map((y) => (
            <m.path key={y} d={link(app, { x: 440, y })} stroke="currentColor" strokeWidth="2" {...draw(i++)} />
          ))}
        </g>
      ))}
      <circle cx={root.x} cy={root.y} r="9" className="fill-sidebar-indicator" />
      {apps.map((app) => (
        <g key={app.y}>
          <circle cx={app.x} cy={app.y} r="6" fill="currentColor" />
          {app.envs.map((y) => (
            <circle key={y} cx={440} cy={y} r="4" fill="currentColor" />
          ))}
        </g>
      ))}
    </svg>
  )
}
