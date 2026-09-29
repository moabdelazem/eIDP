import { Link } from 'react-router'
import type { PortalRequest } from './api.ts'
import { KIND_ICON, KIND_LABEL, RequestName, since, StatusBadge } from './status.tsx'

/**
 * One request in a list. The name leads. On a wide screen, where it stands and
 * how long ago sit together on the right so the eye can run down either
 * column; on a phone they drop beneath the name, because beside it they
 * squeezed `Payments_Platform` into two broken halves.
 */
export function RequestRow({ request: r, showRequester = false }: { request: PortalRequest; showRequester?: boolean }) {
  const Icon = KIND_ICON[r.kind]
  return (
    <Link
      to={`/requests/${r.id}`}
      // Laid out by the width it is given, not the screen's: the same row sits
      // in a full-width list and in a narrow side column.
      className="@container flex items-start gap-3 px-4 py-3 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label={KIND_LABEL[r.kind]} />
      <div className="min-w-0 flex-1 @md:flex @md:items-start @md:gap-4">
        <RequestName request={r} className="text-sm @md:flex-1" />
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 @md:mt-0 @md:shrink-0 @md:flex-col @md:items-end @md:gap-1">
          <StatusBadge status={r.status} kind={r.kind} />
          <span className="text-xs text-muted-foreground">
            {showRequester && `${r.requestedByName}, `}
            {since(r.requestedAt)}
          </span>
        </div>
      </div>
    </Link>
  )
}
