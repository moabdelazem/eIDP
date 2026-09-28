import { useState } from 'react'
import { FolderGit2, FolderKanban, Loader2 } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useSession } from '@/features/auth/session-context.tsx'
import { useResource } from '@/lib/use-resource.ts'
import { requestsApi, targetPath, type PortalRequest } from './api.ts'
import { decide, rejectRequest } from './decisions.ts'
import { RejectDialog } from './reject-dialog.tsx'
import { RequestRow } from './request-row.tsx'
import { KIND_LABEL, since, TargetPath } from './status.tsx'

/** Mounted only behind `RequireDevOps` — see app/routes.tsx. */
export function ApprovalsPage() {
  const { session } = useSession()
  const pool = useResource(() => requestsApi.pool(), [], { pollMs: 10_000 })

  if (!session) return null

  if (pool.error && !pool.data) return <p className="text-sm text-destructive">{pool.error}</p>
  if (!pool.data) return <Skeleton className="h-64 w-full max-w-3xl" />

  const waiting = pool.data.open.filter((r) => r.status === 'pending')
  const attention = pool.data.open.filter((r) => r.status !== 'pending')

  return (
    <div className="max-w-3xl">
      <h1 className="text-lg font-semibold tracking-tight">Approvals</h1>
      <p className="mt-1 text-muted-foreground">
        Requests wait here for anyone in DEVOPS. Approving creates it in Azure DevOps straight away.
      </p>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-muted-foreground">
          Waiting on DEVOPS{waiting.length > 0 && ` · ${waiting.length}`}
        </h2>
        {waiting.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Nothing waiting. New requests show up here as they arrive.
          </p>
        ) : (
          <ul className="mt-2 space-y-3">
            {waiting.map((request) => (
              <li key={request.id}>
                <PendingCard request={request} own={request.requestedBy === session.uid} onChanged={pool.reload} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {attention.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium text-muted-foreground">Creating, or needs a retry</h2>
          <ul className="mt-2 divide-y rounded-lg border bg-card">
            {attention.map((request) => (
              <li key={request.id} className="flex items-center">
                <div className="min-w-0 flex-1">
                  <RequestRow request={request} showRequester />
                </div>
                {request.status === 'failed' && (
                  <RetryButton request={request} onChanged={pool.reload} />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {pool.data.recent.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium text-muted-foreground">Recently decided</h2>
          <ul className="mt-2 divide-y rounded-lg border bg-card">
            {pool.data.recent.map((request) => (
              <li key={request.id}>
                <RequestRow request={request} showRequester />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** Everything needed to decide, on the card itself — no click-through required. */
function PendingCard({ request: r, own, onChanged }: { request: PortalRequest; own: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const Icon = r.kind === 'create_repository' ? FolderGit2 : FolderKanban

  return (
    <article className="rounded-lg border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon className="size-3.5" /> {KIND_LABEL[r.kind]} · {r.requestedByName} · {since(r.requestedAt)}
          </p>
          <Link to={`/requests/${r.id}`} className="mt-1 block hover:underline">
            <TargetPath parts={targetPath(r)} className="text-[15px]" />
          </Link>
        </div>
      </div>

      <blockquote className="mt-3 border-l-2 pl-3 text-sm text-muted-foreground">{r.justification}</blockquote>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {own ? (
          <p className="text-sm text-muted-foreground">Your own request — someone else in DEVOPS decides it.</p>
        ) : (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                if (await decide('approve', r)) onChanged()
                setBusy(false)
              }}
            >
              {busy && <Loader2 className="animate-spin motion-reduce:animate-none" />}
              Approve and create
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
              Reject
            </Button>
          </>
        )}
      </div>

      <RejectDialog
        open={rejecting}
        onOpenChange={setRejecting}
        what={targetPath(r).join(' / ')}
        onReject={async (note) => {
          await rejectRequest(r, note)
          onChanged()
        }}
      />
    </article>
  )
}

function RetryButton({ request, onChanged }: { request: PortalRequest; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="sm"
      variant="outline"
      className="mr-4"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        if (await decide('retry', request)) onChanged()
        setBusy(false)
      }}
    >
      Retry
    </Button>
  )
}
