import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { CircleCheck, ExternalLink, RefreshCw, RotateCcw, Search, Server, Square, X } from 'lucide-react'
import { JenkinsIcon } from '@/components/brand-icons.tsx'
import { EmptyState } from '@/components/empty-state.tsx'
import { PAGE, PageHeader } from '@/components/page-layout.tsx'
import { Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { since } from '@/features/requests/status.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { ActionDialog, type Pending } from './actions.tsx'
import { duration, jenkinsApi, type AuditEntry, type Build, type Failure, type Overview, type Result } from './api.ts'
import { JobName, RESULT, ResultBadge } from './result.tsx'
import { RunDialog } from './run-dialog.tsx'

type Tab = 'failures' | 'runs' | 'queue' | 'agents' | 'activity'
const TABS: Tab[] = ['failures', 'runs', 'queue', 'agents', 'activity']

/**
 * Jenkins for DevOps: what is broken and for how long, what just ran, what is
 * waiting, which agents are down — and who did what about it from here.
 *
 * Failures come first because that is what someone opens this page for. The
 * API sweeps Jenkins at most every 15 seconds however many people watch; the
 * page polls on that rhythm while it is visible. Mounted behind `jenkins.view`;
 * the actions need `jenkins.operate`, which the API checks again.
 */
export function JenkinsPage() {
  const overview = useResource(() => jenkinsApi.overview(), [], { pollMs: 15_000 })
  const audit = useResource(() => jenkinsApi.audit(), [], { pollMs: 30_000 })
  const { can } = useProfile()
  const canOperate = can('jenkins.operate')

  const [params, setParams] = useSearchParams()
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? (params.get('tab') as Tab) : 'failures'
  const showTab = (next: string) =>
    setParams(
      (current) => {
        const copy = new URLSearchParams(current)
        if (next === 'failures') copy.delete('tab')
        else copy.set('tab', next)
        return copy
      },
      { replace: true },
    )

  const [viewing, setViewing] = useState<Pick<Build, 'job' | 'number'> | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const failing = overview.data?.counts.failing ?? 0
  // The count first, so a tab left open says when something breaks.
  usePageTitle(failing > 0 ? `(${failing} failing) Jenkins` : 'Jenkins')

  async function refresh() {
    setRefreshing(true)
    try {
      // Straight past the API's cache; then the resource picks up the result.
      await jenkinsApi.overview(true)
    } catch {
      // The reload below shows the error.
    }
    overview.reload()
    audit.reload()
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
  const reload = () => {
    void refresh()
  }

  return (
    <div className={PAGE}>
      <PageHeader
        title={heading}
        description={
          <>
            {o.counts.jobs} jobs on <span className="font-mono text-sm">{o.url.replace(/^https?:\/\//, '')}</span>, read{' '}
            {since(o.fetchedAt)}.
            {overview.error && <span className="text-destructive"> Could not refresh: {overview.error}</span>}
          </>
        }
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

      <Tiles overview={o} active={tab} onPick={showTab} />

      <Tabs value={tab} onValueChange={showTab} className="mt-6">
        {/* h-auto! because tabs.tsx fixes the list at h-9 with a group selector that out-specifies h-auto, and a wrapped second row would spill out of it on a phone. */}
        <TabsList className="h-auto! max-w-full flex-wrap">
          <TabsTrigger value="failures">
            Failing{o.counts.failing > 0 && <span className="text-muted-foreground tabular-nums">{o.counts.failing}</span>}
          </TabsTrigger>
          <TabsTrigger value="runs">Recent runs</TabsTrigger>
          <TabsTrigger value="queue">
            Queue{o.counts.queued > 0 && <span className="text-muted-foreground tabular-nums">{o.counts.queued}</span>}
          </TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="failures" className="mt-4">
          <FailuresTable failures={o.failures} canOperate={canOperate} onView={setViewing} onAct={setPending} />
        </TabsContent>
        <TabsContent value="runs" className="mt-4">
          <RunsTable runs={o.runs} canOperate={canOperate} onView={setViewing} onAct={setPending} />
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
            <ActivityTable entries={audit.data} onView={setViewing} />
          )}
        </TabsContent>
      </Tabs>

      {/* Acting from the run dialog closes it first: two stacked modals closing
          together (Escape during the confirmation's exit) can leave Radix's
          inert layer behind, and the page stops taking clicks. */}
      <RunDialog
        build={viewing}
        onClose={() => setViewing(null)}
        canOperate={canOperate}
        onAct={(next) => {
          setViewing(null)
          setPending(next)
        }}
      />
      <ActionDialog pending={pending} onClose={() => setPending(null)} onDone={reload} />
    </div>
  )
}

/**
 * The counts, each a way into its tab. Red only for what needs someone:
 * failing jobs, and agents that are down.
 */
function Tiles({ overview: o, active, onPick }: { overview: Overview; active: Tab; onPick: (tab: Tab) => void }) {
  const tiles: { tab: Tab; label: string; n: number; dot: string; alarm: boolean }[] = [
    { tab: 'failures', label: 'Failing jobs', n: o.counts.failing, dot: RESULT.failure.dot, alarm: o.counts.failing > 0 },
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
          <span className={`mt-1 block text-2xl font-semibold tabular-nums ${tile.alarm ? 'text-primary' : ''}`}>{tile.n}</span>
        </button>
      ))}
    </div>
  )
}

