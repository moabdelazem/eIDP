import { lazy, Suspense } from 'react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { Section } from '@/components/page-layout.tsx'
import { BarsSkeleton, Loading } from '@/components/skeletons.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { since } from '@/features/requests/status.tsx'
import { useResource } from '@/lib/use-resource.ts'
import { duration, jenkinsApi, percent, WINDOW_LABEL, type Stats, type Totals, type Window } from './api.ts'
import { JobName } from './result.tsx'

// The charts pull in recharts; only this tab needs them. Import nothing else
// from charts.tsx statically, or it rejoins the main bundle.
const ResultsChart = lazy(() => import('./charts.tsx').then((m) => ({ default: m.ResultsChart })))
const SuccessRateChart = lazy(() => import('./charts.tsx').then((m) => ({ default: m.SuccessRateChart })))

/**
 * How the last day or week went: the headline numbers against the window
 * before, builds over time by result, the success rate, and the jobs that
 * failed most and ran longest. The window is the page's one filter, above
 * everything it scopes.
 */
export function Dashboard({ window, version, onJob }: { window: Window; version: number; onJob: (job: string) => void }) {
  const stats = useResource(() => jenkinsApi.stats(window), [window, version], { pollMs: 60_000 })

  if (stats.error && !stats.data) return <p className="text-sm text-destructive">{stats.error}</p>
  if (!stats.data) {
    return (
      <Loading label="Loading the numbers…">
        <BarsSkeleton />
      </Loading>
    )
  }
  const s = stats.data
  // A new window keeps the old numbers on screen, dimmed, until the new ones land.
  const stale = s.window !== window

  return (
    <div className={`space-y-6 transition-opacity ${stale ? 'opacity-60' : ''}`}>
      <Kpis stats={s} />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Section title="Builds by result" description={`${WINDOW_LABEL[s.window]}, ${s.window === '24h' ? 'per hour' : 'per six hours'}.`}>
          <Suspense fallback={<BarsSkeleton />}>
            <ResultsChart buckets={s.timeline} window={s.window} />
          </Suspense>
        </Section>
        <Section title="Success rate" description="Passed out of every build that passed or broke. Gaps are when nothing finished.">
          <Suspense fallback={<BarsSkeleton bars={4} />}>
            <SuccessRateChart buckets={s.timeline} window={s.window} />
          </Suspense>
        </Section>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Section title="Failed most" description="Jobs with the most failed or unstable builds in the window." flush>
          <TopFailing rows={s.topFailing} onJob={onJob} />
        </Section>
        <Section title="Slowest" description="Jobs by their typical build time, with the slow tail beside it." flush>
          <Slowest rows={s.slowest} onJob={onJob} />
        </Section>
      </div>
    </div>
  )
}

function Kpis({ stats: s }: { stats: Stats }) {
  const broken = (t: Totals) => t.failure + t.unstable
  const prior = s.previous.builds > 0
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi
        label="Builds"
        value={s.current.builds.toLocaleString()}
        detail={`${s.current.jobs} jobs · ${s.running} running now`}
        delta={prior ? { change: s.current.builds - s.previous.builds, text: signed(s.current.builds - s.previous.builds), good: null } : null}
      />
      <Kpi
        label="Success rate"
        value={percent(s.current.successRate)}
        detail={`${s.current.success.toLocaleString()} passed`}
        delta={
          prior && s.current.successRate !== null && s.previous.successRate !== null
            ? (() => {
                const points = Math.round((s.current.successRate - s.previous.successRate) * 100)
                return { change: points, text: `${signed(points)} pts`, good: 'up' as const }
              })()
            : null
        }
      />
      <Kpi
        label="Failed or unstable"
        value={broken(s.current).toLocaleString()}
        detail={`${s.current.failure} failed · ${s.current.unstable} unstable`}
        alarm={broken(s.current) > 0}
        delta={prior ? { change: broken(s.current) - broken(s.previous), text: signed(broken(s.current) - broken(s.previous)), good: 'down' } : null}
      />
      <Kpi
        label="Typical build"
        value={s.current.p50Ms === null ? '—' : duration(s.current.p50Ms)}
        detail={s.current.p95Ms === null ? 'No builds finished' : `Slowest 5% over ${duration(s.current.p95Ms)}`}
        delta={
          prior && s.current.p50Ms !== null && s.previous.p50Ms !== null
            ? {
                change: s.current.p50Ms - s.previous.p50Ms,
                text: `${s.current.p50Ms >= s.previous.p50Ms ? '+' : '−'}${duration(Math.abs(s.current.p50Ms - s.previous.p50Ms))}`,
                good: 'down',
              }
            : null
        }
      />
    </div>
  )
}

