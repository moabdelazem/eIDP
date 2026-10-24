import { useState } from 'react'
import { Check, ExternalLink, Gavel, Loader2, TriangleAlert, Undo2, Workflow, X } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { DataDialog } from '@/components/data-dialog.tsx'
import { EmptyState } from '@/components/empty-state.tsx'
import { AzureDevOpsIcon, JenkinsIcon, JiraIcon } from '@/components/brand-icons.tsx'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Skeleton } from '@/components/ui/skeleton'
import { useSession } from '@/features/auth/session-context.tsx'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { isAccess, isInFlight, isJira, isPipeline, isRevoke, pipelineFormFor, requestsApi, stepMoving, systemOf, targetPath, type PortalRequest } from './api.ts'
import { AdjustDialog, canAdjust } from './adjust-dialog.tsx'
import { decide, rejectRequest } from './decisions.ts'
import { REQUEST_TYPES } from './kinds.ts'
import { RejectDialog } from './reject-dialog.tsx'
import { PipelinePanel } from './pipeline-panel.tsx'
import { RiskPanel } from './risk.tsx'
import { ApproveDialog, WithdrawDialog } from './decision-dialogs.tsx'
import { AccessLine, kindIcon, kindLabel, since, statusLabel, StatusBadge, TargetPath, WrappingUrl } from './status.tsx'
import { HeaderSkeleton, Loading, TimelineSkeleton } from '@/components/skeletons.tsx'
import { Facts, PAGE, Section, Split } from '@/components/page-layout.tsx'

export function RequestPage() {
  const { requestId = '' } = useParams()
  const { session } = useSession()
  const [pollMs, setPollMs] = useState<number | null>(3000)
  const request = useResource(['requests', 'get', requestId], async () => {
      const found = await requestsApi.get(requestId)
      // Watch it while it is moving — or its pipeline's steps are, in Jenkins — and stop once all have settled.
      setPollMs(isInFlight(found.status) || found.steps.some(stepMoving) ? 3000 : null)
      return found
    }, { pollMs })
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
            {/* DevOps only: the API sends an assessment to nobody else, not even a team lead. */}
            {r.assessment !== undefined && (
              <Section title={r.status === 'pending' ? 'Before you approve' : 'Risk assessment'}>
                <RiskPanel requestId={r.id} assessment={r.assessment} onChange={request.reload} />
              </Section>
            )}
            <Details request={r} own={own} />
            {r.filedWith && r.filedWith.length > 0 && <FiledWithSection request={r} />}
          </>
        }
      >
        <DecisionCard request={r} onChanged={request.reload} />
        {r.kind === 'create_pipeline' && <PipelinePanel request={r} onChanged={request.reload} />}
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

            {r.adjustments.length > 0 && <AdjustedStep request={r} own={own} />}
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
 * mark in a tile, "Repository request in Azure DevOps" — with its status and
 * what its requester may do about it beside.
 */
function RequestHeader({ request: r, own, onChanged }: { request: PortalRequest; own: boolean; onChanged: () => void }) {
  const [withdrawing, setWithdrawing] = useState(false)
  const KindIcon = kindIcon(r.kind)
  const Mark = isJira(r) ? JiraIcon : isPipeline(r) ? JenkinsIcon : AzureDevOpsIcon
  // The registry's short label: the provider is already said beside it ("Jira · Project", not "Jira · Jira project").
  const kind = REQUEST_TYPES.find((t) => t.kind === r.kind)?.label ?? kindLabel(r.kind)
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 items-start gap-4">
        <span className="relative flex size-12 shrink-0 items-center justify-center rounded-xl border bg-card shadow-sm" aria-hidden>
          <KindIcon className="size-5 text-muted-foreground" />
          <Mark className="absolute -right-1.5 -bottom-1.5 size-5 rounded-md bg-card p-0.5 shadow-sm ring-1 ring-border" />
        </span>
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">
            {kind} request in {systemOf(r)}
          </p>
          {/* An ADO name is an identifier people copy; a Jira project's name is a title. */}
          <h1 className={`mt-0.5 text-2xl font-semibold tracking-tight break-words ${isJira(r) ? '' : 'font-mono'}`}>{r.pipeline?.application ?? r.repository ?? r.project}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isJira(r) ? (
              <>
                Key <code className="text-foreground">{r.projectKey}</code>
              </>
            ) : (
              <>
                {r.kind === 'grant_access' ? 'Access to ' : isRevoke(r) ? 'Removing access to ' : isPipeline(r) ? 'From ' : 'In '}
                <TargetPath parts={targetPath(r).slice(0, isAccess(r) ? undefined : -1)} />
              </>
            )}{' '}
            · filed {since(r.requestedAt)} by {own ? 'you' : r.requestedByName}
          </p>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusBadge status={r.status} kind={r.kind} />
        {canAdjust(r) && <AdjustDialog request={r} onChanged={onChanged} />}
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
  const work = granting ? 'Granting' : isRevoke(r) ? 'Removing' : isPipeline(r) ? 'Setting up' : 'Creating'
  const worked = granting ? 'Granted' : isRevoke(r) ? 'Removed' : isPipeline(r) ? 'Set up' : 'Created'
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
    default:
      // A status this build does not know yet (a newer API): say what it is rather than guess the stages.
      return [submitted, { label: statusLabel(r.status), detail: null, state: 'current' }, { label: work, detail: null, state: 'upcoming' }, { label: end, detail: null, state: 'upcoming' }]
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
            <span className={`relative flex size-7 items-center justify-center rounded-full border-2 ${STAGE_DOT[stage.state] ?? STAGE_DOT.upcoming}`}>
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
          ['Type', r.kind === 'grant_access' ? 'Access to a project' : isRevoke(r) ? 'Removing access from a project' : kindLabel(r.kind)],
          ...((r.collection
            ? [['Collection', <code>{r.collection}</code>]]
            : [['Key', <code>{r.projectKey}</code>]]) as [string, React.ReactNode][]),
          ['Project', <code>{r.project}</code>],
          ...(isJira(r) ? ([['Lead', r.projectLead ? <code>{r.projectLead}</code> : own ? 'You' : r.requestedByName]] as [string, React.ReactNode][]) : []),
          ...(r.repository ? ([['Repository', <code>{r.repository}</code>]] as [string, React.ReactNode][]) : []),
          ...(isPipeline(r) ? [] : ([['Access', <AccessLine request={r} own={own} />]] as [string, React.ReactNode][])),
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

