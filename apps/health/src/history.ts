import { config } from './config.ts'
import { query } from './db.ts'

/**
 * What the status page draws, from the samples: per component, each day's
 * worst status, the window's uptime (samples not down, out of samples where
 * it was configured — degraded counts as up, as status pages count it), the
 * last day's response time by hour, and the incidents — runs of samples not
 * ok — of the last two weeks. Components are whatever the samples name, the
 * portal's dependencies and machines alike, so nothing here lists them.
 */

export type Status = 'ok' | 'degraded' | 'down' | 'off'
export type Day = { day: string; samples: number; down: number; degraded: number; worst: Status | 'none' }
export type Incident = { component: string; name: string; status: 'down' | 'degraded'; from: string; to: string | null; summary: string }

export type History = {
  days: number
  dates: string[]
  components: Record<string, { name: string; uptime: number | null; days: Day[]; latency: { at: string; ms: number }[] }>
  incidents: Incident[]
  since: string | null
  sampleMinutes: number
}

const INCIDENT_DAYS = 14

export async function history(days = 90): Promise<History> {
  const span = Math.min(days, config.HEALTH_RETENTION_DAYS)
  const [daily, latency, recent, first, names] = await Promise.all([
    query<{ component: string; day: string; samples: string; down: string; degraded: string; off: string }>(
      `select component, to_char(date_trunc('day', at), 'YYYY-MM-DD') as day, count(*) as samples,
              count(*) filter (where status = 'down') as down,
              count(*) filter (where status = 'degraded') as degraded,
              count(*) filter (where status = 'off') as off
         from health_samples where at >= date_trunc('day', now()) - make_interval(days => $1 - 1)
        group by 1, 2`,
      [span],
    ),
    query<{ component: string; at: Date; ms: number }>(
      `select component, date_trunc('hour', at) as at, round(avg(latency_ms))::int as ms
         from health_samples where at >= now() - interval '24 hours' and status <> 'off' and latency_ms is not null
        group by 1, 2 order by 2`,
    ),
    query<{ component: string; name: string | null; at: Date; status: Status; summary: string }>(
      `select component, name, at, status, summary from health_samples
        where at >= now() - make_interval(days => $1) order by component, at, id`,
      [INCIDENT_DAYS],
    ),
    query<{ at: Date | null }>('select min(at) as at from health_samples'),
    // The newest name each component was sampled under, and machines not yet sampled.
    query<{ component: string; name: string }>(
      `(select distinct on (component) component, coalesce(name, component) as name from health_samples
         where at >= now() - make_interval(days => $1) order by component, at desc)
       union all
       (select 'machine:' || id, name from health_machines)`,
      [span],
    ),
  ])

  const dates: string[] = []
  const today = new Date()
  for (let i = span - 1; i >= 0; i--) dates.push(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i)).toISOString().slice(0, 10))

  const nameOf = new Map<string, string>()
  for (const r of names.rows) nameOf.set(r.component, r.name)

  const components: History['components'] = {}
  for (const [component, name] of nameOf) {
    const rows = new Map(daily.rows.filter((r) => r.component === component).map((r) => [r.day, r]))
    let counted = 0
    let up = 0
    const bars = dates.map((day): Day => {
      const r = rows.get(day)
      if (!r) return { day, samples: 0, down: 0, degraded: 0, worst: 'none' }
      const [samples, down, degraded, off] = [r.samples, r.down, r.degraded, r.off].map(Number) as [number, number, number, number]
      counted += samples - off
      up += samples - off - down
      return { day, samples, down, degraded, worst: down ? 'down' : degraded ? 'degraded' : samples > off ? 'ok' : 'off' }
    })
    components[component] = {
      name,
      uptime: counted ? up / counted : null,
      days: bars,
      latency: latency.rows.filter((r) => r.component === component).map((r) => ({ at: r.at.toISOString(), ms: r.ms })),
    }
  }

  return {
    days: span,
    dates,
    components,
    incidents: incidentsOf(recent.rows.map((r) => ({ ...r, name: r.name ?? nameOf.get(r.component) ?? r.component }))),
    since: first.rows[0]?.at?.toISOString() ?? null,
    sampleMinutes: config.HEALTH_SAMPLE_MINUTES,
  }
}

/** Runs of samples that were not ok, per component, newest first. Off is not an incident. */
export function incidentsOf(rows: { component: string; name: string; at: Date; status: Status; summary: string }[]): Incident[] {
  const incidents: Incident[] = []
  let open: Incident | null = null
  let previous: string | null = null
  for (const row of rows) {
    if (row.component !== previous) {
      if (open) incidents.push(open)
      open = null
      previous = row.component
    }
    if (row.status === 'down' || row.status === 'degraded') {
      if (!open) open = { component: row.component, name: row.name, status: row.status, from: row.at.toISOString(), to: null, summary: row.summary }
      else if (row.status === 'down') open.status = 'down'
    } else if (open) {
      open.to = row.at.toISOString()
      incidents.push(open)
      open = null
    }
  }
  if (open) incidents.push(open)
  return incidents.sort((a, b) => b.from.localeCompare(a.from)).slice(0, 50)
}

export async function prune(): Promise<void> {
  await query(`delete from health_samples where at < now() - make_interval(days => $1)`, [config.HEALTH_RETENTION_DAYS])
}
