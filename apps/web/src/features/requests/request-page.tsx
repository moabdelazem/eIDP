import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { useParams } from 'react-router'
import { DataView } from '@/components/data-view.tsx'
import { EmptyState } from '@/components/empty-state.tsx'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Skeleton } from '@/components/ui/skeleton'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { useSession } from '@/features/auth/session-context.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { isInFlight, requestsApi, targetPath, type PortalRequest } from './api.ts'
import { decide, rejectRequest } from './decisions.ts'
import { RejectDialog } from './reject-dialog.tsx'
import { RequestName, since, StatusBadge, WrappingUrl } from './status.tsx'
import { HeaderSkeleton, Loading, TimelineSkeleton } from '@/components/skeletons.tsx'

export function RequestPage() {
  const { requestId = '' } = useParams()
  const { session } = useSession()
  const { isApprover: approver } = useProfile()
  const [pollMs, setPollMs] = useState<number | null>(3000)
  const request = useResource(
    async () => {
      const found = await requestsApi.get(requestId)
      // Watch it while it is moving; stop once it has settled.
      setPollMs(isInFlight(found.status) ? 3000 : null)
      return found
    },
    [requestId],
    { pollMs },
  )
  usePageTitle(request.data ? (request.data.repository ?? request.data.project) : 'Request')

  if (request.error && !request.data) {
    return <EmptyState title="Request not found">{request.error}</EmptyState>
  }
  if (!request.data) {
    return (
      <Loading label="Loading the request…" className="max-w-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <HeaderSkeleton />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <div className="mt-8">
          <TimelineSkeleton />
        </div>
      </Loading>
    )
  }

  const r = request.data
  const own = r.requestedBy === session?.uid

  return (
    <div className="max-w-2xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <RequestName request={r} as="h1" />
        <StatusBadge status={r.status} />
      </div>

      <ol className="mt-8 space-y-0">
        <Step title={own ? 'You asked for it' : `${r.requestedByName} asked for it`} when={r.requestedAt} done>
          <blockquote className="mt-2 border-l-2 pl-3 text-sm text-muted-foreground">{r.justification}</blockquote>
          {r.description && (
            <p className="mt-2 text-sm">
              <span className="text-muted-foreground">Description: </span>
              {r.description}
            </p>
          )}
        </Step>

        <DecisionStep request={r} own={own} />
        <OutcomeStep request={r} />
      </ol>

      <Actions request={r} approver={approver} own={own} onChanged={request.reload} />

      <details className="group mt-10">
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
          Request data
        </summary>
        <DataView className="mt-3" data={r} filename={`request-${r.repository ?? r.project}`} />
      </details>
    </div>
  )
}

function DecisionStep({ request: r, own }: { request: PortalRequest; own: boolean }) {
  if (r.status === 'pending') {
    return <Step title="Waiting for DevOps to decide" current />
  }
  if (r.status === 'cancelled') {
    return <Step title={own ? 'You withdrew it' : `${r.requestedByName} withdrew it`} when={r.decidedAt} done last />
  }
  if (r.status === 'rejected') {
    return (
      <Step title={`Rejected by ${r.decidedByName}`} when={r.decidedAt} attention last>
        {r.decisionNote && <p className="mt-2 text-sm">{r.decisionNote}</p>}
        <p className="mt-2 text-sm text-muted-foreground">Fix what they raised and ask again.</p>
      </Step>
    )
  }
  return (
    <Step title={`Approved by ${r.decidedByName}`} when={r.decidedAt} done>
      {r.decisionNote && <p className="mt-2 text-sm text-muted-foreground">{r.decisionNote}</p>}
    </Step>
  )
}

