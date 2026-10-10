import { monitorEventLoopDelay } from 'node:perf_hooks'

/**
 * Prometheus metrics, in its text format, without a client library: a few
 * counters and histograms are not worth a dependency. Served on their own port
 * (`METRICS_PORT`, server.ts) so the Gateway never routes to them.
 *
 * Labels are kept to bounded sets — a route's pattern, never its path — or a
 * series per build number would grow without end.
 */

type Labels = Record<string, string>

const key = (labels: Labels) => JSON.stringify(Object.entries(labels).sort())
const render = (labels: Labels) => {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
  return parts.length ? `{${parts.join(',')}}` : ''
}

type Metric = { lines: () => string[] }
const metrics: Metric[] = []

export function counter(name: string, help: string) {
  const values = new Map<string, { labels: Labels; value: number }>()
  metrics.push({
    lines: () => [`# HELP ${name} ${help}`, `# TYPE ${name} counter`, ...[...values.values()].map((v) => `${name}${render(v.labels)} ${v.value}`)],
  })
  return {
    inc(labels: Labels = {}, by = 1) {
      const k = key(labels)
      const v = values.get(k) ?? values.set(k, { labels, value: 0 }).get(k)!
      v.value += by
    },
  }
}

export function histogram(name: string, help: string, buckets: number[]) {
  const values = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>()
  metrics.push({
    lines: () => [
      `# HELP ${name} ${help}`,
      `# TYPE ${name} histogram`,
      ...[...values.values()].flatMap((v) => [
        ...buckets.map((le, i) => `${name}_bucket${render({ ...v.labels, le: String(le) })} ${v.counts[i]}`),
        `${name}_bucket${render({ ...v.labels, le: '+Inf' })} ${v.count}`,
        `${name}_sum${render(v.labels)} ${v.sum}`,
        `${name}_count${render(v.labels)} ${v.count}`,
      ]),
    ],
  })
  return {
    observe(labels: Labels, value: number) {
      const k = key(labels)
      const v = values.get(k) ?? values.set(k, { labels, counts: buckets.map(() => 0), sum: 0, count: 0 }).get(k)!
      buckets.forEach((le, i) => {
        if (value <= le) v.counts[i]!++
      })
      v.sum += value
      v.count++
    },
  }
}

/** A value read when scraped: a pool's size, memory — or a counter something else keeps, like CPU time. */
export function gauge(name: string, help: string, read: () => { labels?: Labels; value: number }[], type: 'gauge' | 'counter' = 'gauge') {
  metrics.push({
    lines: () => [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...read().map((v) => `${name}${render(v.labels ?? {})} ${v.value}`)],
  })
}

export function renderMetrics(): string {
  return `${metrics.flatMap((m) => m.lines()).join('\n')}\n`
}

// ---- the API's own ---------------------------------------------------------------

const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]

export const httpRequests = counter('eidp_http_requests_total', 'HTTP requests answered, by route pattern and status.')
export const httpDuration = histogram('eidp_http_request_duration_seconds', 'Time to the response headers, by route pattern.', SECONDS)
export const jobRuns = counter('eidp_job_runs_total', 'Background job runs this process did, by job and outcome.')
export const jobDuration = histogram('eidp_job_duration_seconds', 'How long background job runs took.', [1, 5, 15, 30, 60, 120, 300, 600, 1800])

let inFlight = 0
export const requestStarted = () => void inFlight++
export const requestEnded = () => void inFlight--
gauge('eidp_http_requests_in_flight', 'Requests being handled now, streams included.', () => [{ value: inFlight }])

const loop = monitorEventLoopDelay({ resolution: 20 })
loop.enable()
gauge('eidp_event_loop_delay_p99_seconds', 'How late the event loop runs, 99th percentile since the last scrape.', () => {
  const value = loop.percentile(99) / 1e9
  loop.reset()
  return [{ value }]
})
gauge('eidp_process_resident_memory_bytes', 'Resident memory.', () => [{ value: process.memoryUsage.rss() }])
gauge('eidp_process_cpu_seconds_total', 'CPU time used, user and system.', () => {
  const { user, system } = process.cpuUsage()
  return [{ value: (user + system) / 1e6 }]
}, 'counter')
const startedAt = Date.now() / 1000
gauge('eidp_process_start_time_seconds', 'When this process started, as a Unix time.', () => [{ value: startedAt }])
