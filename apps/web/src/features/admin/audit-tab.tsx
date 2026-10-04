import { useMemo, useState } from 'react'
import { Eye, Minus, Pencil, Plus, Search, type LucideIcon } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { AuditEntry, Catalogue } from './api.ts'
import { roleLabel, ScopeBadge, Subject } from './shared.tsx'

type Action = AuditEntry['action']

const ACTION: Record<Action, { label: string; icon: LucideIcon; tone: string }> = {
  grant: { label: 'Granted', icon: Plus, tone: 'bg-success-soft text-success' },
  revoke: { label: 'Removed', icon: Minus, tone: 'bg-muted text-muted-foreground' },
  update: { label: 'Changed', icon: Pencil, tone: 'bg-info-soft text-info' },
  assume: { label: 'Viewed as', icon: Eye, tone: 'bg-warning-soft text-warning' },
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
const expiry = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : 'never')

/**
 * Every grant, removal, change and view-as, newest first, a day at a time —
 * filtered by what happened, and searched by who did it, to whom, or which
 * role. A change shows what it was and what it became.
 */
export function AuditTab({ entries, catalogue }: { entries: AuditEntry[]; catalogue: Catalogue }) {
  const [action, setAction] = useState<Action | 'all'>('all')
  const [q, setQ] = useState('')

  const days = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const shown = entries.filter(
      (e) =>
        (action === 'all' || e.action === action) &&
        (!needle ||
          [e.actor, e.target, e.binding?.subject, e.binding?.scope, e.binding && roleLabel(catalogue, e.binding.role)].some((t) => t?.toLowerCase().includes(needle))),
    )
    const grouped = new Map<string, AuditEntry[]>()
    for (const e of shown) grouped.set(day(e.at), [...(grouped.get(day(e.at)) ?? []), e])
    return [...grouped.entries()]
  }, [entries, action, q, catalogue])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search the audit log" placeholder="Who did it, to whom, or which role" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
        <ToggleGroup type="single" variant="outline" size="sm" value={action} onValueChange={(v) => v && setAction(v as Action | 'all')} aria-label="What happened" className="flex-wrap">
          <ToggleGroupItem value="all" className="px-3">
            Everything
          </ToggleGroupItem>
          {(Object.keys(ACTION) as Action[]).map((a) => (
            <ToggleGroupItem key={a} value={a} className="px-3">
              {ACTION[a].label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {days.length === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {entries.length === 0 ? 'Nothing has been granted, removed, changed or viewed as yet.' : 'Nothing in the log matches.'}
        </p>
      ) : (
        days.map(([label, list]) => (
          <section key={label} className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <h3 className="border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">{label}</h3>
            <ol className="divide-y">
              {list.map((e) => (
                <Entry key={e.id} entry={e} catalogue={catalogue} />
              ))}
            </ol>
          </section>
        ))
      )}
      {entries.length >= 500 && <p className="text-xs text-muted-foreground">The newest 500 entries are shown.</p>}
    </div>
  )
}

function Entry({ entry: e, catalogue }: { entry: AuditEntry; catalogue: Catalogue }) {
  const { label, icon: Icon, tone } = ACTION[e.action]
  return (
    <li className="flex gap-3 px-4 py-3">
      <span className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ${tone}`} aria-label={label}>
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="font-medium">{e.actor}</span>
          {e.action === 'assume' ? (
            <>
              <span className="text-muted-foreground">viewed the portal as</span>
              <Subject binding={{ subjectType: 'user', subject: e.target }} />
            </>
          ) : (
            <>
              <span className="text-muted-foreground">{e.action === 'grant' ? 'granted' : e.action === 'revoke' ? 'removed' : 'changed'}</span>
              <span className="font-medium">{roleLabel(catalogue, e.binding.role)}</span>
              <span className="text-muted-foreground">{e.action === 'revoke' ? 'from' : e.action === 'grant' ? 'to' : 'for'}</span>
              <Subject binding={e.binding} />
              {e.binding.scope && <ScopeBadge binding={e.binding} />}
            </>
          )}
        </p>
        {e.action === 'update' && (
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {e.previous.reason !== e.binding.reason && (
              <li>
                Reason: <del>{e.previous.reason ?? 'none'}</del> → <span className="text-foreground">{e.binding.reason ?? 'none'}</span>
              </li>
            )}
            {e.previous.expiresAt !== e.binding.expiresAt && (
              <li>
                Expiry: <del>{expiry(e.previous.expiresAt)}</del> → <span className="text-foreground">{expiry(e.binding.expiresAt)}</span>
              </li>
            )}
          </ul>
        )}
        {e.action === 'grant' && e.binding.reason && <p className="mt-0.5 text-xs text-muted-foreground">“{e.binding.reason}”</p>}
      </div>
      <time dateTime={e.at} className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {time(e.at)}
      </time>
    </li>
  )
}
