import { useCallback, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { CircleCheck, ExternalLink, EyeOff, RefreshCw, Server, Sparkles, X } from 'lucide-react'
import { JenkinsIcon } from '@/components/brand-icons.tsx'
import { EmptyState } from '@/components/empty-state.tsx'
import { PAGE, PageHeader } from '@/components/page-layout.tsx'
import { Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { since } from '@/features/requests/status.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { toast } from 'sonner'
import { ActionDialog, type Pending } from './actions.tsx'
import { buildPath, jenkinsApi, WINDOW_LABEL, type AuditEntry, type Failure, type Overview, type Result, type Window } from './api.ts'
import { Dashboard } from './dashboard.tsx'
import { IgnoreDialog, IgnoredList } from './ignore.tsx'
import { JobName, RESULT, ResultBadge } from './result.tsx'
import { ParameterChips, RunAction, Runs } from './runs.tsx'

type Tab = 'dashboard' | 'failures' | 'runs' | 'queue' | 'agents' | 'activity'
const TABS: Tab[] = ['dashboard', 'failures', 'runs', 'queue', 'agents', 'activity']
const RESULTS = Object.keys(RESULT) as Result[]

/**
 * Jenkins for DevOps: how the last day or week went, what is broken now and
 * for how long, every build searchable by what it ran with, what is waiting,
 * which agents are down — and who did what about it from here.
 *
 * Everything the page shows lives in the URL — tab, window, search — so a
 * link lands on exactly this view. History comes from the portal's own copy,
 * which the API keeps in step with Jenkins every minute; Refresh pulls now.
 * Mounted behind `jenkins.view`; the actions need `jenkins.operate`, which
 * the API checks again.
 */
export function JenkinsPage() {
  const [version, setVersion] = useState(0)
  const overview = useResource(['jenkins', 'overview', version], () => jenkinsApi.overview(version > 0), { pollMs: 30_000 })
  const audit = useResource(['jenkins', 'audit', version], () => jenkinsApi.audit(), { pollMs: 60_000 })
  const { can } = useProfile()
  const canOperate = can('jenkins.operate')

  const [params, setParams] = useSearchParams()
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? (params.get('tab') as Tab) : 'dashboard'
  const window: Window = params.get('window') === '7d' ? '7d' : '24h'
  const q = params.get('q') ?? ''
  const result: Result | 'all' = RESULTS.includes(params.get('result') as Result) ? (params.get('result') as Result) : 'all'

  /** Changes the view in the URL; `undefined` leaves a key alone, a default removes it. */
  const setView = useCallback(
    (next: { tab?: Tab; window?: Window; q?: string; result?: Result | 'all' }) =>
      setParams(
        (current) => {
          const copy = new URLSearchParams(current)
          const put = (key: string, value: string | undefined, fallback: string) => {
            if (value === undefined) return
            if (value === fallback || value === '') copy.delete(key)
            else copy.set(key, value)
          }
          put('tab', next.tab, 'dashboard')
          put('window', next.window, '24h')
          put('q', next.q, '')
          put('result', next.result, 'all')
          return copy
        },
        { replace: true },
      ),
    [setParams],
  )

  const [pending, setPending] = useState<Pending | null>(null)
  const [ignoring, setIgnoring] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const failing = overview.data?.counts.failing ?? 0
  // The count first, so a tab left open says when something breaks.
  usePageTitle(failing > 0 ? `(${failing} failing) Jenkins` : 'Jenkins')

  /** Pulls history from Jenkins now, then reloads everything on the page. */
  async function refresh() {
    setRefreshing(true)
    try {
      await jenkinsApi.sync()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not read Jenkins.')
    }
    setVersion((v) => v + 1)
    setRefreshing(false)
  }

  const heading = (
    <h1 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
      <JenkinsIcon className="size-5" />
      Jenkins
    </h1>
  )

  if (overview.error && !overview.data) {
    return (
      <div className={PAGE}>
        <PageHeader title={heading} />
        <div className="mt-6">
          <EmptyState title="Jenkins can’t be read right now" icon={Server} action={<Button variant="outline" onClick={overview.reload}>Try again</Button>}>
            {overview.error}
          </EmptyState>
        </div>
      </div>
    )
  }
  if (!overview.data) {
    return (
      <Loading label="Loading Jenkins…" className={PAGE}>
        <PageHeader title={heading} />
        <div className="mt-6">
          <RowsSkeleton rows={6} />
        </div>
      </Loading>
    )
  }

  const o = overview.data
  const windowed = tab === 'dashboard' || tab === 'runs'

  return (
    <div className={PAGE}>
      <PageHeader
        title={heading}
        description={<SyncLine overview={o} />}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={refreshing}>
              {refreshing ? <Spinner /> : <RefreshCw />} Refresh
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href={o.url} target="_blank" rel="noreferrer">
                Open Jenkins <ExternalLink />
              </a>
            </Button>
          </>
        }
      />

      <Tiles overview={o} active={tab} onPick={(next) => setView({ tab: next })} />

      <Tabs value={tab} onValueChange={(next) => setView({ tab: next as Tab })} className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* h-auto! because tabs.tsx fixes the list at h-9 with a group selector that out-specifies h-auto, and a wrapped second row would spill out of it on a phone. */}
          <TabsList className="h-auto! max-w-full flex-wrap">
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="failures">
              Failing{o.counts.failing > 0 && <span className="text-muted-foreground tabular-nums">{o.counts.failing}</span>}
            </TabsTrigger>
            <TabsTrigger value="runs">Builds</TabsTrigger>
            <TabsTrigger value="queue">
              Queue{o.counts.queued > 0 && <span className="text-muted-foreground tabular-nums">{o.counts.queued}</span>}
            </TabsTrigger>
            <TabsTrigger value="agents">Agents</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          {/* The one filter, above everything it scopes; the other tabs are "now". */}
          {windowed && (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={window}
              onValueChange={(value) => value && setView({ window: value as Window })}
              aria-label="Time window"
            >
              {(Object.keys(WINDOW_LABEL) as Window[]).map((w) => (
                <ToggleGroupItem key={w} value={w} className="px-3" aria-label={WINDOW_LABEL[w]}>
                  {w === '24h' ? '24 hours' : '7 days'}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
        </div>

        <TabsContent value="dashboard" className="mt-4">
          <Dashboard window={window} version={version} onJob={(job) => setView({ tab: 'runs', q: job, result: 'all' })} />
        </TabsContent>
        <TabsContent value="failures" className="mt-4">
          <FailuresTable
            failures={o.failures}
            ignored={o.counts.ignored}
            canOperate={canOperate}
            onAct={setPending}
            onIgnore={setIgnoring}
            onPick={(term) => setView({ tab: 'runs', q: term })}
          />
          <IgnoredList failures={o.ignored} canOperate={canOperate} onDone={() => setVersion((v) => v + 1)} />
        </TabsContent>
        <TabsContent value="runs" className="mt-4">
          <Runs window={window} version={version} q={q} result={result} onChange={setView} canOperate={canOperate} onAct={setPending} />
        </TabsContent>
        <TabsContent value="queue" className="mt-4">
          <QueueTable overview={o} canOperate={canOperate} onAct={setPending} />
        </TabsContent>
        <TabsContent value="agents" className="mt-4">
          <AgentsTable overview={o} />
        </TabsContent>
        <TabsContent value="activity" className="mt-4">
          {audit.error && !audit.data ? (
            <p className="text-sm text-destructive">{audit.error}</p>
          ) : !audit.data ? (
            <Loading label="Loading activity…">
              <RowsSkeleton rows={3} />
            </Loading>
          ) : (
            <ActivityTable entries={audit.data} />
          )}
        </TabsContent>
      </Tabs>

      <ActionDialog pending={pending} onClose={() => setPending(null)} onDone={() => setVersion((v) => v + 1)} />
      <IgnoreDialog job={ignoring} onClose={() => setIgnoring(null)} onDone={() => setVersion((v) => v + 1)} />
    </div>
  )
}

/** Which server, how many jobs, and how current the history is — or why it is not. */
function SyncLine({ overview: o }: { overview: Overview }) {
  const host = <span className="font-mono text-sm">{o.url.replace(/^https?:\/\//, '')}</span>
  if (!o.sync.finishedAt) {
    return (
      <>
        {o.counts.jobs || 'No'} jobs on {host}. Reading build history for the first time
        {o.sync.startedAt ? '…' : ' — it starts in a moment.'}
      </>
    )
  }
  return (
    <>
      {o.counts.jobs} jobs on {host}, history read {since(o.sync.finishedAt)}.
      {!o.sync.ok && <span className="text-destructive"> The last read failed: {o.sync.error}</span>}
      {o.sync.ok && o.sync.error && <span className="text-warning"> {o.sync.error}</span>}
    </>
  )
}

/**
 * What is true now, each a way into its tab. Red only for what needs
 * someone: failing jobs, and agents that are down.
 */
function Tiles({ overview: o, active, onPick }: { overview: Overview; active: Tab; onPick: (tab: Tab) => void }) {
  const tiles: { tab: Tab; label: string; n: number; dot: string; alarm: boolean }[] = [
    { tab: 'failures', label: 'Failing now', n: o.counts.failing, dot: RESULT.failure.dot, alarm: o.counts.failing > 0 },
    { tab: 'runs', label: 'Running now', n: o.counts.running, dot: RESULT.running.dot, alarm: false },
    { tab: 'queue', label: 'Waiting in queue', n: o.counts.queued, dot: 'bg-warning', alarm: false },
    { tab: 'agents', label: 'Agents offline', n: o.counts.agentsOffline, dot: 'bg-destructive', alarm: o.counts.agentsOffline > 0 },
  ]
  return (
    <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((tile) => (
        <button
          key={tile.tab}
          type="button"
          aria-pressed={active === tile.tab}
          onClick={() => onPick(tile.tab)}
          className={`rounded-xl border bg-card px-4 py-3 text-left shadow-sm transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none ${
            active === tile.tab ? 'border-ring ring-1 ring-ring/40' : ''
          }`}
        >
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className={`size-2 rounded-full ${tile.dot}`} />
            {tile.label}
          </span>
          <span className={`mt-1 block text-2xl font-semibold ${tile.alarm ? 'text-primary' : ''}`}>{tile.n}</span>
        </button>
      ))}
    </div>
  )
}

function FailuresTable({
  failures,
  ignored,
  canOperate,
  onAct,
  onIgnore,
  onPick,
}: {
  failures: Failure[]
  ignored: number
  canOperate: boolean
  onAct: (pending: Pending) => void
  onIgnore: (job: string) => void
  onPick: (term: string) => void
}) {
  if (failures.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-dashed px-4 py-8 text-sm text-muted-foreground">
        <CircleCheck className="size-4 text-success" />
        {ignored > 0 ? `Nothing else is failing — ${ignored} ignored below.` : 'Every job’s latest build passed.'}
      </div>
    )
  }
  return (
    <div className="rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Job</TableHead>
            <TableHead>Latest</TableHead>
            <TableHead className="hidden md:table-cell">Parameters</TableHead>
            <TableHead className="hidden md:table-cell">Broken for</TableHead>
            <TableHead className="hidden lg:table-cell">Last passed</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {failures.map((f) => (
            <TableRow key={f.job}>
              <TableCell className="max-w-md">
                <Link to={buildPath(f.last)} className="hover:underline">
                  <JobName name={f.job} className="text-sm" />
                </Link>
                {/* The model's one line on why, made when the build failed — the full answer is on the build page. */}
                {f.explanation && (
                  <p className="mt-1 flex items-start gap-1.5 text-xs whitespace-normal text-muted-foreground" title={f.explanation.summary}>
                    <Sparkles className="mt-0.5 size-3 shrink-0 text-[var(--chart-1)]" aria-label="AI explanation:" />
                    <span className="line-clamp-2">{f.explanation.summary}</span>
                  </p>
                )}
                {(f.running || f.inQueue) && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{f.running ? 'A new build is running' : 'A new build is queued'}</p>
                )}
              </TableCell>
              <TableCell>
                <Link to={buildPath(f.last)} className="flex flex-wrap items-center gap-2">
                  <ResultBadge result={f.last.result} />
                  <span className="font-mono text-xs text-muted-foreground">#{f.last.number}</span>
                </Link>
              </TableCell>
              <TableCell className="hidden max-w-80 md:table-cell">
                <ParameterChips parameters={f.last.parameters} terms={[]} onPick={onPick} />
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <span>
                  {f.streak}
                  {f.streakAtLeast && '+'} {f.streak === 1 && !f.streakAtLeast ? 'build' : 'builds'}
                </span>
                <span className="block text-xs text-muted-foreground">since {since(f.since)}</span>
              </TableCell>
              <TableCell className="hidden text-muted-foreground lg:table-cell">
                {f.lastSuccess ? since(f.lastSuccess) : 'Not in the history kept'}
              </TableCell>
              <TableCell className="text-right">
                {canOperate && (
                  <div className="flex items-center justify-end gap-1.5">
                    <RunAction run={f.last} onAct={onAct} />
                    <Button size="sm" variant="ghost" onClick={() => onIgnore(f.job)} aria-label={`Ignore ${f.job}`} title="Take it off the failing list, with a reason">
                      <EyeOff /> <span className="hidden sm:inline">Ignore</span>
                    </Button>
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function QueueTable({ overview: o, canOperate, onAct }: { overview: Overview; canOperate: boolean; onAct: (pending: Pending) => void }) {
  if (o.queue.length === 0) {
    return <p className="rounded-xl border border-dashed px-4 py-8 text-sm text-muted-foreground">Nothing is waiting — every build has an executor.</p>
  }
  return (
    <div className="rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Job</TableHead>
            <TableHead>Waiting</TableHead>
            <TableHead className="hidden md:table-cell">Why</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {o.queue.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="max-w-80">
                <JobName name={item.job ?? item.name} className="text-sm" />
                {item.stuck && <p className="mt-0.5 text-xs text-destructive">Stuck — no agent can run it</p>}
              </TableCell>
              <TableCell className="text-muted-foreground">{since(item.since)}</TableCell>
              <TableCell className="hidden max-w-96 text-muted-foreground md:table-cell">{item.why ?? '—'}</TableCell>
              <TableCell className="text-right">
                {canOperate && (
                  <Button size="sm" variant="outline" onClick={() => onAct({ kind: 'cancel', item })} aria-label={`Remove ${item.job ?? item.name} from the queue`}>
                    <X /> <span className="hidden sm:inline">Remove</span>
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function AgentsTable({ overview: o }: { overview: Overview }) {
  // Down first: that is why someone opens this tab.
  const agents = [...o.agents].sort((a, b) => Number(b.offline) - Number(a.offline) || a.name.localeCompare(b.name))
  return (
    <div className="rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Executors busy</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {agents.map((agent) => (
            <TableRow key={agent.name}>
              <TableCell className="font-mono text-sm">{agent.name}</TableCell>
              <TableCell>
                {agent.offline ? (
                  <>
                    <span className="inline-flex items-center gap-1.5 text-sm text-destructive">
                      <span aria-hidden className="size-2 rounded-full bg-destructive" />
                      {agent.temporarilyOffline ? 'Taken offline' : 'Offline'}
                    </span>
                    {agent.reason && <p className="mt-0.5 text-xs text-muted-foreground">{agent.reason}</p>}
                  </>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-sm text-success">
                    <span aria-hidden className="size-2 rounded-full bg-success" />
                    Online
                  </span>
                )}
              </TableCell>
              <TableCell className="tabular-nums text-muted-foreground">
                {agent.busy} of {agent.executors}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

const ACTION_LABEL: Record<AuditEntry['action'], string> = {
  rebuild: 'Ran again',
  stop: 'Stopped',
  cancel: 'Removed from queue',
  ignore: 'Ignored the failure',
  unignore: 'Stopped ignoring',
}

/** Who asked the portal to act in Jenkins — Jenkins itself only sees the service account. */
function ActivityTable({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return <p className="rounded-xl border border-dashed px-4 py-8 text-sm text-muted-foreground">Nobody has acted on Jenkins from here yet.</p>
  }
  return (
    <div className="rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Who</TableHead>
            <TableHead>What</TableHead>
            <TableHead>Job</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((e) => (
            <TableRow key={e.id}>
              <TableCell className="text-muted-foreground" title={new Date(e.at).toLocaleString()}>
                {since(e.at)}
              </TableCell>
              <TableCell>{e.actorName}</TableCell>
              <TableCell>
                {ACTION_LABEL[e.action]}
                {e.note && <p className="max-w-80 text-xs whitespace-normal text-muted-foreground">{e.note}</p>}
                {!e.ok && <p className="max-w-80 text-xs whitespace-normal text-destructive">Refused: {e.error}</p>}
              </TableCell>
              <TableCell className="max-w-80">
                {e.build !== null ? (
                  <Link to={buildPath({ job: e.job, number: e.build })} className="hover:underline">
                    <JobName name={e.job} className="text-sm" /> <span className="font-mono text-xs text-muted-foreground">#{e.build}</span>
                  </Link>
                ) : (
                  <JobName name={e.job} className="text-sm" />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
