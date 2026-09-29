import { useMemo, useState, type FormEvent } from 'react'
import { Check, Eye, Minus, Plus, Search, ShieldCheck, Trash2, User, UserSearch, Users } from 'lucide-react'
import { toast } from 'sonner'
import { PAGE, PageHeader } from '@/components/page-layout.tsx'
import { Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useProfile, type ScopeType } from '@/features/auth/profile-context.tsx'
import { useSession } from '@/features/auth/session-context.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { rbacApi, type AuditEntry, type Binding, type Catalogue, type Explanation, type SubjectType } from './api.ts'

const when = (iso: string) => new Date(iso).toLocaleString()

/**
 * Who may do what, and the record of every change to it. Roles and what they
 * allow are fixed in code; this page manages who holds them.
 *
 * The page itself is the overview — a card per role, then the bindings and
 * the audit log as tables. Every action happens in a dialog opened from the
 * header or a row, so the tables stay tables. Mounted behind `rbac.manage`,
 * which the API checks again.
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

  const [granting, setGranting] = useState(false)
  // A login name to open "Check someone" on — '' opens it empty, null keeps it shut.
  const [checking, setChecking] = useState<string | null>(null)
  const [role, setRole] = useState<string>('all')

  return (
    <div className={PAGE}>
      <PageHeader
        title="Access"
        description="Who holds which role. Grant to a directory group where you can; grant to one person by name only as an exception."
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setChecking('')}>
              <UserSearch /> Check someone
            </Button>
            <Button size="sm" onClick={() => setGranting(true)} disabled={!catalogue.data}>
              <Plus /> Grant a role
            </Button>
          </>
        }
      />

      {catalogue.data && bindings.data && (
        <RoleCards catalogue={catalogue.data} bindings={bindings.data} active={role} onPick={setRole} />
      )}

      <Tabs defaultValue="bindings" className="mt-6">
        <TabsList>
          <TabsTrigger value="bindings">
            Bindings{bindings.data && <span className="text-muted-foreground tabular-nums">{bindings.data.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
        </TabsList>

        <TabsContent value="bindings" className="mt-4">
          {bindings.error && !bindings.data ? (
            <p className="text-sm text-destructive">{bindings.error}</p>
          ) : !bindings.data || !catalogue.data ? (
            <Loading label="Loading bindings…">
              <RowsSkeleton rows={4} />
            </Loading>
          ) : (
            <BindingsTable
              bindings={bindings.data}
              catalogue={catalogue.data}
              role={role}
              onRole={setRole}
              onChanged={reload}
              onCheck={setChecking}
            />
          )}
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          {!audit.data || !catalogue.data ? (
            <Loading label="Loading the audit log…">
              <RowsSkeleton rows={4} />
            </Loading>
          ) : (
            <AuditTable entries={audit.data} catalogue={catalogue.data} />
          )}
        </TabsContent>

        <TabsContent value="roles" className="mt-4">
          {catalogue.data && <RolesReference catalogue={catalogue.data} />}
        </TabsContent>
      </Tabs>

      {catalogue.data && (
        <GrantDialog open={granting} onOpenChange={setGranting} catalogue={catalogue.data} onGranted={reload} />
      )}
      <CheckDialog uid={checking} onClose={() => setChecking(null)} />
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
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-label={binding.subjectType === 'user' ? 'Person' : 'Group'} />
      <code>{binding.subject}</code>
    </span>
  )
}

function ScopeBadge({ binding }: { binding: Pick<Binding, 'scopeType' | 'scope'> }) {
  if (!binding.scope) return <span className="text-muted-foreground">Everywhere</span>
  return (
    <Badge variant="outline" className="font-normal">
      {binding.scopeType} <code>{binding.scope}</code>
    </Badge>
  )
}

// ---- overview ----------------------------------------------------------------

/** A card per role with how many bindings hold it — and a filter for the table. */
function RoleCards({
  catalogue,
  bindings,
  active,
  onPick,
}: {
  catalogue: Catalogue
  bindings: Binding[]
  active: string
  onPick: (role: string) => void
}) {
  return (
    <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {catalogue.roles.map((role) => {
        const count = bindings.filter((b) => b.role === role.id).length
        const selected = active === role.id
        return (
          <button
            key={role.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onPick(selected ? 'all' : role.id)}
            className={`rounded-xl border bg-card p-4 text-left shadow-sm transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none ${
              selected ? 'border-ring ring-1 ring-ring/40' : ''
            }`}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{role.label}</span>
              <span className="text-2xl font-semibold tabular-nums">{count}</span>
            </span>
            <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{role.description}</span>
          </button>
        )
      })}
    </div>
  )
}

// ---- bindings ----------------------------------------------------------------

