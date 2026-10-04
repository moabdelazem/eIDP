import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Check, CircleCheck, FolderKanban, Globe, TriangleAlert, User, Users, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import type { ScopeType } from '@/features/auth/profile-context.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { rbacApi, type Binding, type Catalogue, type Explanation, type SubjectType, type Suggestions } from './api.ts'
import { ExpiryField, expiryToIso } from './expiry-field.tsx'
import { roleLabel } from './shared.tsx'

/** What "Grant the same to…" carries over: the role and where, never who or why. */
export type GrantStart = Partial<Pick<Binding, 'role' | 'scopeType' | 'scope'>>

/**
 * Granting a role, in a panel beside the page rather than a cramped dialog:
 * to whom (a group, or one person as an exception — checked against the
 * directory as it is typed), which role (each with what it allows), where
 * (everywhere, a team's projects or one project — offered from what the
 * catalog knows), why and until when. A sentence at the foot says what will
 * happen before anyone presses Grant.
 */
export function GrantSheet({
  start,
  onClose,
  catalogue,
  suggestions,
  onGranted,
}: {
  /** null keeps it shut; an object opens it, filled with what it carries. */
  start: GrantStart | null
  onClose: () => void
  catalogue: Catalogue
  suggestions: Suggestions | undefined
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
  const [opened, setOpened] = useState<GrantStart | null>(null)

  // Each opening starts clean, with what "Grant the same to…" brought.
  if (start !== opened) {
    setOpened(start)
    if (start) {
      setSubjectType('group')
      setSubject('')
      setRole(start.role && start.role !== 'member' ? start.role : '')
      setScopeType(start.scopeType ?? 'global')
      setScope(start.scope ?? '')
      setReason('')
      setExpires('')
    }
  }

  const person = subjectType === 'user'
  const found = usePerson(person ? subject : '')
  const chosen = roles.find((r) => r.id === role)
  const ready =
    subject.trim() && role && (scopeType === 'global' || scope.trim()) && (!person || (reason.trim() && found.state !== 'missing'))

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
        expiresAt: expiryToIso(expires),
      })
      toast.success(`${roleLabel(catalogue, role)} granted to ${subject.trim()}`)
      onGranted()
      onClose()
    } catch (err) {
      // Kept open with what was typed, so a typo is one fix away.
      toast.error(err instanceof ApiError ? err.message : 'Could not grant it. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={start !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>Grant a role</SheetTitle>
          <SheetDescription>Applies the moment you grant it, and is recorded in the audit log.</SheetDescription>
        </SheetHeader>

        <form id="grant-form" onSubmit={submit} className="flex-1 space-y-7 overflow-y-auto px-6 py-5">
          <Step n={1} title="Who">
            <div role="radiogroup" aria-label="Grant to" className="grid grid-cols-2 gap-2">
              <Choice icon={Users} title="A directory group" hint="The normal case" selected={!person} onSelect={() => setSubjectType('group')} />
              <Choice icon={User} title="One person" hint="An exception, with a reason" selected={person} onSelect={() => setSubjectType('user')} />
            </div>
            <SuggestInput
              id="grant-subject"
              label={person ? 'Login name' : 'Group name'}
              placeholder={person ? 'Login name, like jsmith' : 'Directory group, like DEVJAVA'}
              value={subject}
              onChange={setSubject}
              options={person ? [] : (suggestions?.groups ?? [])}
              heading="Groups the portal knows"
            />
            {person && subject.trim() && <PersonCheck found={found} />}
          </Step>

          <Step n={2} title="Which role">
            <div role="radiogroup" aria-label="Role" className="space-y-2">
              {roles.map((r) => (
                <Choice
                  key={r.id}
                  title={r.label}
                  hint={r.description}
                  selected={role === r.id}
                  onSelect={() => setRole(r.id)}
                  aside={<span className="text-xs text-muted-foreground tabular-nums">{r.permissions.length} permissions</span>}
                />
              ))}
            </div>
            {chosen && (
              <ul className="reveal space-y-1 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs" aria-label={`What ${chosen.label} allows`}>
                {chosen.permissions.map((p) => (
                  <li key={p} className="flex gap-1.5">
                    <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
                    {catalogue.permissions.find((x) => x.id === p)?.description ?? p}
                  </li>
                ))}
              </ul>
            )}
          </Step>

          <Step n={3} title="Where">
            <div role="radiogroup" aria-label="Applies to" className="grid gap-2 sm:grid-cols-3">
              <Choice icon={Globe} title="Everywhere" selected={scopeType === 'global'} onSelect={() => setScopeType('global')} compact />
              <Choice icon={Users} title="A team’s projects" selected={scopeType === 'team'} onSelect={() => setScopeType('team')} compact />
              <Choice icon={FolderKanban} title="One project" selected={scopeType === 'project'} onSelect={() => setScopeType('project')} compact />
            </div>
            {scopeType !== 'global' && (
              <>
                <SuggestInput
                  id="grant-scope"
                  label={scopeType === 'team' ? 'Team' : 'Azure DevOps project'}
                  placeholder={scopeType === 'team' ? 'Team, as inventories names it' : 'Project name'}
                  value={scope}
                  onChange={setScope}
                  options={scopeType === 'team' ? (suggestions?.teams ?? []) : (suggestions?.projects ?? [])}
                  heading={scopeType === 'team' ? 'Teams in the catalog' : 'Projects in the catalog'}
                />
                <p className="text-xs text-muted-foreground">
                  {scopeType === 'team' ? (
                    <>
                      Matches the owning teams in each system’s <code>team.yml</code> — every project the team owns, in any environment.
                    </>
                  ) : (
                    'Matches the Azure DevOps project by name.'
                  )}
                </p>
              </>
            )}
          </Step>

          <Step n={4} title="Why and until when">
            <div className="space-y-2">
              <Label htmlFor="grant-reason">Reason{person ? '' : ' (optional)'}</Label>
              <Textarea
                id="grant-reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={person ? 'Why this person, rather than their group' : 'What this is for'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="grant-expires">Expires</Label>
              <ExpiryField id="grant-expires" value={expires} onChange={setExpires} />
            </div>
          </Step>
        </form>

        <SheetFooter className="border-t bg-muted/30 px-6 py-4">
          <p className="text-sm" aria-live="polite">
            {subject.trim() && chosen ? (
              <>
                {person ? <code>{subject.trim()}</code> : <>Everyone in <code>{subject.trim()}</code></>} will hold <strong>{chosen.label}</strong>{' '}
                {scopeType === 'global' ? 'everywhere' : scope.trim() ? <>for {scopeType === 'team' ? 'the projects' : 'the project'} <code>{scope.trim()}</code>{scopeType === 'team' ? ' owns' : ''}</> : '…'}
                {expires ? `, until ${new Date(`${expires}T12:00:00`).toLocaleDateString()}` : ''}.
              </>
            ) : (
              <span className="text-muted-foreground">Choose who and which role to see what will be granted.</span>
            )}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="grant-form" disabled={!ready || busy}>
              {busy && <Spinner />}
              Grant
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <span className="flex size-5 items-center justify-center rounded-full bg-secondary text-xs text-secondary-foreground tabular-nums" aria-hidden>
          {n}
        </span>
        {title}
      </h3>
      {children}
    </section>
  )
}

