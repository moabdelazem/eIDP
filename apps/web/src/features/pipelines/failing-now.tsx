import { useState } from 'react'
import { Link } from 'react-router'
import { ArrowRight, Bot, Sparkles, TriangleAlert } from 'lucide-react'
import { Section } from '@/components/page-layout.tsx'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { CATEGORY, buildPath, jenkinsApi } from '@/features/jenkins/api.ts'
import { JobName, ResultBadge } from '@/features/jenkins/result.tsx'
import { since } from '@/features/requests/status.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { askChatbot } from '@/lib/ask-chatbot.ts'
import { isBroken, type Brief, type MyPipeline, type MyRun } from './api.ts'

/** A pipeline whose latest finished run broke, with that run and how many in a row did. */
export type Failing = { pipeline: MyPipeline; run: MyRun; streak: number }

const SHOWN = 3

/** The pipelines among `pipelines` that are broken now: their latest finished run failed. */
export function failingOf(pipelines: MyPipeline[], runs: MyRun[]): Failing[] {
  const finished = (b: { result: MyRun['result'] }) => b.result !== 'running' && b.result !== 'not_built'
  return pipelines.flatMap((pipeline) => {
    const done = pipeline.recent.filter(finished)
    const latest = done[0]
    if (!latest || !isBroken(latest.result)) return []
    const run = runs.find((r) => r.job === pipeline.job && r.number === latest.number)
    if (!run) return []
    const streak = done.findIndex((b) => !isBroken(b.result))
    return [{ pipeline, run, streak: streak === -1 ? done.length : streak }]
  })
}

/**
 * What is broken now and why: each pipeline whose latest run failed, with the
 * AI's reading of its log — what happened and what to try — so the first
 * thing someone sees on My pipelines is what to do, not a list to dig
 * through. Most failures are explained automatically when the sync finds
 * them; one that is not yet is a click. "See why" opens the build page with
 * the lines it rests on, and "Ask the chatbot" carries on in conversation.
 *
 * Shown only when the portal's AI is set up; the API leaves `ai` null for
 * anyone who may not use it.
 */
export function FailingNow({ failing, model, onShowAll }: { failing: Failing[]; model: string; onShowAll: () => void }) {
  const [expanded, setExpanded] = useState(false)
  if (failing.length === 0) return null
  const shown = expanded ? failing : failing.slice(0, SHOWN)
  return (
    <Section
      flush
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="size-4 text-[var(--chart-1)]" aria-hidden />
          Failing now — what went wrong
        </span>
      }
      description={`${model} on our own Ollama read each failure’s log and says what it thinks happened and what to try. It can be wrong — the build page shows the lines it rests on.`}
    >
      <ul className="divide-y">
        {shown.map((f) => (
          <FailingRow key={f.pipeline.key} failing={f} />
        ))}
      </ul>
      <div className="flex flex-wrap gap-2 border-t px-4 py-2.5 sm:px-6">
        {failing.length > SHOWN && (
          <Button size="sm" variant="ghost" onClick={() => setExpanded((e) => !e)}>
            {expanded ? 'Show fewer' : `Show ${failing.length - SHOWN} more failing`}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onShowAll}>
          Every failed run
        </Button>
      </div>
    </Section>
  )
}

function FailingRow({ failing: { pipeline: p, run, streak } }: { failing: Failing }) {
  const [brief, setBrief] = useState<Brief | null>(run.explanation)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const to = buildPath(run, '/pipelines')

  async function explain() {
    setAsking(true)
    setError(null)
    try {
      setBrief(await jenkinsApi.explain(run.job, run.number, false))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The explanation did not come back. Try again.')
    } finally {
      setAsking(false)
    }
  }

  const name = p.applications.length ? `${p.applications.join(', ')} on ${run.job}` : run.job
  return (
    <li className="@container px-4 py-4 sm:px-6">
      <div className="flex flex-col gap-3 @2xl:flex-row @2xl:items-start @2xl:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ResultBadge result={run.result} />
            <Link to={to} className="text-sm hover:underline">
              <JobName name={run.job} />
            </Link>
            {p.applications.map((app) => (
              <span key={app} className="rounded-md border border-ring/30 bg-secondary px-1.5 py-0.5 font-mono text-xs text-secondary-foreground">
                {app}
              </span>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">#{run.number}</span> · {since(run.startedAt)}
            {streak > 1 && <> · {streak} failed in a row</>}
          </p>

          {asking ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
              <Spinner className="size-4" /> Reading the log — a first answer can take up to a minute…
            </p>
          ) : brief ? (
            <div className="reveal space-y-2">
              <p className="text-sm font-medium">{brief.summary}</p>
              <p className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full border bg-muted/40 px-2 py-0.5">{CATEGORY[brief.category]}</span>
                {brief.confidence === 'low' && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-warning/25 bg-warning-soft px-2 py-0.5 text-warning">
                    <TriangleAlert className="size-3" aria-hidden /> Unsure
                  </span>
                )}
              </p>
              {brief.nextSteps.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground">Try next</p>
                  <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm">
                    {brief.nextSteps.slice(0, 3).map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Not explained yet.</p>
          )}
          {error && (
            <p className="flex items-start gap-1.5 text-sm text-destructive" role="alert">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2 @2xl:flex-col @2xl:items-stretch">
          {!brief && !asking && (
            <Button size="sm" onClick={() => void explain()}>
              <Sparkles /> Explain this failure
            </Button>
          )}
          <Button asChild size="sm" variant="outline">
            <Link to={to} aria-label={`See why ${run.job} #${run.number} failed`}>
              {brief ? 'See why' : 'Open the log'} <ArrowRight />
            </Link>
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => askChatbot(`Why did ${run.job} #${run.number} fail${p.applications.length ? ` (for ${p.applications.join(', ')})` : ''}, and what should I do to fix it?`)}
            aria-label={`Ask the chatbot about ${name} #${run.number}`}
          >
            <Bot /> Ask the chatbot
          </Button>
        </div>
      </div>
    </li>
  )
}
