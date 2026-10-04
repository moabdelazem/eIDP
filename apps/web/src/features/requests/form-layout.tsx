import type { FormEvent, ReactNode } from 'react'
import { Link } from 'react-router'
import { CircleCheck, Circle, Info, TriangleAlert } from 'lucide-react'
import { PAGE } from '@/components/page-layout.tsx'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useProfile } from '@/features/auth/profile-context.tsx'
import { DraftedNote } from './drafted-note.tsx'
import { PROVIDERS, type RequestType } from './kinds.ts'
import type { Check } from './api.ts'
import { ProjectPicker } from './project-picker.tsx'

/**
 * The one shape every request form takes, after the form patterns the large
 * design systems agree on (Atlassian, Primer, Carbon, Polaris):
 *
 * - A header that says what this is and where it goes: the provider's mark,
 *   "New request · Azure DevOps", the title and one line on what happens.
 * - The form as a card of **numbered sections** — where, what, who, why — each
 *   titled and explained, so a long form reads as four short ones.
 * - Labels above fields, always visible; help under the field, persistent;
 *   **optional** fields marked, since most are required; a check's answer
 *   in place, under the field it is about, green with a tick or red with why.
 * - One action bar at the foot: Cancel on the left of the primary, the primary
 *   last, and — while it cannot be sent — the first thing still missing, so a
 *   disabled button never leaves anyone guessing.
 * - A sticky **summary** beside it: what is being asked for, a checklist of
 *   what is ready, and what happens after sending.
 */
export function RequestFormPage({
  type,
  lead,
  onSubmit,
  aside,
  children,
}: {
  type: RequestType
  lead: string
  onSubmit: (event: FormEvent) => void
  aside: ReactNode
  children: ReactNode
}) {
  return (
    <div className={PAGE}>
      <FormHeader type={type} lead={lead} />
      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_21rem] xl:gap-8">
        <form onSubmit={onSubmit} noValidate className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="empty:hidden [&>*]:mx-6 [&>*]:mt-6">
            <DraftedNote />
          </div>
          <div className="divide-y">{children}</div>
        </form>
        <aside className="space-y-4 lg:sticky lg:top-6">{aside}</aside>
      </div>
    </div>
  )
}

export function FormHeader({ type, lead }: { type: RequestType; lead: string }) {
  const provider = PROVIDERS.find((p) => p.id === type.provider)!
  const Mark = provider.icon
  return (
    <header className="flex items-start gap-4">
      <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-card shadow-sm" aria-hidden>
        <Mark className="size-6" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">New request · {provider.label}</p>
        <h1 className="mt-0.5 text-2xl font-semibold tracking-tight">{type.title}</h1>
        <p className="mt-1 max-w-2xl text-muted-foreground">{lead}</p>
      </div>
    </header>
  )
}

/** When the provider cannot be reached, the form has nothing to offer: say so, and offer to try again. */
export function Unreachable({ type, lead, message, error, onRetry }: { type: RequestType; lead: string; message: string; error: string; onRetry: () => void }) {
  return (
    <div className={PAGE}>
      <FormHeader type={type} lead={lead} />
      <div className="mt-8 max-w-2xl rounded-xl border bg-card p-6 shadow-sm">
        <p className="flex items-center gap-2 font-medium">
          <TriangleAlert className="size-4 text-warning" aria-hidden /> {message}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  )
}

/** One part of the form: its number and title on the left on a wide screen, above on a narrow one. */
export function FormSection({ step, title, description, children }: { step: number; title: string; description: string; children: ReactNode }) {
  return (
    <section className="grid gap-x-8 gap-y-5 p-6 md:grid-cols-[12rem_minmax(0,1fr)]" aria-labelledby={`section-${step}`}>
      <div className="flex gap-3 md:block">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground tabular-nums md:mb-3">
          {step}
        </span>
        <div>
          <h2 id={`section-${step}`} className="text-sm font-semibold">
            {title}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="min-w-0 space-y-6">{children}</div>
    </section>
  )
}

