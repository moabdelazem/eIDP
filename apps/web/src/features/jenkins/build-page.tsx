import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Copy, ExternalLink, GitCommitHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { JenkinsIcon } from '@/components/brand-icons.tsx'
import { EmptyState } from '@/components/empty-state.tsx'
import { Facts, PAGE, PageHeader, Section, Split } from '@/components/page-layout.tsx'
import { FactsSkeleton, HeaderSkeleton, Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Button } from '@/components/ui/button'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { since } from '@/features/requests/status.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { ActionDialog, type Pending } from './actions.tsx'
import { duration, jenkinsApi, type RunDetail, type Stage } from './api.ts'
import { ExplainPanel } from './explain-panel.tsx'
import { LogViewer } from './log-viewer.tsx'
import { JobName, RESULT, ResultBadge } from './result.tsx'
import { RunAction } from './runs.tsx'

/**
 * One build, for working out what happened: the facts and what started it,
 * its stages with the one that broke, the parameters it ran with, the commits
 * it built, and the log — opened at the first error. A page rather than a
 * dialog, because reading a failed log is the task, not a glance.
 *
 * The job carries folders, so it arrives in the query: `?job=a/b&number=12`.
 */
export function BuildPage() {
  const [params] = useSearchParams()
  const job = params.get('job') ?? ''
  const number = Number(params.get('number'))
  usePageTitle(job ? `${job.split('/').pop()} #${number} — Jenkins` : 'Build — Jenkins')

  const [following, setFollowing] = useState(true)
  const run = useResource(() => jenkinsApi.run(job, number), [job, number], {
    // A running build's log grows; follow it until it ends, then stop asking.
    pollMs: following ? 5_000 : null,
  })
  const r = run.data
  if (r && r.result !== 'running' && following) setFollowing(false)

  const { can } = useProfile()
  const canOperate = can('jenkins.operate')
  const [pending, setPending] = useState<Pending | null>(null)
  // A line the explanation points at, for the log to show.
  const [jump, setJump] = useState<{ line: number; at: number } | null>(null)

  if (!job || !Number.isInteger(number) || number < 1) {
    return (
      <div className={PAGE}>
        <EmptyState title="No build named">Open a build from the Jenkins page.</EmptyState>
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
            <Button asChild size="sm" variant="outline">
              <Link to={`/jenkins?tab=runs&q=${encodeURIComponent(job)}`}>All builds of this job</Link>
            </Button>
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
            <Parameters run={r} />
            <Changes run={r} />
          </>
        }
      >
        <ExplainPanel job={job} number={number} result={r.result} onJump={(line) => setJump({ line, at: Date.now() })} />
        {r.stages.length > 0 && <Stages stages={r.stages} />}
        <LogViewer key={`${job}#${number}`} log={r.log} truncated={r.logTruncated} fullUrl={r.logUrl} jump={jump} />
      </Split>

      <ActionDialog pending={pending} onClose={() => setPending(null)} onDone={run.reload} />
    </div>
  )
}

/**
 * The pipeline as a row of stages, each with its result and time — so "it
 * broke in Test, after Build passed" is one look, not a scroll through the log.
 */
function Stages({ stages }: { stages: Stage[] }) {
  const total = stages.reduce((n, s) => n + s.durationMs, 0) || 1
  return (
    <Section title="Stages" description="In order, each as wide as the time it took.">
      <ol className="flex gap-0.5 overflow-hidden rounded-md" aria-label="Pipeline stages">
        {stages.map((stage) => (
          <li
            key={stage.name}
            className="h-2 min-w-2"
            style={{ flexGrow: Math.max(stage.durationMs / total, 0.04) }}
          >
            <span className={`block h-full ${RESULT[stage.result].dot} ${stage.result === 'not_built' ? 'opacity-40' : ''}`} />
          </li>
        ))}
      </ol>
      <ol className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {stages.map((stage) => {
          const { icon: Icon, label } = RESULT[stage.result]
          return (
            <li key={stage.name} className="flex items-start gap-2 rounded-lg border px-3 py-2">
              <Icon
                className={`mt-0.5 size-4 shrink-0 ${stage.result === 'failure' ? 'text-destructive' : stage.result === 'success' ? 'text-success' : stage.result === 'unstable' ? 'text-warning' : stage.result === 'running' ? 'animate-spin text-info motion-reduce:animate-none' : 'text-muted-foreground'}`}
                aria-hidden
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{stage.name}</p>
                <p className="text-xs text-muted-foreground">
                  {stage.result === 'not_built' ? 'Did not run' : `${label}${stage.durationMs ? ` · ${duration(stage.durationMs)}` : ''}`}
                </p>
              </div>
            </li>
          )
        })}
      </ol>
    </Section>
  )
}

/** What the build ran with; each value searchable across every build, and copyable. */
function Parameters({ run: r }: { run: RunDetail }) {
  if (r.parameters.length === 0) return null
  return (
    <Section title="Parameters" description="Pick a value to find every build that ran with it.">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        {r.parameters.map((p) => (
          <div key={p.name} className="contents">
            <dt className="font-mono text-xs leading-5 text-muted-foreground">{p.name}</dt>
            <dd className="flex min-w-0 items-start gap-1">
              {p.hidden || p.value === null ? (
                <span className="font-mono text-xs leading-5 text-muted-foreground italic">{p.hidden ? 'hidden' : 'not set'}</span>
              ) : (
                <>
                  <Link
                    to={`/jenkins?tab=runs&q=${encodeURIComponent(`${p.name}=${p.value}`)}`}
                    className="min-w-0 font-mono text-xs leading-5 break-words hover:underline"
                    title={`Every build with ${p.name}=${p.value}`}
                  >
                    {p.value}
                  </Link>
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