function BindingsTable({
  bindings,
  catalogue,
  role,
  onRole,
  onChanged,
  onCheck,
}: {
  bindings: Binding[]
  catalogue: Catalogue
  role: string
  onRole: (role: string) => void
  onChanged: () => void
  onCheck: (uid: string) => void
}) {
  const [query, setQuery] = useState('')
  const [removing, setRemoving] = useState<Binding | null>(null)
  const known = new Set(catalogue.roles.map((r) => r.id))

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return bindings.filter(
      (b) =>
        (role === 'all' || b.role === role) &&
        (!needle || [b.subject, b.scope, b.reason, b.createdBy].some((t) => t?.toLowerCase().includes(needle))),
    )
  }, [bindings, role, query])

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search bindings"
            placeholder="Search by group, person, scope or reason"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        <Select value={role} onValueChange={onRole}>
          <SelectTrigger aria-label="Role" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any role</SelectItem>
            {catalogue.roles.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Who</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Applies to</TableHead>
            <TableHead className="hidden lg:table-cell">Reason</TableHead>
            <TableHead className="hidden md:table-cell">Added</TableHead>
            <TableHead className="w-24 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                No bindings match.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((b) => (
              <TableRow key={b.id}>
                <TableCell>
                  <Subject binding={b} />
                </TableCell>
                <TableCell>
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {known.has(b.role) ? (
                      roleLabel(catalogue, b.role)
                    ) : (
                      // A role removed from code leaves its rows inert; flagged so they get cleaned up.
                      <span className="text-destructive">{b.role} (no longer exists)</span>
                    )}
                    {b.builtIn && <Badge variant="secondary">Built in</Badge>}
                  </span>
                </TableCell>
                <TableCell>
                  <ScopeBadge binding={b} />
                </TableCell>
                <TableCell className="hidden max-w-72 whitespace-normal text-muted-foreground lg:table-cell">
                  {b.reason ?? '—'}
                  {b.expiresAt && (
                    <span className="block text-xs">Expires {new Date(b.expiresAt).toLocaleDateString()}</span>
                  )}
                </TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">
                  {b.builtIn ? (
                    'Configuration'
                  ) : (
                    <>
                      {b.createdBy}
                      <span className="block text-xs tabular-nums">{new Date(b.createdAt).toLocaleDateString()}</span>
                    </>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    {b.subjectType === 'user' && (
                      <Button size="icon" variant="ghost" className="size-8" aria-label={`Check ${b.subject}`} onClick={() => onCheck(b.subject)}>
                        <UserSearch className="size-4" />
                      </Button>
                    )}
                    {!b.builtIn && (
                      <Button size="icon" variant="ghost" className="size-8" aria-label={`Remove ${b.subject}’s binding`} onClick={() => setRemoving(b)}>
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <RemoveDialog binding={removing} catalogue={catalogue} onClose={() => setRemoving(null)} onRemoved={onChanged} />
    </div>
  )
}

/** Removing someone's access asks first, and says exactly what goes. */
function RemoveDialog({
  binding,
  catalogue,
  onClose,
  onRemoved,
}: {
  binding: Binding | null
  catalogue: Catalogue
  onClose: () => void
  onRemoved: () => void
}) {
  const [busy, setBusy] = useState(false)

  async function remove() {
    if (!binding) return
    setBusy(true)
    try {
      await rbacApi.remove(binding.id)
      toast.success(`Removed ${roleLabel(catalogue, binding.role)} from ${binding.subject}`)
      onRemoved()
      onClose()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove it. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={binding !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this binding?</AlertDialogTitle>
          <AlertDialogDescription>
            {binding && (
              <>
                {binding.subjectType === 'user' ? 'The person' : 'Everyone in the group'} <code>{binding.subject}</code> loses{' '}
                {roleLabel(catalogue, binding.role)}
                {binding.scope ? ` for ${binding.scopeType} ${binding.scope}` : ''} straight away, unless another binding
                gives it to them. The removal is recorded in the audit log.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(event) => {
              // Stay open until the API answers, so a failure is not hidden by the close.
              event.preventDefault()
              void remove()
            }}
          >
            {busy && <Spinner />}
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---- granting ----------------------------------------------------------------

function GrantDialog({
  open,
  onOpenChange,
  catalogue,
  onGranted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  catalogue: Catalogue
  onGranted: () => void
}) {
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

  function reset() {
    setSubjectType('group')
    setSubject('')
    setRole('')
    setScopeType('global')
    setScope('')
    setReason('')
    setExpires('')
  }

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
      onGranted()
      reset()
      onOpenChange(false)
    } catch (err) {
      // Kept open with what was typed, so a typo is one fix away.
      toast.error(err instanceof ApiError ? err.message : 'Could not grant it. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Grant a role</DialogTitle>
            <DialogDescription>Applies at once and is recorded in the audit log.</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="grant-subject">To</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              value={subjectType}
              aria-label="Grant to"
              onValueChange={(value) => value && setSubjectType(value as SubjectType)}
            >
              <ToggleGroupItem value="group">
                <Users /> A group
              </ToggleGroupItem>
              <ToggleGroupItem value="user">
                <User /> One person
              </ToggleGroupItem>
            </ToggleGroup>
            <Input
              id="grant-subject"
              aria-label={person ? 'Login name' : 'Group name'}
              placeholder={person ? 'Login name, like jsmith' : 'Directory group, like DEVJAVA'}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
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
            </div>
          </div>
          {role && <p className="-mt-2 text-xs text-muted-foreground">{roles.find((r) => r.id === role)?.description}</p>}

          {scopeType !== 'global' && (
            <div className="space-y-2">
              <Label htmlFor="grant-scope-name">{scopeType === 'team' ? 'Team' : 'Project'}</Label>
              <Input
                id="grant-scope-name"
                placeholder={scopeType === 'team' ? 'Team, as inventories names it' : 'Project name'}
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              {scopeType === 'team' && (
                <p className="text-xs text-muted-foreground">
                  Matches the owning teams in each system’s <code>team.yml</code>.
                </p>
              )}
            </div>
          )}

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

          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || busy}>
              {busy && <Spinner />}
              Grant
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---- checking someone --------------------------------------------------------

/** "Why can bob approve?" — and, as often, why they can't. Opened on `uid` ('' for empty). */
function CheckDialog({ uid, onClose }: { uid: string | null; onClose: () => void }) {
  const [name, setName] = useState('')
  const [result, setResult] = useState<Explanation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [opened, setOpened] = useState<string | null>(null)

  async function check(who: string) {
    if (!who.trim()) return
    setBusy(true)
    setError(null)
    try {
      setResult(await rbacApi.explain(who.trim()))
    } catch (err) {
      setResult(null)
      setError(err instanceof ApiError ? err.message : 'Could not check that account.')
    } finally {
      setBusy(false)
    }
  }

  // Opening on a name (from a table row) fills it in and checks straight away.
  if (uid !== opened) {
    setOpened(uid)
    setName(uid ?? '')
    setResult(null)
    setError(null)
    if (uid) void check(uid)
  }

  return (
    <Dialog open={uid !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Check someone</DialogTitle>
          <DialogDescription>What a person can do, and which group or binding gives it to them.</DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            void check(name)
          }}
          className="flex gap-2"
        >
          <Input
            aria-label="Login name to check"
            placeholder="Login name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          <Button type="submit" variant="outline" disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : 'Check'}
          </Button>
        </form>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {result && (
          <div className="space-y-4 text-sm">
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
            <DialogFooter>
              <ViewAsButton uid={result.uid} />
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
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
    <Button variant="outline" disabled={busy} onClick={start}>
      {busy ? <Spinner /> : <Eye />}
      View the portal as {uid}
    </Button>
  )
}

// ---- audit and reference -----------------------------------------------------

function AuditTable({ entries, catalogue }: { entries: AuditEntry[]; catalogue: Catalogue }) {
  if (entries.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
        Nothing has been granted, removed or viewed as yet.
      </p>
    )
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>When</TableHead>
            <TableHead>Who</TableHead>
            <TableHead>What</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <TableRow key={entry.id}>
              <TableCell className="w-48 text-muted-foreground tabular-nums">{when(entry.at)}</TableCell>
              <TableCell className="w-32 font-medium">{entry.actor}</TableCell>
              <TableCell className="whitespace-normal">
                <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                  {entry.action === 'assume' ? (
                    <>
                      <Eye className="size-3.5 text-muted-foreground" aria-hidden />
                      <span className="text-muted-foreground">Viewed the portal as</span>
                      <Subject binding={{ subjectType: 'user', subject: entry.target }} />
                    </>
                  ) : (
                    <>
                      <Badge variant={entry.action === 'grant' ? 'secondary' : 'outline'}>
                        {entry.action === 'grant' ? 'Granted' : 'Removed'}
                      </Badge>
                      <span>{roleLabel(catalogue, entry.binding.role)}</span>
                      <span className="text-muted-foreground">{entry.action === 'grant' ? 'to' : 'from'}</span>
                      <Subject binding={entry.binding} />
                      {entry.binding.scope && <ScopeBadge binding={entry.binding} />}
                    </>
                  )}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function RolesReference({ catalogue }: { catalogue: Catalogue }) {
  const describe = (id: string) => catalogue.permissions.find((p) => p.id === id)?.description ?? id
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {catalogue.roles.map((role) => (
        <Card key={role.id} className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="size-4 text-muted-foreground" />
              {role.label}
            </CardTitle>
            <CardDescription>{role.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {role.permissions.map((p) => (
                <li key={p} className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    {describe(p)}
                    <code className="ml-1.5 text-xs text-muted-foreground">{p}</code>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
