import { lazy, Suspense, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { Copy, ExternalLink, GitCommitHorizontal, List, Maximize2, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { JenkinsIcon } from '@/components/brand-icons.tsx'
import { EmptyState } from '@/components/empty-state.tsx'
import { Facts, PAGE, PageHeader, Section, Split } from '@/components/page-layout.tsx'
import { FactsSkeleton, HeaderSkeleton, Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { LogViewer } from '@/components/log-viewer/log-viewer.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { since } from '@/features/requests/status.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { ActionDialog, type Pending } from './actions.tsx'
import { duration, jenkinsApi, type RunDetail, type Stage } from './api.ts'
import { ExplainPanel } from './explain-panel.tsx'
import { JobName, RESULT, ResultBadge } from './result.tsx'
import { RunAction } from './runs.tsx'

// React Flow is the graph's canvas — ~50 KB that only a build page needs, so it loads with the graph.
const StageGraph = lazy(() => import('./stage-graph.tsx').then((m) => ({ default: m.StageGraph })))

/**
 * One build, for working out what happened: the facts and what started it,
 * its stages with the one that broke, the parameters it ran with, the commits
 * it built, and the log — opened at the first error. A page rather than a
 * dialog, because reading a failed log is the task, not a glance.
 *
 * The job carries folders, so it arrives in the query: `?job=a/b&number=12`.
 *
 * It is also how My pipelines opens a build (`/pipelines/build`), for people
 * who cannot see the Jenkins page: the API lets them read a build only of
 * their own pipelines, and says per build whether they may act on it. Links
 * into the Jenkins page's search show only to those who can open it.
 */
export function BuildPage() {
  const [params] = useSearchParams()
  const job = params.get('job') ?? ''
  const number = Number(params.get('number'))
  const fromPipelines = useLocation().pathname.startsWith('/pipelines')
  usePageTitle(job ? `${job.split('/').pop()} #${number} — ${fromPipelines ? 'My pipelines' : 'Jenkins'}` : 'Build — Jenkins')

  const [following, setFollowing] = useState(true)
  const run = useResource(['jenkins', 'run', job, number], () => jenkinsApi.run(job, number), {
    // A running build's log grows; follow it until it ends, then stop asking.
    pollMs: following ? 3_000 : null,
  })
  const r = run.data
  if (r && r.result !== 'running' && following) setFollowing(false)

  const { can } = useProfile()
  const canOperate = r?.canOperate ?? false
  const canSearch = can('jenkins.view')
  const [pending, setPending] = useState<Pending | null>(null)
  // A line the explanation points at, for the log to show.
  const [jump, setJump] = useState<{ line: number; at: number } | null>(null)

  if (!job || !Number.isInteger(number) || number < 1) {
    return (
      <div className={PAGE}>
        <EmptyState title="No build named">Open a build from {fromPipelines ? 'My pipelines' : 'the Jenkins page'}.</EmptyState>
      </div>
    )
  }
  if (run.error && !r) {
    return (
      <div className={PAGE}>
        <EmptyState title="This build can’t be shown" action={<Button variant="outline" onClick={run.reload}>Try again</Button>}>
          {run.error}
        </EmptyState>
      </div>
    )
  }
  if (!r) {
    return (
      <Loading label="Loading the build…" className={PAGE}>
        <HeaderSkeleton />
        <Split aside={<FactsSkeleton className="" />}>
          <RowsSkeleton rows={8} />
        </Split>
      </Loading>
    )
  }

  return (
    <div className={PAGE}>
      <PageHeader
        title={
          <h1 className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-lg font-semibold tracking-tight">
            <JobName name={job} /> <span className="font-mono text-muted-foreground">#{number}</span>
            <ResultBadge result={r.result} />
          </h1>
        }
        description={
          <>
            {r.result === 'running' ? 'Started' : 'Ran'} {since(r.startedAt)}
            {r.result !== 'running' && <>, took {duration(r.durationMs)}</>}
            {r.builtOn && (
              <>
                {' '}
                on <span className="font-mono text-sm">{r.builtOn}</span>
              </>
            )}
            .
          </>
        }
        actions={
          <>
            {canSearch ? (
              <Button asChild size="sm" variant="outline">
                <Link to={`/jenkins?tab=runs&q=${encodeURIComponent(job)}`}>All builds of this job</Link>
              </Button>
            ) : (
              <Button asChild size="sm" variant="outline">
                <Link to={`/pipelines?q=${encodeURIComponent(job)}`}>My pipelines</Link>
              </Button>
            )}
            <Button asChild size="sm" variant="outline">
              <a href={r.url} target="_blank" rel="noreferrer">
                <JenkinsIcon /> Open in Jenkins <ExternalLink />
              </a>
            </Button>
            {canOperate && (r.result === 'running' || r.notReplayable === null) && <RunAction run={r} onAct={setPending} />}
          </>
        }
      />

      <Split
        aside={
          <>
            <Section title="Details">
              <Facts
                empty="—"
                items={[
                  ['Result', <span className="inline-flex items-center gap-1.5">{RESULT[r.result].label}</span>],
                  ['Started', new Date(r.startedAt).toLocaleString()],
                  ['Took', r.result === 'running' ? 'Still running' : duration(r.durationMs)],
                  ['Agent', r.builtOn ? <code>{r.builtOn}</code> : null],
                  ['Started by', r.causes.join('; ') || null],
                ]}
              />
              {canOperate && r.notReplayable && r.result !== 'running' && (
                <p className="mt-4 text-sm text-muted-foreground">{r.notReplayable}</p>
              )}
            </Section>
            <Parameters run={r} searchable={canSearch} />
            <Changes run={r} />
          </>
        }
      >
        <ExplainPanel job={job} number={number} result={r.result} onJump={(line) => setJump({ line, at: Date.now() })} />
        {r.stages.length > 0 && <Stages run={r} onJump={(line) => setJump({ line, at: Date.now() })} />}
        <LogViewer
          key={`${job}#${number}`}
          log={r.log}
          truncated={r.logTruncated}
          fullUrl={r.logUrl}
          jump={jump}
          live={r.result === 'running'}
          linkable
          title={`${job} #${number}`}
          fileName={`${job.replaceAll('/', '-')}-${number}`}
        />
      </Split>

      <ActionDialog pending={pending} onClose={() => setPending(null)} onDone={run.reload} />
    </div>
  )
}

/** The line (as the log viewer numbers it) where a stage's heading is — a branch's own, else its parallel stage's. */
function headingLine(log: string, stage: Stage, parent: Stage | null): number | null {
  const lines = log.split('\n')
  for (const name of parent ? [`Branch: ${stage.name}`, parent.name] : [stage.name]) {
    const i = lines.indexOf(`[Pipeline] { (${name})`)
    if (i >= 0) return i + 1
  }
  return null
}

/**
 * The pipeline: as a graph — stages left to right, parallel branches stacked,
 * the way Jenkins' Pipeline Graph View draws it — or as a list, the plain and
 * screen-reader-friendly path to the same stages. A stage opens the log at
 * its heading. The choice is kept per browser.
 */
function Stages({ run: r, onJump }: { run: RunDetail; onJump: (line: number) => void }) {
  const [view, setView] = useState<'graph' | 'list'>(() => {
    // Phones open on the list, as the map does: a graph needs width a phone does not have.
    const fallback = window.matchMedia('(max-width: 639px)').matches ? 'list' : 'graph'
    try {
      const kept = localStorage.getItem('eidp.stages-view')
      return kept === 'list' || kept === 'graph' ? kept : fallback
    } catch {
      return fallback
    }
  })
  const choose = (next: string) => {
    if (next !== 'graph' && next !== 'list') return
    setView(next)
    try {
      localStorage.setItem('eidp.stages-view', next)
    } catch {
      // Private window: the choice lasts this page.
    }
  }
  const open = (stage: Stage, parent: Stage | null) => {
    const line = headingLine(r.log, stage, parent)
    return line === null ? null : () => onJump(line)
  }
  const parallel = r.stages.some((s) => s.branches.length > 0)
  return (
    <Section
      title="Stages"
      description={
        r.stagesFrom === 'graph'
          ? `From Pipeline Graph View${parallel ? ', parallel branches stacked' : ''}. Pick a stage to read its log.`
          : 'From Stage View, which does not say what ran in parallel. Pick a stage to read its log.'
      }
      action={
        <div className="flex shrink-0 items-center gap-2">
          <ToggleGroup type="single" variant="outline" size="sm" value={view} onValueChange={choose} aria-label="Show stages as">
            <ToggleGroupItem value="graph" className="px-2.5" aria-label="Graph">
              <Workflow /> <span className="hidden sm:inline">Graph</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="list" className="px-2.5" aria-label="List">
              <List /> <span className="hidden sm:inline">List</span>
            </ToggleGroupItem>
          </ToggleGroup>
          <StagesDialog run={r} open={open} />
        </div>
      }
    >
      {view === 'graph' ? (
        <Suspense fallback={<Skeleton className="h-56 w-full rounded-lg" />}>
          <StageGraph stages={r.stages} onOpen={open} />
        </Suspense>
      ) : (
        <StageList stages={r.stages} open={open} />
      )}
    </Section>
  )
}

/**
 * The graph with room: a dialog nearly the width of the screen, each stage
 * with its agent and start, and a line saying how the run went. A glance
 * without leaving the page, so a dialog; picking a stage closes it and opens
 * the log there, without focus jumping back to the button and scrolling the
 * page away from the log.
 */
function StagesDialog({
  run: r,
  open,
}: {
  run: RunDetail
  open: (stage: Stage, parent: Stage | null) => (() => void) | null
}) {
  const [shown, setShown] = useState(false)
  const jumping = useRef(false)
  const openAndClose = (stage: Stage, parent: Stage | null) => {
    const go = open(stage, parent)
    if (!go) return null
    return () => {
      jumping.current = true
      setShown(false)
      go()
    }
  }
  const all = r.stages.flatMap((s) => (s.branches.length ? s.branches.map((b) => ({ s: b, parent: s })) : [{ s, parent: null as Stage | null }]))
  const broke = all.find(({ s }) => s.result === 'failure' || s.result === 'unstable')
  const branches = r.stages.reduce((n, s) => n + s.branches.length, 0)
  const summary = [
    `${r.stages.length} ${r.stages.length === 1 ? 'stage' : 'stages'}`,
    branches > 0 && `${branches} parallel branches`,
    broke ? `broke in ${broke.parent ? `${broke.parent.name} › ` : ''}${broke.s.name}` : r.result === 'running' ? 'still running' : null,
    r.result !== 'running' && `took ${duration(r.durationMs)}`,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <Dialog open={shown} onOpenChange={setShown}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="px-2.5" aria-label="Open the stages large">
          <Maximize2 /> <span className="hidden sm:inline">Expand</span>
        </Button>
      </DialogTrigger>
      <DialogContent
        className="grid max-h-[90vh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-[min(1400px,calc(100vw-4rem))]"
        onCloseAutoFocus={(event) => {
          if (jumping.current) {
            event.preventDefault()
            jumping.current = false
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <JobName name={r.job} /> <span className="font-mono text-muted-foreground">#{r.number}</span>
            <ResultBadge result={r.result} />
          </DialogTitle>
          <DialogDescription>{summary}. Pick a stage to read its log.</DialogDescription>
        </DialogHeader>
        <div className="h-[70vh] min-h-0 overflow-hidden rounded-lg border bg-muted/30">
          <Suspense fallback={<Skeleton className="size-full" />}>
            <StageGraph stages={r.stages} onOpen={openAndClose} size="large" />
          </Suspense>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Each stage with its result and time, a parallel stage's branches beneath it. */
function StageList({ stages, open }: { stages: Stage[]; open: (stage: Stage, parent: Stage | null) => (() => void) | null }) {
  const total = stages.reduce((n, s) => n + s.durationMs, 0) || 1
  const item = (stage: Stage, parent: Stage | null) => {
    const { icon: Icon, label } = RESULT[stage.result]
    const go = open(stage, parent)
    const text = (
      <>
        <Icon
          className={`mt-0.5 size-4 shrink-0 ${stage.result === 'failure' ? 'text-destructive' : stage.result === 'success' ? 'text-success' : stage.result === 'unstable' ? 'text-warning' : stage.result === 'running' ? 'animate-spin text-info motion-reduce:animate-none' : 'text-muted-foreground'}`}
          aria-hidden
        />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{stage.name}</span>
          <span className="block text-xs text-muted-foreground">
            {stage.result === 'not_built' ? 'Did not run' : `${label}${stage.durationMs ? ` · ${duration(stage.durationMs)}` : ''}`}
            {stage.branches.length > 0 && ` · ${stage.branches.length} in parallel`}
          </span>
        </span>
      </>
    )
    return go ? (
      <button type="button" onClick={go} className="flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-secondary">
        {text}
      </button>
    ) : (
      <div className="flex items-start gap-2 rounded-lg border px-3 py-2">{text}</div>
    )
  }
  return (
    <>
      <ol className="flex gap-0.5 overflow-hidden rounded-md" aria-hidden>
        {stages.map((stage) => (
          <li key={stage.name} className="h-2 min-w-2" style={{ flexGrow: Math.max(stage.durationMs / total, 0.04) }}>
            <span className={`block h-full ${RESULT[stage.result].dot} ${stage.result === 'not_built' ? 'opacity-40' : ''}`} />
          </li>
        ))}
      </ol>
      <ol className="mt-4 space-y-2" aria-label="Pipeline stages">
        {stages.map((stage) => (
          <li key={stage.name}>
            {item(stage, null)}
            {stage.branches.length > 0 && (
              <ol className="mt-2 ml-4 space-y-2 border-l pl-3" aria-label={`${stage.name}, in parallel`}>
                {stage.branches.map((branch) => (
                  <li key={branch.name}>{item(branch, stage)}</li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ol>
    </>
  )
}

/** What the build ran with; each value searchable across every build, and copyable. */
function Parameters({ run: r, searchable }: { run: RunDetail; searchable: boolean }) {
  if (r.parameters.length === 0) return null
  return (
    <Section title="Parameters" description={searchable ? 'Pick a value to find every build that ran with it.' : undefined}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        {r.parameters.map((p) => (
          <div key={p.name} className="contents">
            <dt className="font-mono text-xs leading-5 text-muted-foreground">{p.name}</dt>
            <dd className="flex min-w-0 items-start gap-1">
              {p.hidden || p.value === null ? (
                <span className="font-mono text-xs leading-5 text-muted-foreground italic">{p.hidden ? 'hidden' : 'not set'}</span>
              ) : (
                <>
                  {searchable ? (
                    <Link
                      to={`/jenkins?tab=runs&q=${encodeURIComponent(`${p.name}=${p.value}`)}`}
                      className="min-w-0 font-mono text-xs leading-5 break-words hover:underline"
                      title={`Every build with ${p.name}=${p.value}`}
                    >
                      {p.value}
                    </Link>
                  ) : (
                    <span className="min-w-0 font-mono text-xs leading-5 break-words">{p.value}</span>
                  )}
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                    aria-label={`Copy ${p.name}`}
                    onClick={() => navigator.clipboard.writeText(p.value!).then(() => toast.success(`${p.name} copied`))}
                  >
                    <Copy className="size-3" />
                  </button>
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  )
}

function Changes({ run: r }: { run: RunDetail }) {
  return (
    <Section title="Changes" description={r.changes.length ? undefined : 'No new commits since the build before.'}>
      {r.changes.length > 0 && (
        <ul className="space-y-3">
          {r.changes.map((change, i) => (
            <li key={change.commit ?? i} className="flex gap-2 text-sm">
              <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <p className="break-words">{change.message || 'No message'}</p>
                <p className="text-xs text-muted-foreground">
                  {change.author ?? 'Unknown author'}
                  {change.commit && (
                    <>
                      {' · '}
                      <code>{change.commit.slice(0, 8)}</code>
                    </>
                  )}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

