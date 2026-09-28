import { useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Skeleton } from '@/components/ui/skeleton'
import { useSession } from '@/features/auth/session-context.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { withViewTransition } from '@/lib/view-transition.ts'
import { useResource } from '@/lib/use-resource.ts'
import { requestsApi, targetPath, type PortalRequest } from './api.ts'
import { decide, rejectRequest } from './decisions.ts'
import { RejectDialog } from './reject-dialog.tsx'
import { RequestRow } from './request-row.tsx'
import { AccessLine, KIND_ICON, RequestName, since } from './status.tsx'
import { CardSkeleton, HeaderSkeleton, Loading } from '@/components/skeletons.tsx'

/** Mounted only behind `RequireDevOps` — see app/routes.tsx. */
export function ApprovalsPage() {
  const { session } = useSession()
  const pool = useResource(() => requestsApi.pool(), [], { pollMs: 10_000 })
  // Decided here and now, ahead of the reload that confirms it — so the card
  // can leave the list at once, as its own animated change.
  const [decided, setDecided] = useState<Set<string>>(() => new Set())
  const pending = pool.data?.open.filter((r) => r.status === 'pending' && !decided.has(r.id)).length ?? 0
  // The count in the tab lets DevOps leave it open and see when work arrives.
  usePageTitle(pending > 0 ? `(${pending}) Approvals` : 'Approvals')

  if (!session) return null

  if (pool.error && !pool.data) return <p className="text-sm text-destructive">{pool.error}</p>
  if (!pool.data) {
    return (
      <Loading label="Loading approvals…" className="max-w-3xl">
        <HeaderSkeleton />
        <Skeleton className="mt-8 h-4 w-40" />
        <div className="mt-2 space-y-3">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </Loading>
    )
  }

  const waiting = pool.data.open.filter((r) => r.status === 'pending' && !decided.has(r.id))

  /**
   * The decided card leaves inside a View Transition: it fades and the cards
   * below slide up to close the gap, so the list visibly shrinks by one
   * instead of blinking into a new shape. Then the pool reloads for real.
   */
  function onDecided(id: string) {
    withViewTransition(() => setDecided((current) => new Set(current).add(id)))
    pool.reload()
  }
  const attention = pool.data.open.filter((r) => r.status !== 'pending')

  return (
    <div className="max-w-3xl">
      <h1 className="text-lg font-semibold tracking-tight">Approvals</h1>
      <p className="mt-1 text-muted-foreground">
        Requests wait here for anyone in DevOps. Approving creates it in Azure DevOps straight away.
      </p>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-muted-foreground">
          Waiting for a decision{waiting.length > 0 && ` (${waiting.length})`}
        </h2>
        {waiting.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Nothing waiting. New requests show up here as they arrive.
          </p>
        ) : (
          <ul className="mt-2 space-y-3">
            {waiting.map((request) => (
              // A name per card is what lets the browser track each one across
              // the change and slide it, rather than cross-fading the whole list.
              <li key={request.id} style={{ viewTransitionName: `request-${request.id}` }}>
                <PendingCard
                  request={request}
                  own={request.requestedBy === session.uid}
                  onDecided={() => onDecided(request.id)}
                />
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
function PendingCard({ request: r, own, onDecided }: { request: PortalRequest; own: boolean; onDecided: () => void }) {
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const Icon = KIND_ICON[r.kind]

  return (
    <article className="rounded-lg border bg-card p-5">
      <div className="flex items-start gap-3">
        <Icon className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <Link to={`/requests/${r.id}`} className="min-w-0 flex-1 hover:[&_p:first-child]:underline">
          <RequestName request={r} className="text-[15px]" />
        </Link>
        <p className="shrink-0 text-right text-xs text-muted-foreground">
          {r.requestedByName}
          <br />
          {since(r.requestedAt)}
        </p>
      </div>

      <blockquote className="mt-3 border-l-2 pl-3 text-sm text-muted-foreground">{r.justification}</blockquote>
      {/* What approving hands out, so it is decided with open eyes. */}
      <AccessLine request={r} className="mt-3" />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {own ? (
          <p className="text-sm text-muted-foreground">Your own request — someone else in DevOps decides it.</p>
        ) : (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                if (await decide('approve', r)) onDecided()
                setBusy(false)
              }}
            >
              {busy && <Spinner />}
              {r.kind === 'grant_access' ? 'Approve and grant' : 'Approve and create'}
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
          onDecided()
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
