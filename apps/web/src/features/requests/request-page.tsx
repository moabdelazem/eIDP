import { useState } from 'react'
import { Check, ExternalLink, Gavel, Loader2, TriangleAlert, Undo2, X } from 'lucide-react'
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
import { REQUEST_TYPES } from './kinds.ts'
import { RejectDialog } from './reject-dialog.tsx'
import { RiskPanel } from './risk.tsx'
import { ApproveDialog, WithdrawDialog } from './decision-dialogs.tsx'
import { AccessLine, KIND_ICON, KIND_LABEL, since, StatusBadge, TargetPath, WrappingUrl } from './status.tsx'
import { HeaderSkeleton, Loading, TimelineSkeleton } from '@/components/skeletons.tsx'
import { Facts, PAGE, Section, Split } from '@/components/page-layout.tsx'

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
      <RequestHeader request={r} own={own} onChanged={request.reload} />
      <Tracker request={r} />

      <Split
        className="mt-6"
        aside={
          <>
            {/* For deciders only — the API sends an assessment to nobody else. */}
            {r.canDecide && (
              <Section title={r.status === 'pending' ? 'Before you approve' : 'Risk assessment'}>
                <RiskPanel requestId={r.id} assessment={r.assessment} onChange={request.reload} />
              </Section>
            )}
            <Details request={r} own={own} />
          </>
        }
      >
        <DecisionCard request={r} onChanged={request.reload} />
        <Section title="Activity">
          <ol>
            <Step title={own ? 'You asked for it' : `${r.requestedByName} asked for it`} when={r.requestedAt} done>
              <blockquote className="mt-2 rounded-lg border-l-2 border-[var(--chart-1)] bg-muted/40 py-2 pr-3 pl-3 text-sm">{r.justification}</blockquote>
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
        </Section>
      </Split>
    </div>
  )
}

/**
 * The request's name, large, under what it is and where it goes — the kind's
 * mark in a tile, "Request · Azure DevOps · Repository" — with its status and
 * what its requester may do about it beside.
 */
function RequestHeader({ request: r, own, onChanged }: { request: PortalRequest; own: boolean; onChanged: () => void }) {
  const [withdrawing, setWithdrawing] = useState(false)
  const KindIcon = KIND_ICON[r.kind]
  const Mark = isJira(r) ? JiraIcon : AzureDevOpsIcon
  // The registry's short label: the provider is already said beside it ("Jira · Project", not "Jira · Jira project").
  const kind = REQUEST_TYPES.find((t) => t.kind === r.kind)?.label ?? KIND_LABEL[r.kind]
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 items-start gap-4">
        <span className="relative flex size-12 shrink-0 items-center justify-center rounded-xl border bg-card shadow-sm" aria-hidden>
          <KindIcon className="size-5 text-muted-foreground" />
          <Mark className="absolute -right-1.5 -bottom-1.5 size-5 rounded-md bg-card p-0.5 shadow-sm ring-1 ring-border" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Request · {systemOf(r)} · {kind}
          </p>
          {/* An ADO name is an identifier people copy; a Jira project's name is a title. */}
          <h1 className={`mt-0.5 text-2xl font-semibold tracking-tight break-words ${isJira(r) ? '' : 'font-mono'}`}>{r.repository ?? r.project}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isJira(r) ? (
              <>
                Key <code className="text-foreground">{r.projectKey}</code>
              </>
            ) : (
              <>
                {r.kind === 'grant_access' ? 'Access to ' : 'In '}
                <TargetPath parts={targetPath(r).slice(0, r.kind === 'grant_access' ? undefined : -1)} />
              </>
            )}{' '}
            · filed {since(r.requestedAt)} by {own ? 'you' : r.requestedByName}
          </p>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusBadge status={r.status} kind={r.kind} />
        {own && r.status === 'pending' && (
          <Button variant="outline" size="sm" onClick={() => setWithdrawing(true)}>
            <Undo2 /> Withdraw
          </Button>
        )}
        <DataDialog data={r} filename={`request-${r.repository ?? r.project}`} title="Request data" description="Everything stored for this request, as the API returns it." />
      </div>
      <WithdrawDialog request={r} open={withdrawing} onOpenChange={setWithdrawing} onWithdrawn={onChanged} />
    </header>
  )
}

type Stage = { label: string; detail: string | null; state: 'done' | 'current' | 'upcoming' | 'failed' | 'stopped' }

