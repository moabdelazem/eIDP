import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ExternalLink, RefreshCw, Search, ShieldCheck, UserRound, Users, Workflow, X } from 'lucide-react'
import { JenkinsIcon } from '@/components/brand-icons.tsx'
import { EmptyState } from '@/components/empty-state.tsx'
import { PAGE, PageHeader, Section, Split } from '@/components/page-layout.tsx'
import { HeaderSkeleton, Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ActionDialog, type Pending } from '@/features/jenkins/actions.tsx'
import { buildPath, duration } from '@/features/jenkins/api.ts'
import { JobName, RESULT, ResultBadge } from '@/features/jenkins/result.tsx'
import { since } from '@/features/requests/status.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { isBroken, pipelinesApi, type MyPipelines, type Pipeline, type Reason } from './api.ts'

type Show = 'all' | 'failing' | 'running' | 'waiting' | 'operable'

const TILES: { show: Show; label: string; dot?: string; count: (p: Pipeline) => boolean }[] = [
  { show: 'all', label: 'Pipelines', count: () => true },
  { show: 'failing', label: 'Failing', dot: RESULT.failure.dot, count: isBroken },
  { show: 'running', label: 'Running', dot: RESULT.running.dot, count: (p) => p.running },
  { show: 'waiting', label: 'Waiting', dot: 'bg-warning', count: (p) => p.inQueue },
  { show: 'operable', label: 'You can run', count: (p) => p.canOperate },
]

/**
 * My pipelines: the Jenkins jobs that are yours — your team owns the system,
 * or you started a build — each with how it is doing and, where your role
 * reaches it, Run again and Stop.
 *
 * What you may do is decided per pipeline by the API and only shown here: a
 * Pipeline operator bound to one team acts on that team's pipelines and sees
 * the rest read-only. The filter and the search live in the URL.
 */
export function PipelinesPage() {
  usePageTitle('My pipelines')
  const [params, setParams] = useSearchParams()
  const show = (TILES.some((t) => t.show === params.get('show')) ? params.get('show') : 'all') as Show
  const q = params.get('q') ?? ''

  const [watching, setWatching] = useState(false)
  // While something runs or waits, look again every 15 seconds; otherwise only on Refresh.
  const mine = useResource(() => pipelinesApi.mine(), [], { pollMs: watching ? 15_000 : null })
  const data = mine.data
  const busy = !!data && (data.pipelines.some((p) => p.running) || data.queue.length > 0)
  if (busy !== watching) setWatching(busy)

  const [pending, setPending] = useState<Pending | null>(null)

  const set = (key: 'show' | 'q', value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (!value || (key === 'show' && value === 'all')) next.delete(key)
        else next.set(key, value)
        return next
      },
      { replace: true },
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
      <Loading label="Loading your pipelines…" className={PAGE}>
        <HeaderSkeleton />
        <Split aside={<RowsSkeleton rows={3} />}>
          <RowsSkeleton rows={6} />
        </Split>
      </Loading>
    )
  }
  if (data.pipelines.length === 0) {
    return (
      <div className={PAGE}>
        <EmptyState title="No pipelines of yours yet" icon={Workflow}>
          A Jenkins pipeline shows here when a team you are in owns its system in the inventories, or once you start a build of it.
        </EmptyState>
      </div>
    )
  }

  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const tile = TILES.find((t) => t.show === show)!
  const shown = data.pipelines.filter(
    (p) =>
      tile.count(p) &&
      words.every((w) => [p.job, ...p.owners.flatMap((o) => [o.project, o.system, ...o.applications])].some((text) => text.toLowerCase().includes(w))),
  )

  return (
    <div className={PAGE}>
      <PageHeader
        title="My pipelines"
        description={
          <>
            The Jenkins pipelines your teams own and the ones you have started.
            {data.sync.finishedAt && <> History as of {since(data.sync.finishedAt)}.</>}
          </>
        }
        actions={
          <>
            <Button size="sm" variant="outline" onClick={mine.reload} disabled={mine.loading}>
              <RefreshCw className={mine.loading ? 'animate-spin motion-reduce:animate-none' : ''} /> Refresh
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href={data.url} target="_blank" rel="noreferrer">
                <JenkinsIcon /> Jenkins <ExternalLink />
              </a>
            </Button>
          </>
        }
      />

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {TILES.map(({ show: value, label, dot, count }) => {
          const n = data.pipelines.filter(count).length
          const selected = show === value
          return (
            <button
              key={value}
              type="button"
              aria-pressed={selected}
              onClick={() => set('show', selected ? 'all' : value)}
              className={`rounded-xl border bg-card px-4 py-3 text-left shadow-sm transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none ${
                selected ? 'border-ring ring-1 ring-ring/40' : ''
              }`}
            >
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {dot && <span aria-hidden className={`size-2 rounded-full ${dot}`} />}
                {label}
              </span>
              <span className={`mt-1 block text-2xl font-semibold tabular-nums ${value === 'failing' && n > 0 ? 'text-primary' : ''}`}>{n}</span>
            </button>
          )
        })}
      </div>

      <Split aside={<Aside data={data} onAct={setPending} />} className="mt-6">
        <Section
          flush
          title={show === 'all' ? 'Pipelines' : `${tile.label} pipelines`}
          description="Failing first, then by latest build. Each dot is a build, oldest on the left."
        >
          <div className="border-b px-4 py-3 sm:px-6">
            <div className="relative max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={q}
                onChange={(e) => set('q', e.target.value)}
                placeholder="Find by job, system or application"
                aria-label="Search your pipelines"
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
          {shown.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-muted-foreground">
              No pipeline matches{q ? <> “{q}”</> : null}
              {show !== 'all' && <> among {tile.label.toLowerCase()}</>}.
            </p>
          ) : (
            <ul className="divide-y">
              {shown.map((p) => (
                <PipelineRow key={p.job} pipeline={p} onAct={setPending} />
              ))}
            </ul>
          )}
        </Section>
      </Split>

      <ActionDialog pending={pending} onClose={() => setPending(null)} onDone={mine.reload} />
    </div>
  )
}