/** A label above, the field, help beneath; `optional` says so beside the label. */
export function Field({
  label,
  htmlFor,
  hint,
  optional = false,
  children,
}: {
  label: string
  htmlFor: string
  hint?: ReactNode
  optional?: boolean
  children: ReactNode
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor} className="gap-1.5">
        {label}
        {optional && <span className="text-xs font-normal text-muted-foreground">(optional)</span>}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** Where a live check stands: not asked, being asked, or answered. */
export type Verdict = { state: 'idle' } | { state: 'checking' } | { state: 'done'; result: Check }

/** A live check as the form shows it. */
export function checkState(verdict: Verdict, checking: string, ok: string): CheckState {
  if (verdict.state === 'idle') return { state: 'idle' }
  if (verdict.state === 'checking') return { state: 'checking', what: checking }
  return verdict.result.ok ? { state: 'ok', text: ok } : { state: 'error', text: verdict.result.reason }
}

export type CheckState = { state: 'idle' } | { state: 'checking'; what: string } | { state: 'ok'; text: string } | { state: 'error'; text: string }

/** The answer to a live check, under the field it is about: checking, available (green, ticked), or why not (red). */
export function CheckMessage({ id, check }: { id: string; check: CheckState }) {
  if (check.state === 'idle') return <p id={id} className="sr-only" />
  if (check.state === 'checking') {
    return (
      <p id={id} className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> {check.what}
      </p>
    )
  }
  return check.state === 'ok' ? (
    <p id={id} className="flex items-center gap-1.5 text-sm text-success" aria-live="polite">
      <CircleCheck className="size-4 shrink-0" aria-hidden /> {check.text}
    </p>
  ) : (
    <p id={id} className="flex items-start gap-1.5 text-sm text-destructive" role="alert">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {check.text}
    </p>
  )
}

/** Fewer words than this is flagged to the approver as a thin reason (services/request-risk.ts). */
const THIN_REASON = 6

/** Why they need it — with a nudge, before sending, when it is short enough to be flagged to the approver. */
export function ReasonField({ value, onChange, placeholder, hint }: { value: string; onChange: (value: string) => void; placeholder: string; hint: string }) {
  const words = value.trim().split(/\s+/).filter(Boolean).length
  const thin = words > 0 && words < THIN_REASON
  return (
    <Field label="Why do you need it?" htmlFor="justification" hint={hint}>
      <Textarea
        id="justification"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={4}
        required
        aria-describedby="justification-thin"
      />
      <p id="justification-thin" className={thin ? 'flex items-start gap-1.5 text-xs text-warning' : 'sr-only'} aria-live="polite">
        {thin && (
          <>
            <Info className="mt-px size-3.5 shrink-0" aria-hidden /> A reason this short is flagged to whoever approves it.
          </>
        )}
      </p>
    </Field>
  )
}

/** The team that gets access with you: one of your directory groups — chosen when you have several, shown when one. */
export function TeamField({ value, onChange, hint }: { value: string; onChange: (team: string) => void; hint: string }) {
  const { profile, loaded } = useProfile()
  const groups = profile?.groups ?? []
  return (
    <Field label="Your team" htmlFor="team" hint={hint}>
      {loaded && groups.length === 0 ? (
        <p id="team" className="flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          The directory has you in no groups, so there is no team to give access to. Ask for your account to be added to your team’s group, then come back.
        </p>
      ) : groups.length === 1 ? (
        <p id="team" className="flex h-9 items-center rounded-md border bg-muted/40 px-3 font-mono text-sm">
          {groups[0]}
        </p>
      ) : (
        <ProjectPicker id="team" noun="team" projects={groups.map((name) => ({ name, description: null }))} value={value} onChange={onChange} loading={!loaded} />
      )}
    </Field>
  )
}

/** The team, with one group taken as the choice: one option is not a choice. */
export function useTeam(chosen: string): string {
  const { profile } = useProfile()
  const groups = profile?.groups ?? []
  return chosen || (groups.length === 1 ? groups[0]! : '')
}

export type Readiness = { label: string; done: boolean; missing: string }[]

/** The foot of the form: what is still missing, Cancel, and the one primary action, last. */
export function FormActions({ ready, submitting, label = 'Send for approval' }: { ready: Readiness; submitting: boolean; label?: string }) {
  const missing = ready.find((r) => !r.done)
  return (
    <div className="flex flex-col-reverse gap-3 bg-muted/30 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {missing ? missing.missing : 'Ready. Nothing is created until someone in DevOps approves it.'}
      </p>
      <div className="flex shrink-0 gap-2 sm:justify-end">
        <Button asChild variant="ghost">
          <Link to="/requests">Cancel</Link>
        </Button>
        <Button type="submit" disabled={Boolean(missing) || submitting}>
          {submitting && <Spinner />}
          {label}
        </Button>
      </div>
    </div>
  )
}

/**
 * The summary beside the form: what is asked for (`children`), a checklist of
 * what is ready with a bar for how far along, and what happens once it is sent.
 */
export function ReviewPanel({ ready, steps, children }: { ready: Readiness; steps: string[]; children: ReactNode }) {
  const done = ready.filter((r) => r.done).length
  return (
    <>
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="border-b px-5 py-4">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Summary</p>
          <div className="mt-2 space-y-4">{children}</div>
        </div>
        <div className="px-5 py-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Ready to send</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {done} of {ready.length}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={ready.length} aria-valuenow={done} aria-label="How much of the form is done">
            <div className="h-full rounded-full bg-success transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${(done / ready.length) * 100}%` }} />
          </div>
          <ul className="mt-3 space-y-2 text-sm">
            {ready.map((r) => (
              <li key={r.label} className={`flex items-center gap-2 ${r.done ? '' : 'text-muted-foreground'}`}>
                {r.done ? <CircleCheck className="size-4 shrink-0 text-success" aria-label="Done" /> : <Circle className="size-4 shrink-0 text-muted-foreground/50" aria-label="To do" />}
                {r.label}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="rounded-xl border bg-card px-5 py-4 shadow-sm">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">What happens next</p>
        <ol className="mt-3">
          {steps.map((step, i) => (
            <li key={step} className="relative flex gap-3 pb-4 last:pb-0">
              {i < steps.length - 1 && <span className="absolute top-6 bottom-0 left-[11px] w-px bg-border" aria-hidden />}
              <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full border bg-background text-xs font-medium tabular-nums">{i + 1}</span>
              <span className="pt-0.5 text-sm">{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </>
  )
}

/** A labelled value in the summary. */
export function SummaryItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  )
}