function signed(n: number): string {
  return n > 0 ? `+${n.toLocaleString()}` : n < 0 ? `−${Math.abs(n).toLocaleString()}` : '0'
}

/**
 * A headline number with how it moved against the window before. The arrow
 * and sign say the direction; the colour says whether that is good — green,
 * or red when it wants a look. A neutral measure (how many builds) stays grey.
 */
function Kpi({
  label,
  value,
  detail,
  delta,
  alarm = false,
}: {
  label: string
  value: string
  detail: string
  delta: { change: number; text: string; good: 'up' | 'down' | null } | null
  alarm?: boolean
}) {
  let tone = 'text-muted-foreground'
  if (delta && delta.change !== 0 && delta.good) {
    const better = delta.good === 'up' ? delta.change > 0 : delta.change < 0
    tone = better ? 'text-success' : 'text-destructive'
  }
  const Icon = !delta || delta.change === 0 ? Minus : delta.change > 0 ? ArrowUpRight : ArrowDownRight
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${alarm ? 'text-primary' : ''}`}>{value}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        {delta && (
          <span className={`inline-flex items-center gap-0.5 font-medium ${tone}`}>
            <Icon className="size-3.5" aria-hidden />
            {delta.text}
            <span className="sr-only"> against the window before</span>
          </span>
        )}
        <span>{detail}</span>
      </p>
    </div>
  )
}

/** A thin bar for a share, in the same row as its number — a table with a sense of size. */
function Meter({ value, tone }: { value: number; tone: string }) {
  return (
    <span className="block h-1.5 w-full min-w-12 overflow-hidden rounded-full bg-muted" aria-hidden>
      <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.max(value * 100, 2)}%` }} />
    </span>
  )
}

function TopFailing({ rows, onJob }: { rows: Stats['topFailing']; onJob: (job: string) => void }) {
  if (rows.length === 0) return <p className="px-6 py-8 text-sm text-muted-foreground">Nothing failed in this window.</p>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-6">Job</TableHead>
          <TableHead className="w-40">Broken</TableHead>
          <TableHead className="hidden pr-6 sm:table-cell">Last</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.job}>
            <TableCell className="max-w-64 pl-6">
              <button type="button" className="text-left hover:underline" onClick={() => onJob(row.job)} title="Show its builds">
                <JobName name={row.job} className="text-sm" />
              </button>
            </TableCell>
            <TableCell>
              <span className="text-sm tabular-nums">
                {row.broken} of {row.builds}
              </span>
              <Meter value={row.rate} tone="bg-destructive" />
            </TableCell>
            <TableCell className="hidden pr-6 text-muted-foreground sm:table-cell">{since(row.lastBroken)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Slowest({ rows, onJob }: { rows: Stats['slowest']; onJob: (job: string) => void }) {
  if (rows.length === 0) return <p className="px-6 py-8 text-sm text-muted-foreground">No builds finished in this window.</p>
  const longest = Math.max(...rows.map((row) => row.p95Ms), 1)
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-6">Job</TableHead>
          <TableHead className="w-40">Typical</TableHead>
          <TableHead className="hidden pr-6 sm:table-cell">Slowest 5%</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.job}>
            <TableCell className="max-w-64 pl-6">
              <button type="button" className="text-left hover:underline" onClick={() => onJob(row.job)} title="Show its builds">
                <JobName name={row.job} className="text-sm" />
              </button>
            </TableCell>
            <TableCell>
              <span className="text-sm tabular-nums">{duration(row.p50Ms)}</span>
              <Meter value={row.p50Ms / longest} tone="bg-[var(--chart-1)]" />
            </TableCell>
            <TableCell className="hidden pr-6 text-muted-foreground tabular-nums sm:table-cell">{duration(row.p95Ms)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