/**
 * One pipeline. Laid out by container width, not the screen's, like a
 * request row: the latest build and the action sit beside the name when there
 * is room and drop beneath it when there is not.
 */
function PipelineRow({ pipeline: p, onAct }: { pipeline: Pipeline; onAct: (pending: Pending) => void }) {
  const last = p.last
  const apps = [...new Set(p.owners.flatMap((o) => o.applications))]
  const projects = [...new Set(p.owners.map((o) => o.project))]
  return (
    <li className="@container px-4 py-4 sm:px-6">
      <div className="flex flex-col gap-3 @lg:flex-row @lg:items-start @lg:justify-between">
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm">
            {last ? (
              <Link to={buildPath(last, '/pipelines')} className="hover:underline" title="Open the latest build">
                <JobName name={p.job} />
              </Link>
            ) : (
              <JobName name={p.job} />
            )}
          </p>
          {(projects.length > 0 || apps.length > 0) && (
            <p className="text-xs text-muted-foreground">
              {projects.join(', ')}
              {apps.length > 0 && <> · {apps.join(', ')}</>}
            </p>
          )}
          <Reasons reasons={p.reasons} />
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 @lg:justify-end">
          {last ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ResultBadge result={last.result} />
              <span>
                #{last.number} {since(last.startedAt)}
                {last.result !== 'running' && <> · {duration(last.durationMs)}</>}
              </span>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">No builds in history</span>
          )}
          {p.canOperate && last && (last.result === 'running' ? <ActButton kind="stop" pipeline={p} onAct={onAct} /> : <ActButton kind="rebuild" pipeline={p} onAct={onAct} />)}
          <Button asChild size="icon" variant="ghost" className="size-8">
            <a href={p.url} target="_blank" rel="noreferrer" aria-label={`Open ${p.job} in Jenkins`} title="Open in Jenkins">
              <ExternalLink />
            </a>
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <Dots pipeline={p} />
        <span className="text-xs text-muted-foreground">
          {p.week.builds === 0 ? 'No builds this week' : `${p.week.passed} of ${p.week.builds} passed this week`}
          {p.inQueue && <> · waiting in the queue</>}
        </span>
      </div>
    </li>
  )
}

function ActButton({ kind, pipeline: p, onAct }: { kind: 'rebuild' | 'stop'; pipeline: Pipeline; onAct: (pending: Pending) => void }) {
  const build = { job: p.job, number: p.last!.number }
  return (
    <Button size="sm" variant="outline" onClick={() => onAct({ kind, build })} aria-label={`${kind === 'stop' ? 'Stop' : 'Run again'} ${p.job} #${build.number}`}>
      {kind === 'stop' ? 'Stop' : 'Run again'}
    </Button>
  )
}

