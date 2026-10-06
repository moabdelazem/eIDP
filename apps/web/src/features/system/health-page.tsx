import { useEffect, useState } from 'react'
import { ChevronRight, HeartPulse, RefreshCw } from 'lucide-react'
import { EmptyState } from '@/components/empty-state.tsx'
import { PAGE, PageHeader } from '@/components/page-layout.tsx'
import { HeaderSkeleton, Loading, RowsSkeleton } from '@/components/skeletons.tsx'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { since } from '@/features/requests/status.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { systemApi, type Component, type Group, type Health, type History, type Incident, type Status } from './api.ts'
import { useSystemHealth } from './health-context.tsx'
import { ComponentIcon } from './icons.tsx'
import { AlertsSection, MachinesSection } from './machines.tsx'
import { formatDay, STATUS, UptimeBar } from './parts.tsx'

const GROUPS: { group: Group; title: string }[] = [
  { group: 'core', title: 'Core' },
  { group: 'integration', title: 'Integrations' },
  { group: 'background', title: 'Background jobs' },
]

/**
 * The portal's status page, laid out the way public availability pages are:
 * one verdict across the top, then every component with its state now and a
 * bar per day of its last 90 — the worst it was that day — with its uptime,
 * and past incidents below, worked out from samples taken every few minutes.
 * A row opens to say what it checked, what depends on it, and how fast it has
 * answered today. Looks again every 30 seconds; Check again asks everything
 * now and tells the sidebar.
 *
 * "Now" is the portal's own check; the bars, incidents, machines and alerts
 * are the health service's (apps/health), which samples on its own — when it
 * is not there, the page still answers "now" and says what is missing.
 */
