import { useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { ArrowDown, ArrowUp, ArrowUpDown, Copy, MoreHorizontal, Pencil, Search, Trash2, UserSearch, X } from 'lucide-react'
import { toast } from 'sonner'
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
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ApiError } from '@/lib/api-client.ts'
import { rbacApi, type Binding, type Catalogue } from './api.ts'
import { ExpiryField, expiryToIso, isoToDay } from './expiry-field.tsx'
import { RoleBadge, roleLabel, ScopeBadge, STATUS, StatusBadge, statusOf, Subject, type Status } from './shared.tsx'

type SortKey = 'who' | 'role' | 'added' | 'expires'

/**
 * Every binding, as a table you can work in: search across who, scope, reason
 * and who granted it; filter by role, by group or person, and by status;
 * sort by any column; select several and remove them together. Each row's
 * menu checks the person, edits the reason and expiry, grants the same to
 * someone else, or removes it. The filters live in the URL, so "everything
 * expiring" is a link.
 */
export function BindingsTab({
  bindings,
  catalogue,
  onChanged,
  onCheck,
  onGrantLike,
}: {
  bindings: Binding[]
  catalogue: Catalogue
  onChanged: () => void
  onCheck: (uid: string) => void
  onGrantLike: (binding: Binding) => void
}) {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const role = params.get('role') ?? 'all'
  const who = params.get('who') ?? 'all'
  const status = (params.get('status') ?? 'all') as Status | 'all'
  const set = (key: string, value: string, fallback: string) => {
    const next = new URLSearchParams(params)
    if (value === fallback) next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
  }

  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'role', dir: 1 })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [removing, setRemoving] = useState<Binding[] | null>(null)
  const [editing, setEditing] = useState<Binding | null>(null)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const filtered = bindings.filter(
      (b) =>
        (role === 'all' || b.role === role) &&
        (who === 'all' || b.subjectType === who) &&
        (status === 'all' || statusOf(b, catalogue) === status) &&
        (!needle || [b.subject, b.scope, b.reason, b.createdBy, roleLabel(catalogue, b.role)].some((t) => t?.toLowerCase().includes(needle))),
    )
    const key = (b: Binding): string | number => {
      switch (sort.key) {
        case 'who':
          return b.subject.toLowerCase()
        case 'role':
          return `${roleLabel(catalogue, b.role)} ${b.subject.toLowerCase()}`
        case 'added':
          return b.builtIn ? 0 : Date.parse(b.createdAt)
        case 'expires':
          return b.expiresAt ? Date.parse(b.expiresAt) : Number.MAX_SAFE_INTEGER
      }
    }
    return [...filtered].sort((a, b) => (key(a) < key(b) ? -sort.dir : key(a) > key(b) ? sort.dir : 0))
  }, [bindings, catalogue, q, role, who, status, sort])

  const selectable = rows.filter((b) => !b.builtIn)
  const chosen = selectable.filter((b) => selected.has(b.id))
  const all = selectable.length > 0 && chosen.length === selectable.length
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const filtering = q || role !== 'all' || who !== 'all' || status !== 'all'

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search bindings"
            placeholder="Search who, scope, reason or who granted it"
            value={q}
            onChange={(e) => set('q', e.target.value, '')}
            className="pl-8"
          />
        </div>
        <ToggleGroup type="single" variant="outline" size="sm" value={who} onValueChange={(v) => v && set('who', v, 'all')} aria-label="Granted to">
          <ToggleGroupItem value="all" className="px-3">
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="group" className="px-3">
            Groups
          </ToggleGroupItem>
          <ToggleGroupItem value="user" className="px-3">
            People
          </ToggleGroupItem>
        </ToggleGroup>
        <Select value={role} onValueChange={(v) => set('role', v, 'all')}>
          <SelectTrigger aria-label="Role" className="w-44" size="sm">
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
        <Select value={status} onValueChange={(v) => set('status', v, 'all')}>
          <SelectTrigger aria-label="Status" className="w-40" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            {(Object.keys(STATUS) as Status[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtering && (
          <Button variant="ghost" size="sm" onClick={() => setParams((p) => (['q', 'role', 'who', 'status'].forEach((k) => p.delete(k)), p), { replace: true })}>
            <X /> Clear
          </Button>
        )}
      </div>

      {chosen.length > 0 && (
        <div className="reveal flex flex-wrap items-center gap-3 border-b bg-secondary/60 px-4 py-2 text-sm">
          <span className="font-medium">{chosen.length} selected</span>
          <Button size="sm" variant="outline" className="text-destructive" onClick={() => setRemoving(chosen)}>
            <Trash2 /> Remove {chosen.length === 1 ? 'it' : `all ${chosen.length}`}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10">
              <Checkbox
                checked={all ? true : chosen.length > 0 ? 'indeterminate' : false}
                onCheckedChange={(on) => setSelected(on ? new Set(selectable.map((b) => b.id)) : new Set())}
                aria-label="Select every binding shown"
                disabled={selectable.length === 0}
              />
            </TableHead>
            <SortHead label="Who" k="who" sort={sort} onSort={setSort} />
            <SortHead label="Role" k="role" sort={sort} onSort={setSort} />
            <TableHead>Applies to</TableHead>
            <SortHead label="Status" k="expires" sort={sort} onSort={setSort} />
            <TableHead className="hidden xl:table-cell">Reason</TableHead>
            <SortHead label="Granted" k="added" sort={sort} onSort={setSort} className="hidden md:table-cell" />
            <TableHead className="w-12">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={8} className="h-28 text-center text-muted-foreground">
                {filtering ? 'No binding matches these filters.' : 'No bindings yet — grant a role to a group to start.'}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((b) => {
              const s = statusOf(b, catalogue)
              return (
                <TableRow key={b.id} data-state={selected.has(b.id) ? 'selected' : undefined} className={s === 'expired' ? 'opacity-70' : ''}>
                  <TableCell>
                    {!b.builtIn && <Checkbox checked={selected.has(b.id)} onCheckedChange={(on) => toggle(b.id, on === true)} aria-label={`Select ${b.subject}’s binding`} />}
                  </TableCell>
                  <TableCell className="max-w-56">
                    <Subject binding={b} />
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <RoleBadge role={b.role} catalogue={catalogue} />
                      {b.builtIn && <Badge variant="secondary">Built in</Badge>}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-48">
                    <ScopeBadge binding={b} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge binding={b} catalogue={catalogue} />
                  </TableCell>
                  <TableCell className="hidden max-w-52 truncate text-muted-foreground xl:table-cell" title={b.reason ?? undefined}>
                    {b.reason ?? '—'}
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
                    <RowMenu
                      binding={b}
                      onCheck={onCheck}
                      onEdit={() => setEditing(b)}
                      onGrantLike={() => onGrantLike(b)}
                      onRemove={() => setRemoving([b])}
                    />
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>
      <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
        {rows.length === bindings.length ? `${bindings.length} bindings` : `${rows.length} of ${bindings.length} bindings`} · Hover a role to see what it allows.
      </p>

      <RemoveDialog
        bindings={removing}
        catalogue={catalogue}
        onClose={() => setRemoving(null)}
        onRemoved={(ids) => {
          setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))))
          onChanged()
        }}
      />
      <EditDialog binding={editing} catalogue={catalogue} onClose={() => setEditing(null)} onSaved={onChanged} />
    </div>
  )
}

function SortHead({
  label,
  k,
  sort,
  onSort,
  className = '',
}: {
  label: string
  k: SortKey
  sort: { key: SortKey; dir: 1 | -1 }
  onSort: (sort: { key: SortKey; dir: 1 | -1 }) => void
  className?: string
}) {
  const active = sort.key === k
  const Icon = !active ? ArrowUpDown : sort.dir === 1 ? ArrowUp : ArrowDown
  return (
    <TableHead className={className} aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort({ key: k, dir: active ? (-sort.dir as 1 | -1) : 1 })}
        className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
      >
        {label}
        <Icon className={`size-3.5 ${active ? '' : 'opacity-40'}`} aria-hidden />
      </button>
    </TableHead>
  )
}

