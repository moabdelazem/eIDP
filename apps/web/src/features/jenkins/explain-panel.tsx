import { useEffect, useState } from 'react'
import { RotateCcw, Sparkles, TriangleAlert } from 'lucide-react'
import { Section } from '@/components/page-layout.tsx'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { since } from '@/features/requests/status.tsx'
import { ApiError } from '@/lib/api-client.ts'
import { useResource } from '@/lib/use-resource.ts'
import { CATEGORY, jenkinsApi, type Explanation, type Result } from './api.ts'


/**
 * "What went wrong?" on a failed build: the model on our own Ollama reads the
 * failed stage, the parameters and the errors in the log, and says what it
 * thinks happened — each claim tied to log lines you can jump to.
 *
 * Each job's latest failure is explained automatically after the sync that
 * finds it (modules/jenkins/auto-explain.ts), so the answer is usually waiting; while
 * it is on its way the panel says so and looks again. Anything else — an
 * older failure, one the automatic run could not do — is a click. Once made,
 * an answer is kept for everyone. It says it is generated, by which model, for whom and when,
 * because an explanation is only as good as the reader's check of it.
 *
 * Shows to anyone who may see the build — the Jenkins page and My pipelines
 * alike, `ai.chat` being everyone's — on a failed or unstable build, when
 * Ollama is configured.
 */
export function ExplainPanel({
  job,
  number,
  result,
  onJump,
}: {
  job: string
  number: number
  result: Result
  onJump: (line: number) => void
}) {
  const { can } = useProfile()
  const allowed = can('ai.chat') && (result === 'failure' || result === 'unstable')
  // While an explanation is on its way without anyone asking, look again every few seconds.
  const [waiting, setWaiting] = useState(false)
  const kept = useResource(['jenkins', 'explanation', allowed, job, number], () => (allowed ? jenkinsApi.explanation(job, number) : Promise.resolve(null)), {
    pollMs: waiting ? 5_000 : null,
  })
  const queued = !kept.data?.explanation && kept.data?.auto.state === 'queued'
  if (queued !== waiting) setWaiting(queued)

  const [answer, setAnswer] = useState<Explanation | null>(null)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shown = answer ?? kept.data?.explanation ?? null

  async function ask(fresh: boolean) {
    setAsking(true)
    setError(null)
    try {
      setAnswer(await jenkinsApi.explain(job, number, fresh))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The explanation did not come back. Try again.')
    } finally {
      setAsking(false)
    }
  }

  if (!allowed || !kept.data?.ai.configured) return null
  const model = kept.data.ai.model ?? 'the model'

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="size-4 text-[var(--chart-1)]" aria-hidden />
          What went wrong
        </span>
      }
      description={shown ? undefined : `${model} on our own Ollama reads the failed stage, the parameters and the errors in the log, and says what it thinks happened. Secrets are removed before it reads anything.`}
      action={
        shown && !asking ? (
          <Button size="sm" variant="ghost" onClick={() => void ask(true)} title="Ask the model again, replacing this answer">
            <RotateCcw /> Ask again
          </Button>
        ) : undefined
      }
    >
      {asking ? (
        <Asking model={model} />
      ) : shown ? (
        <Answer explanation={shown} onJump={onJump} />
      ) : queued ? (
        <div aria-live="polite">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" /> {model} is explaining this failure on its own — the answer appears here when it is ready.
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void ask(false)}>
            Explain now
          </Button>
        </div>
      ) : (
        <>
          {kept.data?.auto.state === 'failed' && (
            <p className="mb-3 text-sm text-muted-foreground">
              The automatic explanation did not work{kept.data.auto.error ? `: ${kept.data.auto.error}` : '.'}
            </p>
          )}
          <Button onClick={() => void ask(false)}>
            <Sparkles /> Explain this failure
          </Button>
        </>
      )}
      {error && (
        <p className="mt-3 flex items-start gap-1.5 text-sm text-destructive" role="alert">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {error}
        </p>
      )}
    </Section>
  )
}

/** While the model reads: what it is doing and for how long, so a slow answer does not look stuck. */
function Asking({ model }: { model: string }) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div aria-live="polite">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" /> {model} is reading the log… <span className="tabular-nums">{seconds}s</span>
      </p>
      {seconds >= 10 && <p className="mt-1 text-xs text-muted-foreground">A first answer can take up to a minute. Once made, it is kept for everyone.</p>}
      <div className="mt-4 space-y-2" aria-hidden>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  )
}

function Answer({ explanation: e, onJump }: { explanation: Explanation; onJump: (line: number) => void }) {
  return (
    <div className="space-y-4 text-sm">
      <div>
        <p className="text-base font-medium">{e.summary}</p>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border bg-muted/40 px-2 py-0.5">{CATEGORY[e.category]}</span>
          {e.confidence === 'low' ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-warning/25 bg-warning-soft px-2 py-0.5 text-warning">
              <TriangleAlert className="size-3" /> Unsure — the log does not show it clearly
            </span>
          ) : (
            <span className="text-muted-foreground">{e.confidence === 'high' ? 'Clear from the log' : 'Likely, from the log'}</span>
          )}
        </p>
      </div>

      <p className="leading-relaxed">{e.cause}</p>

      {e.evidence.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">Where the log shows it</p>
          <ul className="space-y-1">
            {e.evidence.map((line) => (
              <li key={line.line}>
                <button
                  type="button"
                  onClick={() => onJump(line.line)}
                  className="flex w-full items-baseline gap-3 rounded-md border bg-muted/30 px-2.5 py-1.5 text-left font-mono text-xs hover:border-ring hover:bg-muted/60"
                  title="Show this line in the log"
                >
                  <span className="shrink-0 text-muted-foreground tabular-nums">{line.line}</span>
                  <span className="min-w-0 break-words">{line.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {e.nextSteps.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">Try next</p>
          <ol className="list-decimal space-y-1 pl-5">
            {e.nextSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      )}

      <p className="border-t pt-3 text-xs text-muted-foreground">
        Generated by {e.model} {e.automatic ? 'automatically when the build failed' : `for ${e.createdByName}`}, {since(e.createdAt)}
        {e.durationMs > 0 && ` in ${Math.max(1, Math.round(e.durationMs / 1000))}s`}. It can be wrong — check it against the log.
        {e.trimmed && ' The log was too long to read whole; it read the errors and the end.'}
      </p>
    </div>
  )
}
