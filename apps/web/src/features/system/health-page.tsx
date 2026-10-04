import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, CircleMinus, CircleX, HeartPulse, RefreshCw, type LucideIcon } from 'lucide-react'
import { EmptyState } from '@/components/empty-state.tsx'
import { PAGE, PageHeader, Section } from '@/components/page-layout.tsx'
import { CardSkeleton, HeaderSkeleton, Loading } from '@/components/skeletons.tsx'
import { Button } from '@/components/ui/button'
import { since } from '@/features/requests/status.tsx'
import { usePageTitle } from '@/lib/use-page-title.ts'
import { useResource } from '@/lib/use-resource.ts'
import { systemApi, type Component, type Group, type Health, type Status } from './api.ts'
import { useSystemHealth } from './health-context.tsx'
import { ComponentIcon } from './icons.tsx'

/**
 * Is a status's word, icon and tone — the meaning colours, each with an icon
 * and a word so colour never carries it alone. Red only for down: that is
 * the one that wants someone now.
 */
const STATUS: Record<Status, { label: string; icon: LucideIcon; badge: string; text: string }> = {
  ok: { label: 'Working', icon: CircleCheck, badge: 'border-success/25 bg-success-soft text-success', text: 'text-success' },
  degraded: { label: 'Needs attention', icon: CircleAlert, badge: 'border-warning/25 bg-warning-soft text-warning', text: 'text-warning' },
  down: { label: 'Down', icon: CircleX, badge: 'border-destructive/30 bg-destructive/5 text-destructive', text: 'text-destructive' },
  off: { label: 'Not configured', icon: CircleMinus, badge: 'text-muted-foreground', text: 'text-muted-foreground' },
}

const GROUPS: { group: Group; title: string; description: string }[] = [
  { group: 'core', title: 'Core', description: 'What the portal cannot work without — and where its secrets come from.' },
  { group: 'integration', title: 'Integrations', description: 'Each powers some pages; one down leaves the rest working.' },
  { group: 'background', title: 'Background jobs', description: 'Judged by when each last succeeded against how often it should run.' },
]

/**
 * Everything the portal depends on, each asked now: Postgres, the directory,
 * Vault, Azure DevOps, Jira, Jenkins, Ollama, and the syncs that keep its
 * copies current. Each card says what is true, what to do when it is not,
 * and what in the portal depends on it. Looks again every 30 seconds — the
 * API shares one answer per 15 — and Check again asks everything now.
 */
export function SystemHealthPage() {
  const health = useResource(() => systemApi.health(), [], { pollMs: 30_000 })
  const [checking, setChecking] = useState(false)
  const [fresh, setFresh] = useState<Health | null>(null)
  // The newer of a fresh check and the polled answer.
  const h = fresh && (!health.data || fresh.checkedAt > health.data.checkedAt) ? fresh : health.data
  // The sidebar's alert and badge follow what this page shows, not a minute behind it.
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
      // The polled answer, and its error, take over.
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
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </Loading>
    )
  }

  return (
    <div className={PAGE}>
      <PageHeader
        title="System health"
        description={<>Everything the portal depends on, checked {since(h.checkedAt)}.</>}
        actions={
          <Button size="sm" variant="outline" onClick={() => void checkAgain()} disabled={checking}>
            <RefreshCw className={checking ? 'animate-spin motion-reduce:animate-none' : ''} /> Check again
          </Button>
        }
      />

      <Overall health={h} />

      {GROUPS.map(({ group, title, description }) => (
        <section key={group} className="mt-8" aria-labelledby={`health-${group}`}>
          <h2 id={`health-${group}`} className="text-sm font-medium">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          <div className="mt-3 grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
            {h.components
              .filter((c) => c.group === group)
              .map((c) => (
                <ComponentCard key={c.id} component={c} />
              ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/** The verdict first, then how many of each — so a glance is enough when all is well. */
function Overall({ health: h }: { health: Health }) {
  const count = (s: Status) => h.components.filter((c) => c.status === s).length
  const down = h.components.filter((c) => c.status === 'down')
  const attention = h.components.filter((c) => c.status === 'degraded')
  const tone: Status = h.status === 'ok' ? 'ok' : h.status === 'down' ? 'down' : 'degraded'
  const { icon: Icon, text } = STATUS[tone]
  const headline =
    h.status === 'down'
      ? `The portal is down: ${down.filter((c) => c.group === 'core').map((c) => c.name).join(' and ')} not answering.`
      : h.status === 'degraded'
        ? `${down.length + attention.length} of ${h.components.length} need attention: ${[...down, ...attention].map((c) => c.name).join(', ')}.`
        : 'Everything the portal depends on is working.'
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card px-5 py-4 shadow-sm" role="status">
      <p className="flex items-center gap-3 text-base font-medium">
        <Icon className={`size-6 shrink-0 ${text}`} aria-hidden />
        {headline}
      </p>
      <ul className="flex flex-wrap gap-2 text-xs">
        {(['ok', 'degraded', 'down', 'off'] as const)
          .filter((s) => count(s) > 0)
          .map((s) => {
            const { icon: StatusIcon, label, badge } = STATUS[s]
            return (
              <li key={s} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-medium ${badge}`}>
                <StatusIcon className="size-3.5" aria-hidden /> {count(s)} {label.toLowerCase()}
              </li>
            )
          })}
      </ul>
    </div>
  )
}

function ComponentCard({ component: c }: { component: Component }) {
  const { icon: Icon, label, badge } = STATUS[c.status]
  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <ComponentIcon id={c.id} className="size-4 text-muted-foreground" />
          {c.name}
        </span>
      }
      action={
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge}`}>
          <Icon className="size-3.5" aria-hidden /> {label}
        </span>
      }
    >
      <div className="space-y-4 text-sm">
        <p className={c.status === 'ok' || c.status === 'off' ? 'text-muted-foreground' : ''}>{c.summary}</p>
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
        <p className="border-t pt-3 text-xs text-muted-foreground">
          <span className="text-foreground">Used for:</span> {c.uses}
          {c.latencyMs !== null && c.status !== 'off' && <> · answered in {c.latencyMs} ms</>}
        </p>
      </div>
    </Section>
  )
}
