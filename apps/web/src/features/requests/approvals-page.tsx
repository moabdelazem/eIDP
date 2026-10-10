import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useSession } from '@/features/auth/session-context.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { withViewTransition } from '@/lib/view-transition.ts'
import { PAGE, PageHeader, Section, Split } from '@/components/page-layout.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useResource } from '@/lib/use-resource.ts'
import { requestsApi, targetPath, type PortalRequest, type RequestStatus } from './api.ts'
import { RequestStats } from './request-stats.tsx'
import { RequestsTable } from './requests-table.tsx'
import { decide, rejectRequest } from './decisions.ts'
import { RejectDialog } from './reject-dialog.tsx'
import { ApproveDialog } from './decision-dialogs.tsx'
import { RequestRow } from './request-row.tsx'
import { AccessLine, KIND_ICON, RequestName, since } from './status.tsx'
import { RiskLine } from './risk.tsx'
import { CardSkeleton, HeaderSkeleton, Loading, RowsSkeleton } from '@/components/skeletons.tsx'

/** A side column holds the latest few; the rest are one click away on each request. */
const RECENT_SHOWN = 8

/**
 * Mounted behind `requests.decide_access` held anywhere — see app/routes.tsx.
 * DevOps see every request; a team lead sees only what they may decide,
 * because the API sends nothing else.
 */
export function ApprovalsPage() {
  const { session } = useSession()
  const pool = useResource(['requests', 'pool'], () => requestsApi.pool(), { pollMs: 10_000 })
  // Everything decidable, for the tiles and the History tab. Slower to change
  // than the queue, so polled less often.
  const history = useResource(['requests', 'history'], () => requestsApi.history(), { pollMs: 30_000 })
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'history' ? 'history' : 'queue'
  const [status, setStatus] = useState<RequestStatus | 'all'>('all')
  const showTab = (next: string) =>
    setParams(
      (current) => {
        const copy = new URLSearchParams(current)
        if (next === 'queue') copy.delete('tab')
        else copy.set('tab', next)
        return copy
      },
      { replace: true },
    )
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
      <Loading label="Loading approvals…" className={PAGE}>
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
    history.reload()
  }
  const attention = pool.data.open.filter((r) => r.status !== 'pending')

  const recent = pool.data.recent.slice(0, RECENT_SHOWN)

  return (
    <div className={PAGE}>
      <PageHeader
        title="Approvals"
        description="Requests you can decide. Approving acts in Azure DevOps or Jira straight away."
      />

      <div className="mt-6">
        {history.data ? (
          <RequestStats
            requests={history.data}
            active={status}
            // Waiting is red here: on this page it is work for the reader.
            attention={['pending', 'failed']}
            onPick={(next) => {
              setStatus(next)
              showTab('history')
            }}
          />
        ) : history.error ? (
          // Said, not left as a placeholder that never fills: the queue below
          // still works without the counts.
          <p className="text-sm text-muted-foreground">Counts are unavailable right now: {history.error}</p>
        ) : (
          <Skeleton className="h-[74px] w-full rounded-xl" />
        )}
      </div>

      <Tabs value={tab} onValueChange={showTab} className="mt-6">
        <TabsList>
          <TabsTrigger value="queue">
            Queue{waiting.length > 0 && <span className="tabular-nums text-muted-foreground">{waiting.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="history" className="mt-4">
          {history.error && !history.data ? (
            <p className="text-sm text-destructive">{history.error}</p>
          ) : !history.data ? (
            <Loading label="Loading history…">
              <RowsSkeleton rows={6} />
            </Loading>
          ) : (
            <RequestsTable requests={history.data} status={status} onStatus={setStatus} showRequester />
          )}
        </TabsContent>

        <TabsContent value="queue" className="mt-4">
          <Split
            className=""
            aside={
              <>
                {attention.length > 0 && (
                  <Section title="Creating, or needs a retry" flush>
                    <ul className="divide-y">
                      {attention.map((request) => (
                        <li key={request.id} className="flex items-center">
                          <div className="min-w-0 flex-1">
                            <RequestRow request={request} showRequester />
                          </div>
                          {request.status === 'failed' && <RetryButton request={request} onChanged={pool.reload} />}
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}

                {recent.length > 0 && (
                  <Section title="Recently decided" flush>
                    <ul className="divide-y">
                      {recent.map((request) => (
                        <li key={request.id}>
                          <RequestRow request={request} showRequester />
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}
              </>
            }
          >
            <section>
              <h2 className="text-sm font-medium text-muted-foreground">
                Waiting for a decision{waiting.length > 0 && ` (${waiting.length})`}
              </h2>
              {waiting.length === 0 ? (
                <p className="mt-2 rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
                  Nothing waiting. New requests show up here as they arrive.
                </p>
              ) : (
                // Two across once there is room: a card is short, and a long queue
                // should not become one long scroll.
                <ul className="mt-2 grid gap-3 2xl:grid-cols-2">
                  {waiting.map((request) => (
                    // A name per card is what lets the browser track each one across
                    // the change and slide it, rather than cross-fading the whole list.
                    <li key={request.id} style={{ viewTransitionName: `request-${request.id}` }}>
                      <PendingCard request={request} onDecided={() => onDecided(request.id)} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </Split>
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** Everything needed to decide, on the card itself — no click-through required. */
function PendingCard({ request: r, onDecided }: { request: PortalRequest; onDecided: () => void }) {
  const [approving, setApproving] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const Icon = KIND_ICON[r.kind]

  return (
    <article className="h-full rounded-xl border bg-card p-5 shadow-sm">
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
      {/* What to weigh: checked facts, and the model's line on them. */}
      <RiskLine assessment={r.assessment} className="mt-3" />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setApproving(true)}>
          {r.kind === 'grant_access' ? 'Approve and grant' : 'Approve and create'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setRejecting(true)}>
          Reject
        </Button>
      </div>

      <ApproveDialog request={r} open={approving} onOpenChange={setApproving} onApproved={onDecided} />

      <RejectDialog
        open={rejecting}
        onOpenChange={setRejecting}
        what={targetPath(r).join(' / ')}
        granting={r.kind === 'grant_access'}
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
