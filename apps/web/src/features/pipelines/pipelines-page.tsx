import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { ExternalLink, RefreshCw, Search, UserRound, Users, Workflow, X } from 'lucide-react'
import { JenkinsIcon } from '@/components/brand-icons.tsx'
import { EmptyState } from '@/components/empty-state.tsx'
import { PAGE, PageHeader, Section, Split } from '@/components/page-layout.tsx'
import { HeaderSkeleton, Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ActionDialog, type Pending } from '@/features/jenkins/actions.tsx'
import { RESULT } from '@/features/jenkins/result.tsx'
import { since } from '@/features/requests/status.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { groupsOf, isBroken, isPersonal, pipelinesApi, RUN_WINDOW_LABEL, type MyRun, type Reason, type RunWindow } from './api.ts'
import { Aside } from './aside.tsx'
import { failingOf, FailingNow } from './failing-now.tsx'
import { PipelineRow, RunRow, sameRow } from './rows.tsx'

type Show = 'all' | 'failed' | 'running' | 'operable'
type View = 'runs' | 'pipelines'

const TILES: { show: Show; label: string; dot?: string; count: (r: MyRun) => boolean }[] = [
  { show: 'all', label: 'Runs', count: () => true },
  { show: 'failed', label: 'Failed', dot: RESULT.failure.dot, count: (r) => isBroken(r.result) },
  { show: 'running', label: 'Running', dot: RESULT.running.dot, count: (r) => r.result === 'running' },
  { show: 'operable', label: 'You can run', count: (r) => r.canOperate },
]

/**
 * My pipelines: the runs that are yours — you started them, or they built a
 * commit you pushed (maika starts those) — and your teams' projects' runs,
 * including the ones that go through a shared build or deploy job, which are
 * told apart by their parameters. Never every run of a shared job.
 *
 * Runs, newest first, or Pipelines: one row per job — and per project, for a
 * shared job — summed over the runs you may see. What you may do is decided
 * per run by the API and only shown here. Window, view, whose, filter and
 * search all live in the URL.
 *
 * Above them, what is failing now and why (`FailingNow`): the AI's reading of
 * each broken pipeline's latest failure, what to try, and a way into the
 * build page or the chatbot.
 */