/** Where the request stands, as four stages: like a parcel's tracking, read at a glance. */
function stagesOf(r: PortalRequest): Stage[] {
  const granting = r.kind === 'grant_access'
  const at = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null)
  const submitted: Stage = { label: 'Submitted', detail: at(r.requestedAt), state: 'done' }
  // The third stage is the work in the provider, named for what it is doing or did; the fourth, that it is all done.
  const work = granting ? 'Granting' : 'Creating'
  const worked = granting ? 'Granted' : 'Created'
  const end = 'Done'
  switch (r.status) {
    case 'pending':
      return [submitted, { label: 'In review', detail: 'Waiting for DevOps', state: 'current' }, { label: work, detail: null, state: 'upcoming' }, { label: end, detail: null, state: 'upcoming' }]
    case 'cancelled':
      return [submitted, { label: 'Withdrawn', detail: at(r.decidedAt), state: 'stopped' }, { label: work, detail: null, state: 'upcoming' }, { label: end, detail: null, state: 'upcoming' }]
    case 'rejected':
      return [submitted, { label: 'Rejected', detail: r.decidedByName, state: 'failed' }, { label: work, detail: null, state: 'upcoming' }, { label: end, detail: null, state: 'upcoming' }]
    case 'approved':
      return [submitted, { label: 'Approved', detail: r.decidedByName, state: 'done' }, { label: work, detail: `In ${systemOf(r)}`, state: 'current' }, { label: end, detail: null, state: 'upcoming' }]
    case 'failed':
      return [submitted, { label: 'Approved', detail: r.decidedByName, state: 'done' }, { label: 'Failed', detail: 'DevOps can retry', state: 'failed' }, { label: end, detail: null, state: 'upcoming' }]
    case 'completed':
      return [submitted, { label: 'Approved', detail: r.decidedByName, state: 'done' }, { label: worked, detail: `In ${systemOf(r)}`, state: 'done' }, { label: end, detail: at(r.completedAt), state: 'done' }]
  }
}

const STAGE_DOT: Record<Stage['state'], string> = {
  done: 'border-success bg-success text-background',
  current: 'border-info bg-info-soft text-info',
  upcoming: 'border-border bg-background text-muted-foreground',
  failed: 'border-destructive bg-destructive text-background',
  stopped: 'border-muted-foreground/50 bg-muted text-muted-foreground',
}

function Tracker({ request: r }: { request: PortalRequest }) {
  const stages = stagesOf(r)
  return (
    <ol className="mt-6 grid grid-cols-2 gap-y-5 rounded-xl border bg-card px-5 py-5 shadow-sm sm:grid-cols-4" aria-label="Where this request stands">
      {stages.map((stage, i) => {
        const Icon = stage.state === 'done' ? Check : stage.state === 'failed' ? TriangleAlert : stage.state === 'stopped' ? X : stage.state === 'current' ? Loader2 : null
        const next = stages[i + 1]
        return (
          <li key={stage.label + i} className="relative flex flex-col items-center px-2 text-center" aria-current={stage.state === 'current' ? 'step' : undefined}>
            {/* The line to the next stage, solid once this one is done. */}
            {next && (
              <span
                aria-hidden
                className={`absolute top-3.5 left-[calc(50%+1.25rem)] hidden h-0.5 w-[calc(100%-2.5rem)] rounded-full sm:block ${stage.state === 'done' ? 'bg-success' : 'bg-border'}`}
              />
            )}
            <span className={`relative flex size-7 items-center justify-center rounded-full border-2 ${STAGE_DOT[stage.state]}`}>
              {Icon ? (
                <Icon className={`size-3.5 ${stage.state === 'current' ? 'animate-spin motion-reduce:animate-none' : ''}`} strokeWidth={3} aria-hidden />
              ) : (
                <span className="text-xs font-semibold tabular-nums">{i + 1}</span>
              )}
            </span>
            <span className={`mt-2 text-sm font-medium ${stage.state === 'upcoming' ? 'text-muted-foreground' : stage.state === 'failed' ? 'text-destructive' : ''}`}>{stage.label}</span>
            <span className="mt-0.5 min-h-4 text-xs text-muted-foreground">{stage.detail}</span>
            <span className="sr-only">
              {{ done: 'done', current: 'in progress', upcoming: 'not yet', failed: 'stopped here', stopped: 'stopped here' }[stage.state]}
            </span>
          </li>
        )
      })}
    </ol>
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

/**
 * For whoever may decide it: what it asks and the two answers, at the top of
 * the page rather than under the story — and Retry once a creation failed.
 */
function DecisionCard({ request: r, onChanged }: { request: PortalRequest; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [approving, setApproving] = useState(false)
  // The API's answer for this request — for a team lead it depends on the
  // project, which only the server can match against their scope.
  const approver = r.canDecide ?? false
  const pending = approver && r.status === 'pending'
  const retry = approver && r.status === 'failed'
  if (!pending && !retry) return null

  async function act(action: 'retry') {
    setBusy(true)
    if (await decide(action, r)) onChanged()
    setBusy(false)
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-l-4 border-l-primary bg-card p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 gap-3">
        <Gavel className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium">{pending ? 'This request is waiting for your decision' : `${systemOf(r)} could not finish it`}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {pending
              ? r.kind === 'grant_access'
                ? 'Approving grants the access straight away. Read the risk notes beside this first.'
                : `Approving creates it in ${systemOf(r)} and grants access. Read the risk notes beside this first.`
              : 'Retry once the cause in the activity below is fixed. A retry picks up where it stopped.'}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {pending ? (
          <>
            <Button variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
              Reject
            </Button>
            <Button disabled={busy} onClick={() => setApproving(true)}>
              {r.kind === 'grant_access' ? 'Approve and grant' : 'Approve and create'}
            </Button>
          </>
        ) : (
          <Button disabled={busy} onClick={() => act('retry')}>
            {busy && <Spinner />}
            Retry
          </Button>
        )}
      </div>
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
    </div>
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