/** Why it is on your list, so nobody wonders. */
function Reasons({ reasons }: { reasons: Reason[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Why this is yours">
      {reasons.map((r) => {
        const [Icon, text, title] =
          r.kind === 'team'
            ? [Users, `${r.team} owns it`, `${r.team} owns ${r.project} in the inventories, and you are in ${r.team}`]
            : r.kind === 'scope'
              ? [ShieldCheck, 'You operate it', r.via]
              : [UserRound, `You started ${r.builds} ${r.builds === 1 ? 'build' : 'builds'}`, `Most recently ${since(r.last)}`]
        return (
          <li key={`${r.kind}:${text}`} title={title} className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
            <Icon className="size-3" aria-hidden /> {text}
          </li>
        )
      })}
    </ul>
  )
}

/** The last builds as dots, oldest first, each one a link to its build. */
function Dots({ pipeline: p }: { pipeline: Pipeline }) {
  if (p.recent.length === 0) return null
  return (
    <ol className="flex items-center gap-1" aria-label={`Last ${p.recent.length} builds, oldest first`}>
      {[...p.recent].reverse().map((b) => (
        <li key={b.number}>
          <Link
            to={buildPath({ job: p.job, number: b.number }, '/pipelines')}
            className="block rounded-full p-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            title={`#${b.number} · ${RESULT[b.result].label} · ${since(b.startedAt)}`}
          >
            <span className={`block size-2.5 rounded-full ${RESULT[b.result].dot}`} />
            <span className="sr-only">
              #{b.number} {RESULT[b.result].label}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  )
}

function Aside({ data, onAct }: { data: MyPipelines; onAct: (pending: Pending) => void }) {
  const operable = data.pipelines.filter((p) => p.canOperate).length
  return (
    <>
      <Section title="What you can do here">
        <div className="space-y-2 text-sm text-muted-foreground">
          {operable === 0 ? (
            <>
              <p>You can follow these pipelines and open their builds and logs.</p>
              <p>
                Running a build again or stopping one needs the <span className="text-foreground">Pipeline operator</span> role for the team or project that owns it. DevOps grant it on the Access page.
              </p>
            </>
          ) : operable === data.pipelines.length ? (
            <p>You can run again, stop and dequeue builds of every pipeline here. Each action runs as the portal’s service account, and the portal records that you asked.</p>
          ) : (
            <p>
              You can run again, stop and dequeue builds of {operable} of these {data.pipelines.length} — those your role’s team or project owns. The rest you can follow and read.
            </p>
          )}
        </div>
      </Section>

      <Section title="Waiting in the queue" description={data.queueError ? `Jenkins’ queue could not be read: ${data.queueError}` : undefined}>
        {data.queue.length === 0 ? (
          !data.queueError && <p className="text-sm text-muted-foreground">Nothing of yours is waiting.</p>
        ) : (
          <ul className="space-y-3">
            {data.queue.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <JobName name={item.job ?? item.name} className="text-sm" />
                  <p className="text-xs text-muted-foreground">
                    Since {since(item.since)}
                    {item.why && <> · {item.why}</>}
                  </p>
                </div>
                {item.canOperate && (
                  <Button size="sm" variant="ghost" onClick={() => onAct({ kind: 'cancel', item })} aria-label={`Take ${item.job ?? item.name} out of the queue`}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="You started" description="Your builds in the last seven days.">
        {data.startedByYou.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have not started a build this week.</p>
        ) : (
          <ul className="space-y-2.5">
            {data.startedByYou.map((run) => (
              <li key={`${run.job}#${run.number}`} className="flex items-center gap-2 text-sm">
                <span aria-hidden className={`size-2 shrink-0 rounded-full ${RESULT[run.result].dot}`} />
                <Link to={buildPath(run, '/pipelines')} className="min-w-0 truncate hover:underline">
                  <span className="font-mono text-xs">{lastSegment(run.job)}</span> <span className="text-muted-foreground">#{run.number}</span>
                </Link>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  <span className="sr-only">{RESULT[run.result].label}, </span>
                  {since(run.startedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}

/** A job's own name, without its folders; a branch named `feature%2Fx` reads as people know it. */
function lastSegment(job: string): string {
  const part = job.split('/').pop() ?? job
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}
