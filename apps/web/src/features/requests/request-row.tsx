import { FolderGit2, FolderKanban } from 'lucide-react'
import { Link } from 'react-router'
import { targetPath, type PortalRequest } from './api.ts'
import { KIND_LABEL, since, StatusBadge, TargetPath } from './status.tsx'

/** One request in a list: what, who, how long ago, where it stands. */
export function RequestRow({ request: r, showRequester = false }: { request: PortalRequest; showRequester?: boolean }) {
  const Icon = r.kind === 'create_repository' ? FolderGit2 : FolderKanban
  return (
    <Link
      to={`/requests/${r.id}`}
      className="flex items-center gap-4 px-4 py-3 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-label={KIND_LABEL[r.kind]} />
      <div className="min-w-0 flex-1">
        <TargetPath parts={targetPath(r)} className="block truncate text-sm" />
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {showRequester ? `${r.requestedByName} · ` : ''}
          {since(r.requestedAt)}
        </p>
      </div>
      <StatusBadge status={r.status} />
    </Link>
  )
}
