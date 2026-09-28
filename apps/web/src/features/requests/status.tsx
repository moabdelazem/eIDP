import { Check, CircleDashed, FolderGit2, FolderKanban, KeyRound, Loader2, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import type { PortalRequest, RequestKind, RequestStatus } from './api.ts'

const LABEL: Record<RequestStatus, string> = {
  pending: 'Waiting for DevOps',
  approved: 'Creating',
  completed: 'Created',
  rejected: 'Rejected',
  failed: 'Failed',
  cancelled: 'Withdrawn',
}

export const KIND_LABEL: Record<RequestKind, string> = {
  create_repository: 'Repository',
  create_project: 'Project',
  grant_access: 'Access',
}

export const KIND_ICON: Record<RequestKind, LucideIcon> = {
  create_repository: FolderGit2,
  create_project: FolderKanban,
  grant_access: KeyRound,
}

/** Nothing is created by an access request, so its badge says what it does. */
const GRANT_LABEL: Partial<Record<RequestStatus, string>> = { approved: 'Granting', completed: 'Granted' }

/**
 * Red only where someone has to act: a rejection to read, a failure to retry.
 * Everything else stays quiet.
 */
export function StatusBadge({ status, kind }: { status: RequestStatus; kind?: RequestKind }) {
  const attention = status === 'rejected' || status === 'failed'
  const Icon =
    status === 'approved'
      ? Loader2
      : status === 'completed'
        ? Check
        : status === 'pending'
          ? CircleDashed
          : attention
            ? TriangleAlert
            : X

  return (
    <span
      className={[
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        attention
          ? 'border-destructive/30 bg-destructive/5 text-destructive'
          : status === 'completed'
            ? 'border-accent/20 bg-accent/5 text-accent'
            : 'text-muted-foreground',
      ].join(' ')}
    >
      <Icon className={`size-3.5 ${status === 'approved' ? 'animate-spin motion-reduce:animate-none' : ''}`} />
      {(kind === 'grant_access' && GRANT_LABEL[status]) || LABEL[status]}
    </span>
  )
}

/** "3 minutes ago" — people care how long they have been waiting. */
export function since(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (seconds < 60) return format.format(-seconds, 'second')
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), 'minute')
  if (seconds < 86400) return format.format(-Math.round(seconds / 3600), 'hour')
  return format.format(-Math.round(seconds / 86400), 'day')
}

/**
 * An identifier path, in the monospace we reserve for things people copy.
 * Wraps between segments, never inside one — `break-all` used to split
 * `Payments_Platform` into `Payments_Pl` / `atform` on a phone.
 */
export function TargetPath({ parts, className = '' }: { parts: string[]; className?: string }) {
  return (
    <code className={`break-words ${className}`}>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && (
            <span className="text-muted-foreground">
              {' '}/<wbr />{' '}
            </span>
          )}
          <span className={index === parts.length - 1 ? 'font-medium text-foreground' : 'text-muted-foreground'}>
            {part}
          </span>
        </span>
      ))}
    </code>
  )
}

/**
 * What a request is for, name first. The collection is nearly always the
 * same, so leading with it pushed the name — the part people scan for — off
 * the end of the line on a phone.
 */
export function RequestName({
  request,
  as: Tag = 'p',
  className = '',
}: {
  request: { kind: RequestKind; collection: string; project: string; repository: string | null }
  as?: 'p' | 'h1'
  className?: string
}) {
  const name = request.repository ?? request.project
  const where = request.repository ? `${request.collection} / ${request.project}` : request.collection
  const label =
    request.kind === 'grant_access' ? `Access to the ${request.repository ? 'repository' : 'project'}` : KIND_LABEL[request.kind]
  return (
    <div className={`min-w-0 ${className}`}>
      <Tag className={`font-mono font-medium break-words ${Tag === 'h1' ? 'text-lg' : ''}`}>{name}</Tag>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">
        {label} in <span className="font-mono">{where}</span>
      </p>
    </div>
  )
}

/**
 * What approving hands out, in one line: the requester and their team for a
 * creation, the named people and the level for an access request.
 */
export function AccessLine({
  request: r,
  own = false,
  className = '',
}: {
  request: PortalRequest
  own?: boolean
  className?: string
}) {
  const names =
    r.kind === 'grant_access'
      ? (r.grantees ?? []).map((name) => ({ name, mono: true }))
      : [{ name: own ? 'you' : r.requestedByName, mono: false }, ...(r.teamGroup ? [{ name: r.teamGroup, mono: true }] : [])]
  const level = r.kind === 'grant_access' && r.accessLevel === 'read' ? 'Read' : 'Contributor'
  return (
    <p className={`text-sm ${className}`}>
      <span className="text-muted-foreground">{level} access for </span>
      {names.map(({ name, mono }, index) => (
        <span key={name}>
          {index > 0 && (index === names.length - 1 ? ' and ' : ', ')}
          {mono ? <code className="text-[13px]">{name}</code> : name}
        </span>
      ))}
    </p>
  )
}

/**
 * A URL that may wrap, but only after a slash. `break-all` would split a
 * repository name in half, which is exactly the part people read.
 */
export function WrappingUrl({ url }: { url: string }) {
  const parts = url.split('/')
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {part}
          {index < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </span>
      ))}
    </>
  )
}