type RowProps = { canOperate: boolean; onView: (build: Pick<Build, 'job' | 'number'>) => void; onAct: (pending: Pending) => void }

function FailuresTable({ failures, canOperate, onView, onAct }: RowProps & { failures: Failure[] }) {
  if (failures.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-dashed px-4 py-8 text-sm text-muted-foreground">
        <CircleCheck className="size-4 text-success" /> Every job’s latest build passed.
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
              <TableCell className="max-w-80">
                <button type="button" className="text-left hover:underline" onClick={() => onView(f.last)}>
                  <JobName name={f.job} className="text-sm" />
                </button>
                {(f.running || f.inQueue) && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{f.running ? 'A new build is running' : 'A new build is queued'}</p>
                )}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-2">
                  <ResultBadge result={f.last.result} />
                  <span className="font-mono text-xs text-muted-foreground">#{f.last.number}</span>
                </div>
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <span className="tabular-nums">
                  {f.streak}
                  {f.streakAtLeast && '+'} {f.streak === 1 && !f.streakAtLeast ? 'build' : 'builds'}
                </span>
                <span className="block text-xs text-muted-foreground">since {since(f.since)}</span>
              </TableCell>
              <TableCell className="hidden text-muted-foreground lg:table-cell">
                {f.lastSuccess ? since(f.lastSuccess) : 'Not in recent builds'}
              </TableCell>
              <TableCell className="text-right">
                <RowActions build={f.last} canOperate={canOperate} onView={onView} onAct={onAct} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** View always; run again or stop for those who may. Re-run's own refusals come from the API. */
function RowActions({ build, canOperate, onView, onAct }: RowProps & { build: Build }) {
  return (
    <div className="flex justify-end gap-1.5">
      <Button size="sm" variant="ghost" onClick={() => onView(build)}>
        View
      </Button>
      {canOperate &&
        (build.result === 'running' ? (
          <Button size="sm" variant="outline" onClick={() => onAct({ kind: 'stop', build })} aria-label={`Stop ${build.job} #${build.number}`}>
            <Square /> <span className="hidden sm:inline">Stop</span>
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => onAct({ kind: 'rebuild', build })} aria-label={`Run ${build.job} #${build.number} again`}>
            <RotateCcw /> <span className="hidden sm:inline">Run again</span>
          </Button>
        ))}
    </div>
  )
}

const PAGE_SIZE = 25

function RunsTable({ runs, canOperate, onView, onAct }: RowProps & { runs: Build[] }) {
  const [search, setSearch] = useState('')
  const [result, setResult] = useState<Result | 'all'>('all')
  const [shown, setShown] = useState(PAGE_SIZE)
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return runs.filter((r) => (result === 'all' || r.result === result) && (!needle || r.job.toLowerCase().includes(needle)))
  }, [runs, search, result])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a job" className="pl-8" aria-label="Find a job" />
        </div>
        <Select value={result} onValueChange={(v) => setResult(v as Result | 'all')}>
          <SelectTrigger className="w-40" aria-label="Result">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any result</SelectItem>
            {(Object.keys(RESULT) as Result[]).map((key) => (
              <SelectItem key={key} value={key}>
                {RESULT[key].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead>Result</TableHead>
              <TableHead className="hidden md:table-cell">Started</TableHead>
              <TableHead className="hidden md:table-cell">Took</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                  No runs match.
                </TableCell>
              </TableRow>
            ) : (
              filtered.slice(0, shown).map((r) => (
                <TableRow key={`${r.job}#${r.number}`}>
                  <TableCell className="max-w-80">
                    <button type="button" className="text-left hover:underline" onClick={() => onView(r)}>
                      <JobName name={r.job} className="text-sm" /> <span className="font-mono text-xs text-muted-foreground">#{r.number}</span>
                    </button>
                  </TableCell>
                  <TableCell>
                    <ResultBadge result={r.result} />
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{since(r.startedAt)}</TableCell>
                  <TableCell className="hidden text-muted-foreground tabular-nums md:table-cell">
                    {r.result === 'running' ? '—' : duration(r.durationMs)}
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActions build={r} canOperate={canOperate} onView={onView} onAct={onAct} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {filtered.length > shown && (
        <Button variant="outline" size="sm" onClick={() => setShown((n) => n + PAGE_SIZE)}>
          Show more ({filtered.length - shown} left)
        </Button>
      )}
      <p className="text-xs text-muted-foreground">The latest {runs.length} builds across every job.</p>
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

const ACTION_LABEL: Record<AuditEntry['action'], string> = { rebuild: 'Ran again', stop: 'Stopped', cancel: 'Removed from queue' }

/** Who asked the portal to act in Jenkins — Jenkins itself only sees the service account. */
function ActivityTable({ entries, onView }: { entries: AuditEntry[]; onView: (build: Pick<Build, 'job' | 'number'>) => void }) {
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
                {!e.ok && <p className="max-w-80 text-xs whitespace-normal text-destructive">Refused: {e.error}</p>}
              </TableCell>
              <TableCell className="max-w-80">
                {e.build !== null ? (
                  <button type="button" className="text-left hover:underline" onClick={() => onView({ job: e.job, number: e.build! })}>
                    <JobName name={e.job} className="text-sm" /> <span className="font-mono text-xs text-muted-foreground">#{e.build}</span>
                  </button>
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
