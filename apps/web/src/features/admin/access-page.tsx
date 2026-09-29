import { useMemo, useState, type FormEvent } from 'react'
import { Check, Minus, Trash2, User, Users } from 'lucide-react'
import { toast } from 'sonner'
import { PAGE, PageHeader, Section, Split } from '@/components/page-layout.tsx'
import { Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { ScopeType } from '@/features/auth/profile-context.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { rbacApi, type Binding, type Catalogue, type Explanation, type SubjectType } from './api.ts'

const when = (iso: string) => new Date(iso).toLocaleString()

/**
 * Who may do what, and the record of every change to it. Roles and what they
 * allow are fixed in code and listed here for reference; the page manages who
 * holds them. Mounted behind `rbac.manage`, which the API checks again.
 */
export function AccessPage() {
  usePageTitle('Access')
  const catalogue = useResource(() => rbacApi.catalogue(), [])
  const bindings = useResource(() => rbacApi.bindings(), [])
  const audit = useResource(() => rbacApi.audit(), [])
  const reload = () => {
    bindings.reload()
    audit.reload()
  }

  return (
    <div className={PAGE}>
      <PageHeader
        title="Access"
        description="Who holds which role. Grant to a directory group where you can; grant to one person by name only as an exception."
      />

      <Split
        aside={
          <>
            {catalogue.data && <GrantForm catalogue={catalogue.data} onGranted={reload} />}
            <CheckSomeone />
            {catalogue.data && <RolesReference catalogue={catalogue.data} />}
          </>
        }
      >
        <Section title="Bindings" description="Built-in ones come from configuration and cannot be removed here." flush>
          {bindings.error && !bindings.data ? (
            <p className="p-4 text-sm text-destructive">{bindings.error}</p>
          ) : !bindings.data || !catalogue.data ? (
            <Loading label="Loading bindings…">
              <RowsSkeleton rows={4} bordered={false} />
            </Loading>
          ) : (
            <BindingList bindings={bindings.data} catalogue={catalogue.data} onChanged={reload} />
          )}
        </Section>

        <Section title="Audit log" description="Every grant and removal, newest first." flush>
          {!audit.data ? (
            <Loading label="Loading the audit log…">
              <RowsSkeleton rows={3} bordered={false} />
            </Loading>
          ) : audit.data.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Nothing has been granted or removed yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {audit.data.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2 px-4 py-2.5">
                  <span className="font-medium">{entry.actor}</span>
                  <span className={entry.action === 'grant' ? '' : 'text-muted-foreground'}>
                    {entry.action === 'grant' ? 'granted' : 'removed'}
                  </span>
                  <span>{roleLabel(catalogue.data, entry.binding.role)}</span>
                  <span className="text-muted-foreground">{entry.action === 'grant' ? 'to' : 'from'}</span>
                  <Subject binding={entry.binding} />
                  {entry.binding.scope && <ScopeBadge binding={entry.binding} />}
                  <span className="ml-auto text-xs text-muted-foreground">{when(entry.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </Split>
    </div>
  )
}

function roleLabel(catalogue: Catalogue | undefined, role: string): string {
  return catalogue?.roles.find((r) => r.id === role)?.label ?? role
}

function Subject({ binding }: { binding: Pick<Binding, 'subjectType' | 'subject'> }) {
  const Icon = binding.subjectType === 'user' ? User : Users
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="size-3.5 text-muted-foreground" aria-label={binding.subjectType === 'user' ? 'Person' : 'Group'} />
      <code>{binding.subject}</code>
    </span>
  )
}

function ScopeBadge({ binding }: { binding: Pick<Binding, 'scopeType' | 'scope'> }) {
  return (
    <Badge variant="outline" className="font-normal">
      {binding.scopeType} <code>{binding.scope}</code>
    </Badge>
  )
}

/** Grouped by role, because "who can approve?" is the question people bring here. */
function BindingList({ bindings, catalogue, onChanged }: { bindings: Binding[]; catalogue: Catalogue; onChanged: () => void }) {
  const byRole = useMemo(
    () =>
      catalogue.roles
        .map((role) => ({ role, bindings: bindings.filter((b) => b.role === role.id) }))
        .filter((group) => group.bindings.length > 0),
    [bindings, catalogue],
  )
  // A role removed from code leaves its rows behind; show them, flagged, so
  // they can be cleaned up rather than silently ignored.
  const orphans = bindings.filter((b) => !catalogue.roles.some((r) => r.id === b.role))

  return (
    <div className="divide-y">
      {byRole.map(({ role, bindings }) => (
        <section key={role.id}>
          <h3 className="bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
            {role.label} ({bindings.length})
          </h3>
          <ul className="divide-y">
            {bindings.map((b) => (
              <BindingRow key={b.id} binding={b} onChanged={onChanged} />
            ))}
          </ul>
        </section>
      ))}
      {orphans.length > 0 && (
        <section>
          <h3 className="bg-muted/40 px-4 py-2 text-xs font-medium text-destructive">
            Roles that no longer exist ({orphans.length}) — these grant nothing
          </h3>
          <ul className="divide-y">
            {orphans.map((b) => (
              <BindingRow key={b.id} binding={b} onChanged={onChanged} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function BindingRow({ binding: b, onChanged }: { binding: Binding; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  async function remove() {
    setBusy(true)
    try {
      await rbacApi.remove(b.id)
      toast.success(`Removed from ${b.subject}`)
      onChanged()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove it. Try again.')
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <li className="flex items-start gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Subject binding={b} />
          {b.scope ? <ScopeBadge binding={b} /> : <span className="text-xs text-muted-foreground">everywhere</span>}
          {b.builtIn && <Badge variant="secondary">Built in</Badge>}
        </div>
        {b.reason && <p className="mt-1 text-muted-foreground">{b.reason}</p>}
        {!b.builtIn && (
          <p className="mt-1 text-xs text-muted-foreground">
            Added by {b.createdBy}, {when(b.createdAt)}
            {b.expiresAt && ` · expires ${new Date(b.expiresAt).toLocaleDateString()}`}
          </p>
        )}
      </div>
      {!b.builtIn &&
        (confirming ? (
          <div className="flex shrink-0 gap-1.5">
            {/* Red: removing someone's access is the action on this row. */}
            <Button size="sm" variant="destructive" disabled={busy} onClick={remove}>
              {busy && <Spinner />}
              Remove
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </div>
        ) : (
          <Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label={`Remove ${b.subject}’s binding`} onClick={() => setConfirming(true)}>
            <Trash2 className="size-4" />
          </Button>
        ))}
    </li>
  )
}

function GrantForm({ catalogue, onGranted }: { catalogue: Catalogue; onGranted: () => void }) {
  const roles = catalogue.roles.filter((r) => r.id !== 'member')
  const [subjectType, setSubjectType] = useState<SubjectType>('group')
  const [subject, setSubject] = useState('')
  const [role, setRole] = useState('')
  const [scopeType, setScopeType] = useState<ScopeType>('global')
  const [scope, setScope] = useState('')
  const [reason, setReason] = useState('')
  const [expires, setExpires] = useState('')
  const [busy, setBusy] = useState(false)

  const person = subjectType === 'user'
  const ready = subject.trim() && role && (scopeType === 'global' || scope.trim()) && (!person || reason.trim())

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    try {
      await rbacApi.add({
        subjectType,
        subject: subject.trim(),
        role,
        scopeType,
        scope: scopeType === 'global' ? null : scope.trim(),
        reason: reason.trim() || null,
        // End of the chosen day, in the browser's time zone.
        expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
      })
      toast.success(`${roleLabel(catalogue, role)} granted to ${subject.trim()}`)
      setSubject('')
      setReason('')
      setScope('')
      setExpires('')
      onGranted()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not grant it. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Grant a role">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="grant-who">To</Label>
          <ToggleGroup
            id="grant-who"
            type="single"
            variant="outline"
            value={subjectType}
            onValueChange={(value) => value && setSubjectType(value as SubjectType)}
          >
            <ToggleGroupItem value="group">A group</ToggleGroupItem>
            <ToggleGroupItem value="user">One person</ToggleGroupItem>
          </ToggleGroup>
          <Input
            aria-label={person ? 'Login name' : 'Group name'}
            placeholder={person ? 'Login name, like jsmith' : 'Directory group, like DEVJAVA'}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="grant-role">Role</Label>
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger id="grant-role" className="w-full">
              <SelectValue placeholder="Choose a role" />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {role && <p className="text-xs text-muted-foreground">{roles.find((r) => r.id === role)?.description}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="grant-scope">Applies to</Label>
          <Select value={scopeType} onValueChange={(v) => setScopeType(v as ScopeType)}>
            <SelectTrigger id="grant-scope" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">Everything</SelectItem>
              <SelectItem value="team">One team’s projects</SelectItem>
              <SelectItem value="project">One Azure DevOps project</SelectItem>
            </SelectContent>
          </Select>
          {scopeType !== 'global' && (
            <>
              <Input
                aria-label={scopeType === 'team' ? 'Team' : 'Project'}
                placeholder={scopeType === 'team' ? 'Team, as inventories names it' : 'Project name'}
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              {scopeType === 'team' && (
                <p className="text-xs text-muted-foreground">
                  Matches the owning teams in each system’s <code>project.yml</code>.
                </p>
              )}
            </>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="grant-reason">Reason{person ? '' : ' (optional)'}</Label>
          <Textarea
            id="grant-reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={person ? 'Why this person, rather than their group' : ''}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="grant-expires">Expires (optional)</Label>
          <Input id="grant-expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </div>

        <Button type="submit" disabled={!ready || busy}>
          {busy && <Spinner />}
          Grant
        </Button>
      </form>
    </Section>
  )
}

/** "Why can bob approve?" — and, as often, why they can't. */
function CheckSomeone() {
  const [uid, setUid] = useState('')
  const [result, setResult] = useState<Explanation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function check(event: FormEvent) {
    event.preventDefault()
    if (!uid.trim()) return
    setBusy(true)
    setError(null)
    try {
      setResult(await rbacApi.explain(uid.trim()))
    } catch (err) {
      setResult(null)
      setError(err instanceof ApiError ? err.message : 'Could not check that account.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Check someone" description="What a person can do, and which binding gives it to them.">
      <form onSubmit={check} className="flex gap-2">
        <Input
          aria-label="Login name to check"
          placeholder="Login name"
          value={uid}
          onChange={(e) => setUid(e.target.value)}
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" variant="outline" disabled={busy || !uid.trim()}>
          {busy ? <Spinner /> : 'Check'}
        </Button>
      </form>
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      {result && (
        <div className="mt-4 space-y-4 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Directory groups</p>
            {result.groups.length === 0 ? (
              <p className="mt-1 text-muted-foreground">None</p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-1">
                {result.groups.map((g) => (
                  <li key={g}>
                    <Badge variant="outline" className="font-normal">
                      {g}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <ul className="space-y-2.5">
            {result.permissions.map((p) => (
              <li key={p.permission} className="flex gap-2">
                {p.grants.length > 0 ? (
                  <Check className="mt-0.5 size-4 shrink-0" aria-label="Has it" />
                ) : (
                  <Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Does not have it" />
                )}
                <div className="min-w-0">
                  <p className={p.grants.length ? '' : 'text-muted-foreground'}>{p.description}</p>
                  {p.grants.map((g) => (
                    <p key={`${g.via}:${g.scope ?? ''}`} className="text-xs text-muted-foreground">
                      {g.via}
                      {g.scope && ` — ${g.scopeType} ${g.scope}`}
                    </p>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  )
}

function RolesReference({ catalogue }: { catalogue: Catalogue }) {
  const describe = (id: string) => catalogue.permissions.find((p) => p.id === id)?.description ?? id
  return (
    <Section title="Roles" description="Defined in code. This page only decides who holds them.">
      <ul className="space-y-4">
        {catalogue.roles.map((role) => (
          <li key={role.id}>
            <p className="text-sm font-medium">{role.label}</p>
            <p className="text-xs text-muted-foreground">{role.description}</p>
            {/* The ids, with the full description on hover — the list is for scanning. */}
            <ul className="mt-2 flex flex-wrap gap-1">
              {role.permissions.map((p) => (
                <li key={p}>
                  <Badge variant="outline" className="font-mono font-normal" title={describe(p)}>
                    {p}
                  </Badge>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Section>
  )
}
