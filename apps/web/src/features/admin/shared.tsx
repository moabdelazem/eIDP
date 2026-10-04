import { CircleAlert, Clock, Globe, Ban, CircleCheck, FolderKanban, User, Users, type LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import type { Binding, Catalogue } from './api.ts'

/** A binding's expiry this close is worth a look before it lapses. */
export const EXPIRING_DAYS = 14

export type Status = 'active' | 'expiring' | 'expired' | 'orphaned'

const DAY = 86_400_000

/**
 * Where a binding stands: granting, about to stop, stopped (an expired binding
 * grants nothing but stays listed until someone removes it), or naming a role
 * the code no longer has.
 */
export function statusOf(binding: Binding, catalogue: Catalogue, now = Date.now()): Status {
  if (!catalogue.roles.some((r) => r.id === binding.role)) return 'orphaned'
  if (binding.expiresAt) {
    const left = Date.parse(binding.expiresAt) - now
    if (left <= 0) return 'expired'
    if (left <= EXPIRING_DAYS * DAY) return 'expiring'
  }
  return 'active'
}

export const STATUS: Record<Status, { label: string; icon: LucideIcon; tone: string }> = {
  active: { label: 'Active', icon: CircleCheck, tone: 'text-success' },
  expiring: { label: 'Expiring', icon: Clock, tone: 'text-warning' },
  expired: { label: 'Expired', icon: Ban, tone: 'text-muted-foreground' },
  orphaned: { label: 'Role gone', icon: CircleAlert, tone: 'text-destructive' },
}

/** "in 3 days", "today", "2 days ago" — for an expiry. */
export function relativeDay(iso: string, now = Date.now()): string {
  const days = Math.round((Date.parse(iso) - now) / DAY)
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(days, 'day')
}

export function StatusBadge({ binding, catalogue }: { binding: Binding; catalogue: Catalogue }) {
  const status = statusOf(binding, catalogue)
  const { label, icon: Icon, tone } = STATUS[status]
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap ${tone}`}>
      <Icon className="size-3.5" aria-hidden />
      {label}
      {binding.expiresAt && status !== 'orphaned' && (
        <span className="font-normal text-muted-foreground">· {status === 'expired' ? 'ended' : 'ends'} {relativeDay(binding.expiresAt)}</span>
      )}
    </span>
  )
}

export function roleLabel(catalogue: Catalogue | undefined, role: string): string {
  return catalogue?.roles.find((r) => r.id === role)?.label ?? role
}

/** A group or a person, by its mark and its name in the directory's own spelling. */
export function Subject({ binding, size = 'sm' }: { binding: Pick<Binding, 'subjectType' | 'subject'>; size?: 'sm' | 'md' }) {
  const person = binding.subjectType === 'user'
  const Icon = person ? User : Users
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span
        className={`flex shrink-0 items-center justify-center rounded-md ${person ? 'bg-info-soft text-info' : 'bg-secondary text-secondary-foreground'} ${size === 'md' ? 'size-8' : 'size-6'}`}
        aria-label={person ? 'Person' : 'Group'}
      >
        <Icon className={size === 'md' ? 'size-4' : 'size-3.5'} />
      </span>
      <code className="truncate text-sm">{binding.subject}</code>
    </span>
  )
}

export function ScopeBadge({ binding }: { binding: Pick<Binding, 'scopeType' | 'scope'> }) {
  if (!binding.scope) {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
        <Globe className="size-3.5" aria-hidden /> Everywhere
      </span>
    )
  }
  const Icon = binding.scopeType === 'team' ? Users : FolderKanban
  return (
    <Badge variant="outline" className="max-w-full gap-1 font-normal">
      <Icon className="size-3" aria-hidden />
      <span className="sr-only">{binding.scopeType}</span>
      <code className="truncate">{binding.scope}</code>
    </Badge>
  )
}

/** A role by name; hovering it lists what it allows, so nobody has to switch tabs to find out. */
export function RoleBadge({ role, catalogue }: { role: string; catalogue: Catalogue }) {
  const info = catalogue.roles.find((r) => r.id === role)
  if (!info) return <span className="text-sm text-destructive">{role} (no longer exists)</span>
  const describe = (id: string) => catalogue.permissions.find((p) => p.id === id)?.description ?? id
  return (
    <HoverCard openDelay={250}>
      <HoverCardTrigger asChild>
        <button type="button" className="rounded text-sm font-medium underline decoration-dotted underline-offset-4 hover:decoration-solid">
          {info.label}
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80">
        <p className="text-sm font-medium">{info.label}</p>
        <p className="mt-1 text-xs text-muted-foreground">{info.description}</p>
        <ul className="mt-3 space-y-1.5 text-xs">
          {info.permissions.map((p) => (
            <li key={p} className="flex gap-1.5">
              <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
              <span>{describe(p)}</span>
            </li>
          ))}
        </ul>
      </HoverCardContent>
    </HoverCard>
  )
}