export function SystemHealthPage() {
  const health = useResource(() => systemApi.health(), [], { pollMs: 30_000 })
  const history = useResource(() => systemApi.history(90), [], { pollMs: 5 * 60_000 })
  // History, machines and alerts are the health service's; the page says so when it is not there.
  const machines = useResource(() => systemApi.machines(), [], { pollMs: 60_000 })
  const alerts = useResource(() => systemApi.alerts(), [], { pollMs: 60_000 })
  const serviceError = history.error ?? machines.error
  const [checking, setChecking] = useState(false)
  const [fresh, setFresh] = useState<Health | null>(null)
  // The newer of a fresh check and the polled answer.
  const h = fresh && (!health.data || fresh.checkedAt > health.data.checkedAt) ? fresh : health.data
  const { publish } = useSystemHealth()
  useEffect(() => {
    if (h) publish(h)
  }, [h, publish])

  const problems = h?.components.filter((c) => c.status === 'down' || c.status === 'degraded').length ?? 0
  usePageTitle(problems > 0 ? `(${problems}) System health` : 'System health')

  async function checkAgain() {
    setChecking(true)
    try {
      setFresh(await systemApi.health(true))
    } catch {
      health.reload()
    } finally {
      setChecking(false)
    }
  }

  if (health.error && !h) {
    return (
      <div className={PAGE}>
        <EmptyState title="Health can’t be read" icon={HeartPulse} action={<Button variant="outline" onClick={health.reload}>Try again</Button>}>
          {health.error}
        </EmptyState>
      </div>
    )
  }
  if (!h) {
    return (
      <Loading label="Checking every system…" className={PAGE}>
        <HeaderSkeleton />
        <div className="mt-6 h-24 rounded-xl border" />
        <div className="mt-6">
          <RowsSkeleton rows={6} />
        </div>
      </Loading>
    )
  }

  return (
    <div className={PAGE}>
      <PageHeader title="System health" description="Everything the portal depends on and the machines we run — how they are now, and how they have been." />

      <Verdict health={h} checking={checking} onCheck={() => void checkAgain()} />

      {serviceError && !history.data && (
        <p className="mt-6 rounded-xl border border-warning/30 bg-warning-soft px-5 py-3 text-sm text-warning" role="status">
          History, machines and alerts come from the health service. {serviceError}
        </p>
      )}

      <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Uptime over the past {history.data?.days ?? 90} days
          {history.data?.since && <> · recorded since {new Date(history.data.since).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</>}
        </p>
        <Legend />
      </div>

      <div className="mt-3 space-y-6">
        {GROUPS.map(({ group, title }) => (
          <section key={group} aria-labelledby={`health-${group}`} className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <h2 id={`health-${group}`} className="border-b bg-muted/30 px-5 py-3 text-sm font-semibold">
              {title}
            </h2>
            <ul className="divide-y">
              {h.components
                .filter((c) => c.group === group)
                .map((c) => (
                  <ComponentRow key={c.id} component={c} history={history.data} />
                ))}
            </ul>
          </section>
        ))}
      </div>

      <MachinesSection
        machines={machines.data}
        history={history.data}
        error={machines.error}
        onChanged={() => {
          machines.reload()
          history.reload()
          alerts.reload()
        }}
      />

      <AlertsSection data={alerts.data} error={alerts.error} />

      <Incidents history={history.data} />
    </div>
  )
}

/** The one line people come for, in the colour of its worst part — red only when something is down. */
function Verdict({ health: h, checking, onCheck }: { health: Health; checking: boolean; onCheck: () => void }) {
  const down = h.components.filter((c) => c.status === 'down')
  const degraded = h.components.filter((c) => c.status === 'degraded')
  const tone: Status = down.length ? 'down' : degraded.length ? 'degraded' : 'ok'
  const title =
    h.status === 'down' ? 'Major outage' : down.length ? 'Partial outage' : degraded.length ? 'Some systems are degraded' : 'All systems operational'
  const names = [...down, ...degraded].map((c) => c.name).join(', ')
  const surface = { ok: 'border-success/30 bg-success-soft', degraded: 'border-warning/30 bg-warning-soft', down: 'border-destructive/30 bg-destructive/5', off: '' }[tone]
  const { icon: Icon, text } = STATUS[tone]
  return (
    <div className={`mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border px-6 py-5 ${surface}`} role="status">
      <div className="flex min-w-0 items-center gap-4">
        <Icon className={`size-9 shrink-0 ${text}`} aria-hidden />
        <div className="min-w-0">
          <p className={`text-xl font-semibold tracking-tight ${text}`}>{title}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {names ? `${names} · ` : ''}Checked {since(h.checkedAt)}
          </p>
        </div>
      </div>
      <Button size="sm" variant="outline" className="bg-card" onClick={onCheck} disabled={checking}>
        <RefreshCw className={checking ? 'animate-spin motion-reduce:animate-none' : ''} /> Check again
      </Button>
    </div>
  )
}

function Legend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="What the bars mean">
      {(['ok', 'degraded', 'down'] as const).map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <span aria-hidden className={`h-3 w-1.5 rounded-[2px] ${STATUS[s].bar}`} />
          {STATUS[s].label}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="h-3 w-1.5 rounded-[2px] border border-muted-foreground/30 bg-muted" />
        No data
      </li>
    </ul>
  )
}

/**
 * One component: its mark, name and state now; the days below; and, opened,
 * what it checked. The whole head is the trigger, so a row is one target.
 * A component that is down opens by itself.
 */