/**
 * The other part of the same New project request — its Jira project, or its
 * Azure DevOps project — with where it stands. Each is decided on its own, so
 * a decider moves from one to the other from here.
 */
function FiledWithSection({ request: r }: { request: PortalRequest }) {
  return (
    <Section title="Asked for with it">
      <ul className="space-y-2">
        {r.filedWith!.map((other) => {
          const Mark = isJira(other) ? JiraIcon : AzureDevOpsIcon
          return (
            <li key={other.id}>
              <Link to={`/requests/${other.id}`} className="block rounded-lg border p-3 transition-colors hover:bg-muted/40">
                <span className="flex items-center gap-2">
                  <Mark className="size-4 shrink-0" />
                  <span className="flex-1 text-sm font-medium">{isJira(other) ? 'Jira project' : 'Azure DevOps project'}</span>
                  <StatusBadge status={other.status} />
                </span>
                <TargetPath parts={targetPath({ ...other, repository: null })} className="mt-1.5 block text-xs text-muted-foreground" />
              </Link>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

/**
 * What deciders changed before approving, as asked → as it will be done: the
 * requester sees their request was changed, by whom, and from what — nothing
 * is quietly replaced. Grouped by who made them.
 */
function AdjustedStep({ request: r, own }: { request: PortalRequest; own: boolean }) {
  const byWho = new Map<string, PortalRequest['adjustments']>()
  for (const a of r.adjustments) byWho.set(a.byName, [...(byWho.get(a.byName) ?? []), a])
  return [...byWho.entries()].map(([name, changes]) => (
    <Step key={name} title={`Changed by ${name} before deciding`} when={changes.at(-1)!.at} done>
      <ul className="mt-2 space-y-1 text-sm">
        {changes.map((c, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="text-muted-foreground">{c.label}:</span>
            {c.field === 'files' ? (
              <span>{c.to}</span>
            ) : (
              <>
                <code className="break-words text-muted-foreground line-through decoration-muted-foreground/60">{c.from ?? '—'}</code>
                <span aria-label="changed to">→</span>
                <code className="break-words">{c.to}</code>
              </>
            )}
          </li>
        ))}
      </ul>
      {own && <p className="mt-2 text-xs text-muted-foreground">What you asked for is kept on the request.</p>}
    </Step>
  ))
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
  const { can } = useProfile()
  const granting = r.kind === 'grant_access'
  const revoking = isRevoke(r)
  const system = systemOf(r)
  const pipeline = isPipeline(r)
  const Icon = isJira(r) ? JiraIcon : AzureDevOpsIcon
  if (r.status === 'approved') {
    return <Step title={granting ? `Granting access in ${system}…` : revoking ? `Removing access in ${system}…` : pipeline ? 'Setting up your pipeline…' : `Creating it in ${system}…`} current last />
  }
  if (r.status === 'completed') {
    const cloneUrl = r.kind === 'create_repository' && r.resultUrl ? r.resultUrl : null
    return (
      <Step title={granting ? `Access granted in ${system}` : revoking ? `Access removed in ${system}` : pipeline ? 'Pipeline set up' : `Created in ${system}`} when={r.completedAt} done success last>
        {/* A pipeline's result is a commit: DevOps' to read, not the requester's. */}
        {r.resultUrl && (!pipeline || can('requests.decide')) && (
          <Button asChild variant="outline" size="sm" className="mt-3">
            <a href={r.resultUrl} target="_blank" rel="noreferrer">
              <Icon /> {pipeline ? 'Open the commit' : `Open in ${system}`} <ExternalLink />
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
        {/* The old portal's ➕ beside a repository: its pipeline next, with the repository filled in. */}
        {r.kind === 'create_repository' && (
          <Button asChild size="sm" className="mt-3">
            <Link to={pipelineFormFor(r)}>
              <Workflow /> Set up its pipeline
            </Link>
          </Button>
        )}
      </Step>
    )
  }
  if (r.status === 'failed') {
    return (
      <Step title={granting ? `${system} could not grant it` : revoking ? `${system} could not remove it` : pipeline ? 'Your pipeline could not be set up' : `${system} could not create it`} attention last>
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
              ? (r.kind === 'grant_access'
                  ? 'Approving grants the access straight away.'
                  : isRevoke(r)
                    ? 'Approving removes the access straight away.'
                  : isPipeline(r)
                    ? 'Approving pushes the files below to inventories at once. Read them first.'
                    : `Approving creates it in ${systemOf(r)} and grants access.`) +
                // Only DevOps are sent the risk assessment; a team lead has none beside it.
                (r.assessment !== undefined ? ' Read the risk notes beside this first.' : '')
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
              {r.kind === 'grant_access' ? 'Approve and grant' : isRevoke(r) ? 'Approve and remove' : isPipeline(r) ? 'Approve and push' : 'Approve and create'}
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
        revoking={isRevoke(r)}
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
