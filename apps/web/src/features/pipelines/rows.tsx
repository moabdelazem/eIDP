import { Link } from 'react-router'
import { ExternalLink, GitCommitHorizontal, KeyRound, Play, ShieldCheck, Sparkles, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Pending } from '@/features/jenkins/actions.tsx'
import { buildPath, duration } from '@/features/jenkins/api.ts'
import { JobName, RESULT, ResultBadge } from '@/features/jenkins/result.tsx'
import { since } from '@/features/requests/status.tsx'
import { RUN_WINDOW_LABEL, type MyPipeline, type MyRun, type Reason, type RunWindow } from './api.ts'

/** A run, and a pipeline summed over its runs — each saying why it is yours and what you may do. */

export function sameRow(p: MyPipeline, r: MyRun): boolean {
  if (p.job !== r.job) return false
  if (p.applications.length === 0) return r.matchedBy !== 'parameters'
  return r.matchedBy === 'parameters' && [...r.applications].sort().join() === [...p.applications].sort().join()
}

/** A job's name, and — for a shared job — the project this run is for. */
function JobAndApp({ job, applications, to }: { job: string; applications: string[]; to: string }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <Link to={to} className="hover:underline">
        <JobName name={job} />
      </Link>
      {applications.map((app) => (
        <span key={app} className="rounded-md border border-ring/30 bg-secondary px-1.5 py-0.5 font-mono text-xs text-secondary-foreground" title="The project this run is for, from its parameters">
          {app}
        </span>
      ))}
    </p>
  )
}

/** One run: what, for whom, why it is yours, and what you may do. */
export function RunRow({ run: r, onAct }: { run: MyRun; onAct: (pending: Pending) => void }) {
  const shared = r.matchedBy === 'parameters'
  const shown = r.parameters.filter((p) => !p.hidden && p.value).slice(0, 4)
  return (
    <li className="@container px-4 py-4 sm:px-6">
      <div className="flex flex-col gap-3 @lg:flex-row @lg:items-start @lg:justify-between">
        <div className="min-w-0 space-y-1.5">
          <JobAndApp job={r.job} applications={shared ? r.applications : []} to={buildPath(r, '/pipelines')} />
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">#{r.number}</span> · {r.causes[0] ?? 'Started'} · {since(r.startedAt)}
            {r.result !== 'running' && <> · took {duration(r.durationMs)}</>}
          </p>
          {shown.length > 0 && (
            <p className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
              {shown.map((p) => (
                <span key={p.name} className="max-w-64 truncate">
                  {p.name}=<span className="text-foreground">{p.value}</span>
                </span>
              ))}
            </p>
          )}
          {r.explanation && (
            <p className="flex items-start gap-1.5 text-sm" title="The AI’s reading of the log — open the run for the lines it rests on">
              <Sparkles className="mt-0.5 size-3.5 shrink-0 text-[var(--chart-1)]" aria-label="AI" />
              {r.explanation.summary}
            </p>
          )}
          <Reasons reasons={r.reasons} />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 @lg:justify-end">
          <ResultBadge result={r.result} />
          {r.canOperate && <Act run={r} onAct={onAct} />}
        </div>
      </div>
    </li>
  )
}

/** One job (one project, on a shared job), over the runs you may see. */
export function PipelineRow({ pipeline: p, window, onAct }: { pipeline: MyPipeline; window: RunWindow; onAct: (pending: Pending) => void }) {
  const last = p.last
  return (
    <li className="@container px-4 py-4 sm:px-6">
      <div className="flex flex-col gap-3 @lg:flex-row @lg:items-start @lg:justify-between">
        <div className="min-w-0 space-y-1.5">
          <JobAndApp job={p.job} applications={p.applications} to={buildPath(last, '/pipelines')} />
          {p.owners.length > 0 && <p className="text-xs text-muted-foreground">{[...new Set(p.owners.map((o) => o.project))].join(', ')}</p>}
          <Reasons reasons={p.reasons} />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 @lg:justify-end">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ResultBadge result={last.result} />
            <span>
              #{last.number} {since(last.startedAt)}
            </span>
          </div>
          {last.canOperate && <Act run={last} onAct={onAct} />}
          <Button asChild size="icon" variant="ghost" className="size-8">
            <a href={p.url} target="_blank" rel="noreferrer" aria-label={`Open ${p.job} in Jenkins`} title="Open in Jenkins">
              <ExternalLink />
            </a>
          </Button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <ol className="flex items-center gap-1" aria-label={`Last ${p.recent.length} runs, oldest first`}>
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
        <span className="text-xs text-muted-foreground">
          {p.finished.builds === 0 ? 'Nothing finished yet' : `${p.finished.passed} of ${p.finished.builds} passed in ${RUN_WINDOW_LABEL[window]}`}
          {p.inQueue && <> · waiting in the queue</>}
        </span>
      </div>
    </li>
  )
}

function Act({ run, onAct }: { run: MyRun; onAct: (pending: Pending) => void }) {
  const stop = run.result === 'running'
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => onAct({ kind: stop ? 'stop' : 'rebuild', build: { job: run.job, number: run.number } })}
      aria-label={`${stop ? 'Stop' : 'Run again'} ${run.job} #${run.number}`}
    >
      {stop ? 'Stop' : 'Run again'}
    </Button>
  )
}

/** Why it is on your list, so nobody wonders. */
function Reasons({ reasons }: { reasons: Reason[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Why this is yours">
      {reasons.map((r) => {
        const [Icon, text, title] =
          r.kind === 'started'
            ? [Play, 'You started it', 'Jenkins records you as who started it']
            : r.kind === 'commit'
              ? [GitCommitHorizontal, r.by ? `Your commit · run by ${r.by}` : 'Your commit', 'It built a commit you wrote']
              : r.kind === 'team'
                ? [Users, `${possessive(r.team)} project`, `For ${r.project}, which ${r.team} owns in the inventories — and you are in ${r.team}`]
                : r.kind === 'jenkins'
                  ? r.group
                    ? [KeyRound, `${r.sid} sees it in Jenkins`, `Jenkins lets ${r.sid} read this job (${r.via}), and you are in ${r.sid}`]
                    : [KeyRound, 'Jenkins lets you see it', `Jenkins grants you by name (${r.via})`]
                  : [ShieldCheck, 'You operate it', r.via]
        return (
          <li key={`${r.kind}:${text}`} title={title} className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
            <Icon className="size-3" aria-hidden /> {text}
          </li>
        )
      })}
    </ul>
  )
}


function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}’` : `${name}’s`
}