/** A card that is one option of a radiogroup: the whole card is the target, and a check marks the chosen one. */
function Choice({
  icon: Icon,
  title,
  hint,
  aside,
  selected,
  onSelect,
  compact = false,
}: {
  icon?: LucideIcon
  title: string
  hint?: string
  aside?: ReactNode
  selected: boolean
  onSelect: () => void
  compact?: boolean
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex w-full items-start gap-2.5 rounded-lg border bg-card text-left transition-colors hover:bg-secondary/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none ${
        compact ? 'px-3 py-2' : 'px-3 py-2.5'
      } ${selected ? 'border-ring bg-secondary/60 ring-1 ring-ring/40' : ''}`}
    >
      {Icon && <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        {hint && <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>}
      </span>
      {aside}
      <Check className={`mt-0.5 size-4 shrink-0 text-[var(--chart-1)] transition-opacity ${selected ? 'opacity-100' : 'opacity-0'}`} aria-hidden />
    </button>
  )
}

/**
 * A text field that offers names as it is typed — any name may still be typed
 * in full: a group the portal has not heard of is still a group.
 */
function SuggestInput({
  id,
  label,
  placeholder,
  value,
  onChange,
  options,
  heading,
}: {
  id: string
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  options: string[]
  heading: string
}) {
  const [open, setOpen] = useState(false)
  const needle = value.trim().toLowerCase()
  const shown = options.filter((o) => o.toLowerCase().includes(needle) && o.toLowerCase() !== needle).slice(0, 8)
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="sr-only">
        {label}
      </Label>
      <Popover open={open && shown.length > 0} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <Input
            id={id}
            placeholder={placeholder}
            value={value}
            onChange={(e) => {
              onChange(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            aria-label={label}
          />
        </PopoverAnchor>
        <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
          <Command shouldFilter={false}>
            <CommandList>
              <CommandEmpty>No match</CommandEmpty>
              <CommandGroup heading={heading}>
                {shown.map((o) => (
                  <CommandItem
                    key={o}
                    value={o}
                    onSelect={() => {
                      onChange(o)
                      setOpen(false)
                    }}
                    className="font-mono"
                  >
                    {o}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

type Found = { state: 'idle' | 'checking' } | { state: 'found'; who: Explanation } | { state: 'missing'; message: string }

/** Whether the directory knows a login name, asked a moment after typing stops. */
function usePerson(uid: string): Found {
  const [found, setFound] = useState<Found>({ state: 'idle' })
  useEffect(() => {
    const name = uid.trim()
    if (!name) {
      setFound({ state: 'idle' })
      return
    }
    setFound({ state: 'checking' })
    let stale = false
    const timer = setTimeout(() => {
      rbacApi
        .explain(name)
        .then((who) => !stale && setFound({ state: 'found', who }))
        .catch((err: unknown) => !stale && setFound({ state: 'missing', message: err instanceof ApiError ? err.message : 'Could not check that name.' }))
    }, 400)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [uid])
  return found
}

function PersonCheck({ found }: { found: Found }) {
  if (found.state === 'checking') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner className="size-3.5" /> Looking them up in the directory…
      </p>
    )
  }
  if (found.state === 'missing') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-destructive">
        <TriangleAlert className="size-3.5" aria-hidden /> {found.message}
      </p>
    )
  }
  if (found.state !== 'found') return null
  const held = found.who.permissions.filter((p) => p.grants.length > 0).length
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <CircleCheck className="size-3.5 text-success" aria-hidden />
      In the directory — {found.who.groups.length ? `in ${found.who.groups.join(', ')}` : 'in no group'}, holds {held} permissions today.
    </p>
  )
}
