import { useState } from 'react'
import { Info, RotateCcw, ShieldAlert, ShieldCheck, ShieldX, Sparkles, TriangleAlert, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ApiError } from '@/lib/api-client.ts'
import { requestsApi, type Assessment } from './api.ts'
import { since } from './status.tsx'

/**
 * What an approver should weigh, from modules/requests/risk.ts: facts the
 * portal checked, the level they add up to, and the model's one line.
 *
 * The level wears the meaning colours: green for nothing to weigh, amber for
 * one thing, and red for several — red because that is a request that wants a
 * careful look, which is what red is for here. Always with an icon and a word.
 */
const LEVEL: Record<Assessment['level'], { label: string; icon: LucideIcon; tone: string }> = {
  low: { label: 'Low risk', icon: ShieldCheck, tone: 'border-success/25 bg-success-soft text-success' },
  medium: { label: 'Medium risk', icon: ShieldAlert, tone: 'border-warning/25 bg-warning-soft text-warning' },
  high: { label: 'High risk', icon: ShieldX, tone: 'border-destructive/30 bg-destructive/5 text-destructive' },
}

export function RiskBadge({ level }: { level: Assessment['level'] }) {
  const { label, icon: Icon, tone } = LEVEL[level]
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}>
      <Icon className="size-3.5" />
      {label}
    </span>
  )
}

/** The one line to read on a card: the badge, and the model's summary — or the first caution without it. */
export function RiskLine({ assessment: a, className = '' }: { assessment: Assessment | null | undefined; className?: string }) {
  if (!a) return null
  const line = a.summary ?? a.facts.find((f) => f.level === 'caution')?.text ?? 'Nothing stood out in the checks.'
  return (
    <div className={`flex flex-wrap items-start gap-2 text-sm ${className}`}>
      <RiskBadge level={a.level} />
      <p className="min-w-0 flex-1 text-muted-foreground">{line}</p>
    </div>
  )
}

/** The cautions alone — what the approve dialog repeats, since it is the last look before acting. */
export function Cautions({ assessment: a }: { assessment: Assessment }) {
  const cautions = a.facts.filter((f) => f.level === 'caution')
  if (cautions.length === 0) return null
  return (
    <ul className="space-y-1">
      {cautions.map((f) => (
        <li key={f.text} className="flex items-start gap-1.5">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-label="Caution:" />
          <span>{f.text}</span>
        </li>
      ))}
    </ul>
  )
}

/** The whole assessment, for the request page: summary, every fact, the model's notes on the reason. */
export function RiskPanel({ requestId, assessment, onChange }: { requestId: string; assessment: Assessment | null | undefined; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  async function again() {
    setBusy(true)
    try {
      await requestsApi.assess(requestId)
      onChange()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not assess it. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!assessment) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">Not assessed yet — requests filed before assessments existed, or one still being made.</p>
        <Button size="sm" variant="outline" onClick={() => void again()} disabled={busy}>
          {busy ? <Spinner /> : <Sparkles />} Assess it
        </Button>
      </div>
    )
  }
  const a = assessment
  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-2">
        <RiskBadge level={a.level} />
        {a.summary && <p className="font-medium">{a.summary}</p>}
      </div>

      <ul className="space-y-1.5">
        {a.facts.map((f) => (
          <li key={f.text} className="flex items-start gap-2">
            {f.level === 'caution' ? (
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Caution:" />
            ) : (
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Checked:" />
            )}
            <span className={f.level === 'caution' ? '' : 'text-muted-foreground'}>{f.text}</span>
          </li>
        ))}
      </ul>

      {a.reasonConcerns.length > 0 && (
        <div>
          <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Sparkles className="size-3 text-[var(--chart-1)]" aria-hidden /> On the reason given, {a.model ?? 'the model'} notes
          </p>
          <ul className="list-disc space-y-0.5 pl-5">
            {a.reasonConcerns.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <p className="text-xs text-muted-foreground">
          Checked {since(a.createdAt)}. The level counts the cautions; {a.model ? `${a.model} wrote the words, and can be wrong.` : a.error ? `no summary: ${a.error}` : 'no model was asked.'}
        </p>
        <Button size="sm" variant="ghost" onClick={() => void again()} disabled={busy}>
          {busy ? <Spinner /> : <RotateCcw />} Assess again
        </Button>
      </div>
    </div>
  )
}