function ComponentRow({ component: c, history }: { component: Component; history: History | undefined }) {
  const [open, setOpen] = useState(c.status === 'down')
  const { icon: Icon, label, text } = STATUS[c.status]
  const past = history?.components[c.id]
  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex w-full items-center gap-3 px-5 pt-4 pb-3 text-left hover:bg-muted/30 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
          <ChevronRight
            className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
          <ComponentIcon id={c.id} className="size-5 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
          <span className={`flex shrink-0 items-center gap-1.5 text-sm font-medium ${text}`}>
            <Icon className="size-4" aria-hidden /> {label}
          </span>
        </CollapsibleTrigger>

        <div className="px-5 pb-4">
          {past ? <UptimeBar days={past.days} uptime={past.uptime} off={c.status === 'off'} /> : <div className="h-8 rounded bg-muted/50" />}
        </div>

        <CollapsibleContent className="border-t bg-muted/20 px-5 py-4">
          <Details component={c} latency={past?.latency ?? []} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

function Details({ component: c, latency }: { component: Component; latency: { at: string; ms: number }[] }) {
  return (
    <div className="grid gap-5 text-sm md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-3">
        <p>{c.summary}</p>
        {c.facts.length > 0 && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
            {c.facts.map((f) => (
              <div key={f.label} className="contents">
                <dt className="text-muted-foreground">{f.label}</dt>
                <dd className="min-w-0 font-mono break-words">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="text-xs text-muted-foreground">
          <span className="text-foreground">Used for:</span> {c.uses}
        </p>
      </div>
      {c.status !== 'off' && <Latency points={latency} now={c.latencyMs} />}
    </div>
  )
}

/**
 * How fast it answered, hour by hour today — a sparkline in the one chart hue,
 * with the numbers beside it, because a line without a scale is a mood.
 */
function Latency({ points, now }: { points: { at: string; ms: number }[]; now: number | null }) {
  const values = points.map((p) => p.ms)
  const max = Math.max(...values, 1)
  const average = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null
  const W = 240
  const H = 48
  const path = points
    .map((p, i) => `${i ? 'L' : 'M'}${points.length === 1 ? W / 2 : (i / (points.length - 1)) * W},${H - 4 - (p.ms / max) * (H - 8)}`)
    .join(' ')
  return (
    <div>
      <p className="text-xs text-muted-foreground">Response time, last 24 hours</p>
      <div className="mt-2 flex items-end gap-4">
        {points.length > 1 ? (
          <svg viewBox={`0 0 ${W} ${H}`} className="h-12 w-full max-w-60" role="img" aria-label={`Average ${average} ms over ${points.length} hours`}>
            <line x1="0" y1={H - 4} x2={W} y2={H - 4} stroke="var(--border)" />
            <path d={path} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinejoin="round" />
          </svg>
        ) : (
          <p className="flex-1 text-xs text-muted-foreground">A line appears after two hours of checks.</p>
        )}
        <dl className="shrink-0 text-xs tabular-nums">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Now</dt>
            <dd>{now === null ? '—' : `${now} ms`}</dd>
          </div>
          {average !== null && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Average</dt>
              <dd>{average} ms</dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  )
}

/**
 * Past incidents, a day at a time for the last week — "No incidents" said
 * outright, as availability pages do, so a quiet day reads as quiet rather
 * than missing. An incident is a run of checks that were not operational.
 */
function Incidents({ history }: { history: History | undefined }) {
  if (!history) return null
  const days: string[] = []
  for (let i = 0; i < 7; i++) days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10))
  const byDay = new Map<string, Incident[]>()
  for (const incident of history.incidents) {
    const day = incident.from.slice(0, 10)
    byDay.set(day, [...(byDay.get(day) ?? []), incident])
  }
  return (
    <section className="mt-10" aria-labelledby="past-incidents">
      <h2 id="past-incidents" className="text-lg font-semibold tracking-tight">
        Past incidents
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        From checks every {history.sampleMinutes} minutes: a run of checks that were not operational, until the next one that was.
      </p>
      <ol className="mt-4 space-y-6">
        {days.map((day) => {
          const list = byDay.get(day) ?? []
          return (
            <li key={day}>
              <h3 className="border-b pb-2 text-sm font-semibold">{formatDay(day)}</h3>
              {list.length === 0 ? (
                <p className="pt-3 text-sm text-muted-foreground">No incidents reported.</p>
              ) : (
                <ul className="divide-y">
                  {list.map((incident) => (
                    <IncidentRow key={`${incident.component}-${incident.from}`} incident={incident} />
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function IncidentRow({ incident: i }: { incident: Incident }) {
  const { icon: Icon, label, text } = STATUS[i.status]
  const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const minutes = Math.max(1, Math.round(((i.to ? Date.parse(i.to) : Date.now()) - Date.parse(i.from)) / 60_000))
  const lasted = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-1 py-3">
      <ComponentIcon id={i.component} className="mt-0.5 size-4 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {i.name}
          <span className={`inline-flex items-center gap-1 text-sm ${text}`}>
            <Icon className="size-3.5" aria-hidden /> {label}
          </span>
          {i.to === null && (
            <span className="rounded-full border border-warning/30 bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">Ongoing</span>
          )}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">{i.summary}</p>
      </div>
      <p className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {time(i.from)} – {i.to ? time(i.to) : 'now'} · {lasted}
      </p>
    </li>
  )
}