function RowMenu({
  binding: b,
  onCheck,
  onEdit,
  onGrantLike,
  onRemove,
}: {
  binding: Binding
  onCheck: (uid: string) => void
  onEdit: () => void
  onGrantLike: () => void
  onRemove: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="size-8 hover:bg-secondary data-[state=open]:bg-secondary" aria-label={`Actions for ${b.subject}’s binding`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {b.subjectType === 'user' && (
          <DropdownMenuItem onSelect={() => onCheck(b.subject)}>
            <UserSearch /> Check {b.subject}
          </DropdownMenuItem>
        )}
        {!b.builtIn && (
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil /> Edit reason and expiry
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onGrantLike}>
          <Copy /> Grant the same to…
        </DropdownMenuItem>
        {!b.builtIn && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 /> Remove
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Removing access asks first, says exactly what goes, and stays open until the API has answered. */
function RemoveDialog({
  bindings,
  catalogue,
  onClose,
  onRemoved,
}: {
  bindings: Binding[] | null
  catalogue: Catalogue
  onClose: () => void
  onRemoved: (ids: string[]) => void
}) {
  const [busy, setBusy] = useState(false)
  const one = bindings?.length === 1 ? bindings[0]! : null

  async function remove() {
    if (!bindings) return
    setBusy(true)
    const done: string[] = []
    const failed: string[] = []
    for (const b of bindings) {
      try {
        await rbacApi.remove(b.id)
        done.push(b.id)
      } catch (err) {
        failed.push(`${b.subject}: ${err instanceof ApiError ? err.message : 'could not remove it'}`)
      }
    }
    setBusy(false)
    if (done.length) {
      toast.success(one ? `Removed ${roleLabel(catalogue, one.role)} from ${one.subject}` : `Removed ${done.length} bindings`)
      onRemoved(done)
    }
    if (failed.length) toast.error(failed.join('\n'))
    else onClose()
  }

  return (
    <AlertDialog open={bindings !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{one ? 'Remove this binding?' : `Remove ${bindings?.length} bindings?`}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {one ? (
                <p>
                  {one.subjectType === 'user' ? 'The person' : 'Everyone in the group'} <code>{one.subject}</code> loses {roleLabel(catalogue, one.role)}
                  {one.scope ? ` for ${one.scopeType} ${one.scope}` : ''} straight away, unless another binding gives it to them.
                </p>
              ) : (
                <ul className="max-h-48 space-y-1 overflow-y-auto">
                  {bindings?.map((b) => (
                    <li key={b.id}>
                      <code>{b.subject}</code> — {roleLabel(catalogue, b.role)}
                      {b.scope ? ` (${b.scope})` : ''}
                    </li>
                  ))}
                </ul>
              )}
              <p>Every removal is recorded in the audit log.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep {one ? 'it' : 'them'}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(event) => {
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

/** What can change after a grant: why, and until when. Who, which role and where is a new binding. */
function EditDialog({ binding, catalogue, onClose, onSaved }: { binding: Binding | null; catalogue: Catalogue; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState('')
  const [expires, setExpires] = useState('')
  const [busy, setBusy] = useState(false)
  const [opened, setOpened] = useState<string | null>(null)
  if (binding && binding.id !== opened) {
    setOpened(binding.id)
    setReason(binding.reason ?? '')
    setExpires(isoToDay(binding.expiresAt))
  }
  const person = binding?.subjectType === 'user'

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!binding) return
    setBusy(true)
    try {
      await rbacApi.update(binding.id, { reason: reason.trim() || null, expiresAt: expiryToIso(expires) })
      toast.success(`Updated ${binding.subject}’s ${roleLabel(catalogue, binding.role)}`)
      onSaved()
      onClose()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save it. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={binding !== null} onOpenChange={(open) => !open && !busy && (onClose(), setOpened(null))}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={save} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Edit the binding</DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {binding && (
                  <>
                    <Subject binding={binding} /> <span>·</span> <span className="font-medium text-foreground">{roleLabel(catalogue, binding.role)}</span> <span>·</span> <ScopeBadge binding={binding} />
                  </>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="edit-reason">Reason{person ? '' : ' (optional)'}</Label>
            <Textarea id="edit-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-expires">Expires</Label>
            <ExpiryField id="edit-expires" value={expires} onChange={setExpires} />
          </div>
          <p className="text-xs text-muted-foreground">The change is recorded in the audit log with what it was before.</p>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || (person && !reason.trim())}>
              {busy && <Spinner />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
