import { Check, CircleDashed, ClipboardList, FolderGit2, FolderKanban, KeyRound, Loader2, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { isJira, whereOf, type PortalRequest, type RequestKind, type RequestStatus } from './api.ts'

/** What each status is called in a badge. Access requests say Granting/Granted instead. */
const STATUS_LABEL: Record<RequestStatus, string> = {
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
  create_jira_project: 'Jira project',
}

export const KIND_ICON: Record<RequestKind, LucideIcon> = {
  create_repository: FolderGit2,
  create_project: FolderKanban,
  grant_access: KeyRound,
  create_jira_project: ClipboardList,
}

/** Nothing is created by an access request, so its badge says what it does. */
const GRANT_LABEL: Partial<Record<RequestStatus, string>> = { approved: 'Granting', completed: 'Granted' }

/**
 * What each status looks like: a badge fill and a dot. Red only where someone
 * has to act — a rejection to read, a failure to retry. The rest say what they
 * mean without asking anything: amber waits, indigo is moving, green is done,
 * and a withdrawn request goes quiet.
 */
export const STATUS_TONE: Record<RequestStatus, { badge: string; dot: string }> = {
  pending: { badge: 'border-warning/25 bg-warning-soft text-warning', dot: 'bg-warning' },
  approved: { badge: 'border-info/25 bg-info-soft text-info', dot: 'bg-info' },
  completed: { badge: 'border-success/25 bg-success-soft text-success', dot: 'bg-success' },
  rejected: { badge: 'border-destructive/30 bg-destructive/5 text-destructive', dot: 'bg-destructive' },
  failed: { badge: 'border-destructive/30 bg-destructive/5 text-destructive', dot: 'bg-destructive' },
  cancelled: { badge: 'text-muted-foreground', dot: 'bg-muted-foreground/50' },
}

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
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_TONE[status].badge}`}
    >
      <Icon className={`size-3.5 ${status === 'approved' ? 'animate-spin motion-reduce:animate-none' : ''}`} />
      {(kind === 'grant_access' && GRANT_LABEL[status]) || STATUS_LABEL[status]}
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
  request: Pick<PortalRequest, 'kind' | 'collection' | 'project' | 'projectKey' | 'repository'>
  as?: 'p' | 'h1'
  className?: string
}) {
  const name = request.repository ?? request.project
  const where = whereOf(request)
  const label =
    request.kind === 'grant_access' ? `Access to the ${request.repository ? 'repository' : 'project'}` : KIND_LABEL[request.kind]
  return (
    <div className={`min-w-0 ${className}`}>
      <Tag className={`font-mono font-medium break-words ${Tag === 'h1' ? 'text-lg' : ''}`}>{name}</Tag>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">
        {/* A Jira project lives nowhere narrower than Jira; its key is what people know it by. */}
        {isJira(request) ? label : `${label} in`} <span className="font-mono">{where}</span>
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
      {/* Jira has roles, not access levels; which role is the server's setting. */}
      <span className="text-muted-foreground">{isJira(r) ? 'Project members: ' : `${level} access for `}</span>
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