function OutcomeStep({ request: r }: { request: PortalRequest }) {
  if (r.status === 'approved') {
    return <Step title="Creating it in Azure DevOps…" current last />
  }
  if (r.status === 'completed') {
    const cloneUrl = r.kind === 'create_repository' && r.resultUrl ? r.resultUrl : null
    return (
      <Step title="Created in Azure DevOps" when={r.completedAt} done last>
        {r.resultUrl && (
          <Button asChild variant="outline" size="sm" className="mt-3">
            <a href={r.resultUrl} target="_blank" rel="noreferrer">
              Open in Azure DevOps <ExternalLink />
            </a>
          </Button>
        )}
        {cloneUrl && (
          <div className="mt-3">
            <p className="text-xs text-muted-foreground">Clone</p>
            <code className="mt-1 block rounded-md border bg-muted/40 px-3 py-2 text-xs select-all">
              git clone <WrappingUrl url={cloneUrl} />
            </code>
          </div>
        )}
      </Step>
    )
  }
  if (r.status === 'failed') {
    return (
      <Step title="Azure DevOps could not create it" attention last>
        <p className="mt-2 text-sm">{r.error}</p>
        <p className="mt-2 text-sm text-muted-foreground">DevOps can retry once the cause is fixed.</p>
      </Step>
    )
  }
  return null
}

function Actions({
  request: r,
  approver,
  own,
  onChanged,
}: {
  request: PortalRequest
  approver: boolean
  own: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)

  async function act(action: 'approve' | 'retry' | 'cancel') {
    setBusy(true)
    if (await decide(action, r)) onChanged()
    setBusy(false)
  }

  const canDecide = approver && !own && r.status === 'pending'
  const actions = []

  if (canDecide) {
    actions.push(
      <Button key="approve" disabled={busy} onClick={() => act('approve')}>
        {busy && <Spinner />}
        Approve and create
      </Button>,
      <Button key="reject" variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
        Reject
      </Button>,
    )
  }
  if (approver && r.status === 'failed') {
    actions.push(
      <Button key="retry" disabled={busy} onClick={() => act('retry')}>
        Retry
      </Button>,
    )
  }
  if (own && r.status === 'pending') {
    actions.push(
      <Button key="cancel" variant="ghost" disabled={busy} onClick={() => act('cancel')}>
        Withdraw request
      </Button>,
    )
  }

  return (
    <>
      {(actions.length > 0 || (approver && own && r.status === 'pending')) && (
        <div className="mt-8 flex flex-wrap items-center gap-2 border-t pt-6">
          {actions}
          {approver && own && r.status === 'pending' && (
            <p className="text-sm text-muted-foreground">
              This is your own request, so someone else in DevOps has to decide it.
            </p>
          )}
        </div>
      )}
      <RejectDialog
        open={rejecting}
        onOpenChange={setRejecting}
        what={targetPath(r).join(' / ')}
        onReject={async (note) => {
          await rejectRequest(r, note)
          onChanged()
        }}
      />
    </>
  )
}

/** One step of a real sequence — requested, decided, created — so numbering-free but ordered. */
function Step({
  title,
  when,
  done,
  current,
  attention,
  last,
  children,
}: {
  title: string
  when?: string | null
  done?: boolean
  current?: boolean
  attention?: boolean
  last?: boolean
  children?: React.ReactNode
}) {
  return (
    // Keyed on the title, so a step that changes (waiting → approved) is a new
    // element and fades in, instead of its text swapping silently.
    <li key={title} className="reveal relative flex gap-4 pb-8 last:pb-0">
      {!last && <span aria-hidden className="absolute top-5 bottom-0 left-[7px] w-px bg-border" />}
      <span
        aria-hidden
        className={[
          'relative mt-1 flex size-[15px] shrink-0 items-center justify-center rounded-full border-2',
          attention
            ? 'border-destructive bg-destructive'
            : done
              ? 'border-foreground bg-foreground'
              : current
                ? 'border-foreground bg-background'
                : 'border-border bg-background',
        ].join(' ')}
      >
        {current && <span className="size-1.5 animate-pulse rounded-full bg-foreground motion-reduce:animate-none" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`font-medium ${attention ? 'text-destructive' : ''}`}>{title}</p>
        {when && (
          <p className="text-xs text-muted-foreground" title={new Date(when).toLocaleString()}>
            {since(when)}
          </p>
        )}
        {children}
      </div>
    </li>
  )
}