export function PipelinesPage() {
  usePageTitle('My pipelines')
  const [params, setParams] = useSearchParams()
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T) => (allowed.includes(params.get(key) as T) ? (params.get(key) as T) : fallback)
  const window = pick<RunWindow>('window', ['24h', '7d', '30d'], '7d')
  const view = pick<View>('view', ['runs', 'pipelines'], 'runs')
  const show = pick<Show>('show', ['all', 'failed', 'running', 'operable'], 'all')
  const q = params.get('q') ?? ''
  /** A group's name, `me` for just yours, or empty for everything. */
  const group = params.get('group') ?? ''

  const [watching, setWatching] = useState(false)
  // While something runs or waits, look again every 15 seconds; otherwise only on Refresh.
  const mine = useResource(['pipelines', 'mine', window], () => pipelinesApi.mine(window), { pollMs: watching ? 15_000 : null })
  const data = mine.data
  const busy = !!data && (data.runs.some((r) => r.result === 'running') || data.queue.length > 0)
  if (busy !== watching) setWatching(busy)

  const [pending, setPending] = useState<Pending | null>(null)

  const set = (key: 'show' | 'q' | 'group' | 'view' | 'window', value: string, fallback = '') =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (!value || value === fallback) next.delete(key)
        else next.set(key, value)
        return next
      },
      { replace: true },
    )

  const header = (
    <PageHeader
      title="My pipelines"
      description={
        <>
          Runs you started or pushed, and your teams’ projects’ runs — on shared build and deploy jobs, only those for your projects.
          {data?.sync.finishedAt && <> History as of {since(data.sync.finishedAt)}.</>}
        </>
      }
      actions={
        <>
          <ToggleGroup type="single" variant="outline" size="sm" value={window} onValueChange={(value) => value && set('window', value, '7d')} aria-label="Time window">
            {(Object.keys(RUN_WINDOW_LABEL) as RunWindow[]).map((w) => (
              <ToggleGroupItem key={w} value={w} className="px-3" aria-label={`Last ${RUN_WINDOW_LABEL[w]}`}>
                {RUN_WINDOW_LABEL[w]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button size="sm" variant="outline" onClick={mine.reload} disabled={mine.loading}>
            <RefreshCw className={mine.loading ? 'animate-spin motion-reduce:animate-none' : ''} /> Refresh
          </Button>
          {data && (
            <Button asChild size="sm" variant="outline">
              <a href={data.url} target="_blank" rel="noreferrer">
                <JenkinsIcon /> Jenkins <ExternalLink />
              </a>
            </Button>
          )}
        </>
      }
    />
  )

  if (mine.error && !data) {
    return (
      <div className={PAGE}>
        <EmptyState title="Your pipelines can’t be shown" icon={Workflow} action={<Button variant="outline" onClick={mine.reload}>Try again</Button>}>
          {mine.error}
        </EmptyState>
      </div>
    )
  }
  if (!data) {
    return (
      <Loading label="Loading your runs…" className={PAGE}>
        <HeaderSkeleton />
        <Split aside={<RowsSkeleton rows={3} />}>
          <RowsSkeleton rows={6} />
        </Split>
      </Loading>
    )
  }
  if (data.runs.length === 0 && data.queue.length === 0) {
    return (
      <div className={PAGE}>
        {header}
        <div className="mt-6">
          <EmptyState title={`No runs of yours in the last ${RUN_WINDOW_LABEL[window]}`} icon={Workflow}>
            A run shows here when you start it, when it builds a commit you pushed, or when it is for a project a team of yours owns.
            {window !== '30d' && ' A longer window may find older ones.'}
          </EmptyState>
        </div>
      </div>
    )
  }

  const groups = groupCounts(data.runs)
  const inGroup = (item: { reasons: Reason[] }) =>
    !group || (group === 'me' ? isPersonal(item) : groupsOf(item).some((g) => g.toLowerCase() === group.toLowerCase()))
  const scoped = data.runs.filter(inGroup)
  const tile = TILES.find((t) => t.show === show)!
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = (texts: string[]) => words.every((w) => texts.some((text) => text.toLowerCase().includes(w)))
  const runs = scoped.filter(
    (r) => tile.count(r) && matches([r.job, ...r.applications, ...r.owners.map((o) => o.project), ...r.causes, ...r.parameters.map((p) => p.value ?? ''), `#${r.number}`]),
  )
  // A pipeline is shown when one of the runs the filters leave is in it.
  const kept = new Set(runs.map((r) => `${r.job}#${r.number}`))
  const pipelines = data.pipelines.filter((p) => inGroup(p) && data.runs.some((r) => kept.has(`${r.job}#${r.number}`) && sameRow(p, r)))
  const groupLabel = group === 'me' ? ' — just yours' : group ? ` — ${groups.find((g) => g.name.toLowerCase() === group.toLowerCase())?.name ?? group}` : ''

  return (
    <div className={PAGE}>
      {header}

      {groups.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-2" role="group" aria-label="Whose runs">
          <span className="mr-1 text-xs text-muted-foreground">Whose</span>
          {[
            { value: '', label: 'Everything', n: data.runs.length, icon: null },
            ...groups.map(({ name, n }) => ({ value: name, label: name, n, icon: Users })),
            { value: 'me', label: 'Just you', n: data.runs.filter(isPersonal).length, icon: UserRound },
          ].map(({ value, label, n, icon: Icon }) => {
            const selected = group.toLowerCase() === value.toLowerCase()
            return (
              <button
                key={value || 'all'}
                type="button"
                aria-pressed={selected}
                onClick={() => set('group', selected ? '' : value)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none ${
                  selected ? 'border-ring bg-secondary text-secondary-foreground' : 'bg-card'
                }`}
              >
                {Icon && <Icon className="size-3.5 text-muted-foreground" aria-hidden />}
                {label}
                <span className="text-xs text-muted-foreground tabular-nums">{n}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {TILES.map(({ show: value, label, dot, count }) => {
          const n = scoped.filter(count).length
          const selected = show === value
          return (
            <button
              key={value}
              type="button"
              aria-pressed={selected}
              onClick={() => set('show', selected ? 'all' : value, 'all')}
              className={`rounded-xl border bg-card px-4 py-3 text-left shadow-sm transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none ${
                selected ? 'border-ring ring-1 ring-ring/40' : ''
              }`}
            >
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {dot && <span aria-hidden className={`size-2 rounded-full ${dot}`} />}
                {label}
              </span>
              <span className={`mt-1 block text-2xl font-semibold tabular-nums ${value === 'failed' && n > 0 ? 'text-primary' : ''}`}>{n}</span>
            </button>
          )
        })}
      </div>

      {data.ai?.configured && (
        <div className="mt-6">
          <FailingNow
            failing={failingOf(data.pipelines.filter(inGroup), data.runs)}
            model={data.ai.model ?? 'The model'}
            onShowAll={() =>
              setParams(
                (prev) => {
                  // One update: two `set`s in a row would each start from the same params.
                  const next = new URLSearchParams(prev)
                  next.set('show', 'failed')
                  next.delete('view')
                  return next
                },
                { replace: true },
              )
            }
          />
        </div>
      )}

      <Split aside={<Aside data={data} onAct={setPending} />} className="mt-6">
        <Section
          flush
          title={`${view === 'runs' ? (show === 'all' ? 'Runs' : `${tile.label} runs`) : 'Pipelines'}${groupLabel}`}
          description={
            view === 'runs'
              ? `Newest first, over the last ${RUN_WINDOW_LABEL[window]}.`
              : 'One row per job — per project on a shared job — over the runs you see. Failing first; each dot is a run, oldest on the left.'
          }
          action={
            <Tabs value={view} onValueChange={(next) => set('view', next, 'runs')}>
              <TabsList>
                <TabsTrigger value="runs">Runs</TabsTrigger>
                <TabsTrigger value="pipelines">Pipelines</TabsTrigger>
              </TabsList>
            </Tabs>
          }
        >
          <div className="border-b px-4 py-3 sm:px-6">
            <div className="relative max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={q}
                onChange={(e) => set('q', e.target.value)}
                placeholder="Job, app, parameter or #number"
                aria-label="Search your runs"
                className="h-8 pr-8 pl-8"
              />
              {q && (
                <button
                  type="button"
                  onClick={() => set('q', '')}
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </div>
          {(view === 'runs' ? runs.length : pipelines.length) === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-muted-foreground">
              Nothing matches{q ? <> “{q}”</> : null}
              {show !== 'all' && <> among {tile.label.toLowerCase()} runs</>}.
            </p>
          ) : view === 'runs' ? (
            <ul className="divide-y">
              {runs.map((r) => (
                <RunRow key={`${r.job}#${r.number}`} run={r} onAct={setPending} />
              ))}
            </ul>
          ) : (
            <ul className="divide-y">
              {pipelines.map((p) => (
                <PipelineRow key={p.key} pipeline={p} window={window} onAct={setPending} />
              ))}
            </ul>
          )}
          {data.truncated && view === 'runs' && (
            <p className="border-t px-6 py-3 text-xs text-muted-foreground">Only the newest 500 runs are listed. A shorter window or a search narrows them.</p>
          )}
        </Section>
      </Split>

      <ActionDialog pending={pending} onClose={() => setPending(null)} onDone={mine.reload} />
    </div>
  )
}

/** Whether a run is one of a pipeline row's: same job, and same project on a shared job. */

function groupCounts(runs: MyRun[]): { name: string; n: number }[] {
  const counts = new Map<string, { name: string; n: number }>()
  for (const r of runs) {
    for (const name of groupsOf(r)) {
      const entry = counts.get(name.toLowerCase()) ?? { name, n: 0 }
      entry.n++
      counts.set(name.toLowerCase(), entry)
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
}
