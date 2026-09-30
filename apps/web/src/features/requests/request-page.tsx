import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { useParams } from 'react-router'
import { DataDialog } from '@/components/data-dialog.tsx'
import { EmptyState } from '@/components/empty-state.tsx'
import { AzureDevOpsIcon, JiraIcon } from '@/components/brand-icons.tsx'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Skeleton } from '@/components/ui/skeleton'
import { useSession } from '@/features/auth/session-context.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { isInFlight, isJira, requestsApi, systemOf, targetPath, type PortalRequest } from './api.ts'
import { decide, rejectRequest } from './decisions.ts'
import { RejectDialog } from './reject-dialog.tsx'
import { ApproveDialog, WithdrawDialog } from './decision-dialogs.tsx'
import { AccessLine, KIND_LABEL, RequestName, since, StatusBadge, WrappingUrl } from './status.tsx'
import { HeaderSkeleton, Loading, TimelineSkeleton } from '@/components/skeletons.tsx'
import { Facts, PAGE, PageHeader, Section, Split } from '@/components/page-layout.tsx'

export function RequestPage() {
  const { requestId = '' } = useParams()
  const { session } = useSession()
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
      <Loading label="Loading the request…" className={PAGE}>
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
    <div className={PAGE}>
      <PageHeader
        title={<RequestName request={r} as="h1" />}
        actions={
          <>
            <StatusBadge status={r.status} kind={r.kind} />
            <DataDialog
              data={r}
              filename={`request-${r.repository ?? r.project}`}
              title="Request data"
              description="Everything stored for this request, as the API returns it."
            />
          </>
        }
      />

      <Split aside={<Details request={r} own={own} />}>
        <Section title="What happened">
          <ol>
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
          <Actions request={r} own={own} onChanged={request.reload} />
        </Section>

      </Split>
    </div>
  )
}

/** The facts of the request in one place, beside the story of it. */
function Details({ request: r, own }: { request: PortalRequest; own: boolean }) {
  const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null)
  return (
    <Section title="Details">
      <Facts
        empty="—"
        items={[
          ['Type', r.kind === 'grant_access' ? 'Access to a project' : KIND_LABEL[r.kind]],
          ...((r.collection
            ? [['Collection', <code>{r.collection}</code>]]
            : [['Key', <code>{r.projectKey}</code>]]) as [string, React.ReactNode][]),
          ['Project', <code>{r.project}</code>],
          ...(r.repository ? ([['Repository', <code>{r.repository}</code>]] as [string, React.ReactNode][]) : []),
          ['Access', <AccessLine request={r} own={own} />],
          ['Requested by', own ? 'You' : r.requestedByName],
          ['Requested', at(r.requestedAt)],
          ['Decided by', r.decidedByName],
          ['Decided', at(r.decidedAt)],
          ['Finished', at(r.completedAt)],
        ]}
      />
    </Section>
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
  const granting = r.kind === 'grant_access'
  const system = systemOf(r)
  const Icon = isJira(r) ? JiraIcon : AzureDevOpsIcon
  if (r.status === 'approved') {
    return <Step title={granting ? `Granting access in ${system}…` : `Creating it in ${system}…`} current last />
  }
  if (r.status === 'completed') {
    const cloneUrl = r.repository && r.resultUrl ? r.resultUrl : null
    return (
      <Step title={granting ? `Access granted in ${system}` : `Created in ${system}`} when={r.completedAt} done success last>
        {r.resultUrl && (
          <Button asChild variant="outline" size="sm" className="mt-3">
            <a href={r.resultUrl} target="_blank" rel="noreferrer">
              <Icon /> Open in {system} <ExternalLink />
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
      <Step title={granting ? `${system} could not grant it` : `${system} could not create it`} attention last>
        <p className="mt-2 text-sm">{r.error}</p>
        <p className="mt-2 text-sm text-muted-foreground">DevOps can retry once the cause is fixed.</p>
      </Step>
    )
  }
  return null
}

function Actions({
  request: r,
  own,
  onChanged,
}: {
  request: PortalRequest
  own: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [approving, setApproving] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)

  async function act(action: 'retry') {
    setBusy(true)
    if (await decide(action, r)) onChanged()
    setBusy(false)
  }

  // The API's answer for this request — for a team lead it depends on the
  // project, which only the server can match against their scope.
  const approver = r.canDecide ?? false
  const canDecide = approver && r.status === 'pending'
  const actions = []

  if (canDecide) {
    actions.push(
      <Button key="approve" disabled={busy} onClick={() => setApproving(true)}>
        {r.kind === 'grant_access' ? 'Approve and grant' : 'Approve and create'}
      </Button>,
      <Button key="reject" variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
        Reject
      </Button>,
    )
  }
  if (approver && r.status === 'failed') {
    actions.push(
      <Button key="retry" disabled={busy} onClick={() => act('retry')}>
        {busy && <Spinner />}
        Retry
      </Button>,
    )
  }
  if (own && r.status === 'pending') {
    actions.push(
      <Button key="cancel" variant="ghost" disabled={busy} onClick={() => setWithdrawing(true)}>
        Withdraw request
      </Button>,
    )
  }

  return (
    <>
      {actions.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-2 border-t pt-6">{actions}</div>
      )}
      <RejectDialog
        open={rejecting}
        onOpenChange={setRejecting}
        what={targetPath(r).join(' / ')}
        granting={r.kind === 'grant_access'}
        onReject={async (note) => {
          await rejectRequest(r, note)
          onChanged()
        }}
      />
      <ApproveDialog request={r} open={approving} onOpenChange={setApproving} onApproved={onChanged} />
      <WithdrawDialog request={r} open={withdrawing} onOpenChange={setWithdrawing} onWithdrawn={onChanged} />
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
  success,
  last,
  children,
}: {
  title: string
  when?: string | null
  done?: boolean
  current?: boolean
  attention?: boolean
  /** The end of a request that worked — green, like its badge. */
  success?: boolean
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
            : success
              ? 'border-success bg-success'
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
