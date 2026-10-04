import { useEffect, useState, type FormEvent } from 'react'
import { CircleCheck, CircleMinus, Eye, History, UserSearch } from 'lucide-react'
import { toast } from 'sonner'
import { Section, Split } from '@/components/page-layout.tsx'
import { FactsSkeleton, Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { useSession } from '@/features/auth/session-context.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { rbacApi, type Catalogue, type Explanation } from './api.ts'
import { RoleBadge, ScopeBadge, Subject } from './shared.tsx'

const RECENT = 'eidp.access.checked'

function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? '[]') as string[]
  } catch {
    return []
  }
}
function remember(uid: string) {
  try {
    localStorage.setItem(RECENT, JSON.stringify([uid, ...recent().filter((u) => u.toLowerCase() !== uid.toLowerCase())].slice(0, 6)))
  } catch {
    // Private window: nothing remembered.
  }
}

/**
 * "Why can bob approve?" — and as often, why they can't. Everything one
 * person may do, each permission with the group or binding that gives it,
 * the bindings that reach them, and a way to see the portal as they do.
 * The person checked lives in the URL (`?tab=check&uid=bob`), so a check is
 * a link to send.
 */
export function CheckTab({ uid, onUid, catalogue }: { uid: string; onUid: (uid: string) => void; catalogue: Catalogue }) {
  const [name, setName] = useState(uid)
  const [result, setResult] = useState<Explanation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [past, setPast] = useState(recent)

  useEffect(() => {
    setName(uid)
    if (!uid) {
      setResult(null)
      setError(null)
      return
    }
    let stale = false
    setBusy(true)
    setError(null)
    rbacApi
      .explain(uid)
      .then((r) => {
        if (stale) return
        setResult(r)
        remember(r.uid)
        setPast(recent())
      })
      .catch((err: unknown) => {
        if (stale) return
        setResult(null)
        setError(err instanceof ApiError ? err.message : 'Could not check that account.')
      })
      .finally(() => !stale && setBusy(false))
    return () => {
      stale = true
    }
  }, [uid])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (name.trim()) onUid(name.trim())
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1 sm:max-w-md">
          <UserSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Login name to check"
            placeholder="Login name, like bob"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="pl-8 font-mono"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? <Spinner /> : null} Check
        </Button>
        {past.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <History className="size-3.5" aria-hidden /> Recently:
            {past.map((p) => (
              <button key={p} type="button" onClick={() => onUid(p)} className="rounded-full border px-2 py-0.5 font-mono transition-colors hover:bg-secondary">
                {p}
              </button>
            ))}
          </div>
        )}
      </form>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {busy && !result ? (
        <Loading label="Checking…">
          <Split aside={<FactsSkeleton className="" />} className="">
            <RowsSkeleton rows={6} />
          </Split>
        </Loading>
      ) : result ? (
        <Result result={result} catalogue={catalogue} />
      ) : (
        !error && (
          <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
            Name someone to see everything they may do in the portal, and exactly which group or binding gives it to them.
          </p>
        )
      )}
    </div>
  )
}

function Result({ result, catalogue }: { result: Explanation; catalogue: Catalogue }) {
  const has = result.permissions.filter((p) => p.grants.length > 0)
  const not = result.permissions.filter((p) => p.grants.length === 0)
  return (
    <Split
      className="reveal"
      aside={
        <>
          <Section title={<Subject binding={{ subjectType: 'user', subject: result.uid }} size="md" />} action={<ViewAsButton uid={result.uid} />}>
            <p className="text-xs text-muted-foreground">Directory groups</p>
            {result.groups.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">In no group.</p>
            ) : (
              <ul className="mt-1.5 flex flex-wrap gap-1">
                {result.groups.map((g) => (
                  <li key={g}>
                    <Badge variant="outline" className="font-mono font-normal">
                      {g}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Bindings that reach them" description="Granted to them by name, or to a group they are in.">
            <ul className="space-y-3">
              {result.bindings.map((b) => (
                <li key={b.id} className="text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <RoleBadge role={b.role} catalogue={catalogue} />
                    <ScopeBadge binding={b} />
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    via {b.subjectType === 'user' ? 'their own name' : <>group <code>{b.subject}</code></>}
                    {b.builtIn && ' · built in'}
                    {b.expiresAt && ` · until ${new Date(b.expiresAt).toLocaleDateString()}`}
                  </p>
                </li>
              ))}
            </ul>
          </Section>
        </>
      }
    >
      <Section title={`Can do (${has.length})`} flush>
        <ul className="divide-y">
          {has.map((p) => (
            <li key={p.permission} className="flex gap-3 px-6 py-3">
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="Has it" />
              <div className="min-w-0">
                <p className="text-sm">{p.description}</p>
                <p className="mt-1 flex flex-wrap gap-1.5">
                  <code className="text-xs text-muted-foreground">{p.permission}</code>
                  {p.grants.map((g) => (
                    <Badge key={`${g.via}:${g.scope ?? ''}`} variant="secondary" className="font-normal">
                      {g.via}
                      {g.scope && ` · ${g.scopeType} ${g.scope}`}
                    </Badge>
                  ))}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Section>
      {not.length > 0 && (
        <Section title={`Cannot do (${not.length})`} flush>
          <ul className="divide-y">
            {not.map((p) => (
              <li key={p.permission} className="flex gap-3 px-6 py-3 text-muted-foreground">
                <CircleMinus className="mt-0.5 size-4 shrink-0" aria-label="Does not have it" />
                <div className="min-w-0">
                  <p className="text-sm">{p.description}</p>
                  <code className="text-xs">{p.permission}</code>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </Split>
  )
}

/**
 * Opens the portal as this person, read-only, for as long as it takes to see
 * what they see. The API refuses anything that is not a read, and records it.
 */
function ViewAsButton({ uid }: { uid: string }) {
  const { can } = useProfile()
  const { session, viewAs } = useSession()
  const [busy, setBusy] = useState(false)
  if (!can('rbac.view_as') || uid.toLowerCase() === session?.uid.toLowerCase()) return null

  async function start() {
    setBusy(true)
    try {
      viewAs((await rbacApi.assume(uid)).token)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not view as them. Try again.')
      setBusy(false)
    }
  }

  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={start}>
      {busy ? <Spinner /> : <Eye />}
      View as
    </Button>
  )
}
