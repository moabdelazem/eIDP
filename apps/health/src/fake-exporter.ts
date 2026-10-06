import { serve } from '@hono/node-server'
import { Hono } from 'hono'

/**
 * A stand-in for Prometheus' node_exporter, for tests and local development:
 * `/metrics` in its text format, for a 4-core machine whose CPU counters
 * advance as if it were 25% busy, with memory and disk set by `state`.
 * `pnpm --filter @eidp/health exporter:fake` serves one on :9100.
 */
export function createFakeExporter(state = { memoryUsed: 0.42, diskUsed: 0.61, load1: 0.8 }) {
  const started = Date.now()
  const app = new Hono().get('/metrics', (c) => {
    const elapsed = (Date.now() - started) / 1000 + 1000
    const lines = ['# HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.', '# TYPE node_cpu_seconds_total counter']
    for (let cpu = 0; cpu < 4; cpu++) {
      lines.push(`node_cpu_seconds_total{cpu="${cpu}",mode="idle"} ${(elapsed * 0.75).toFixed(2)}`)
      lines.push(`node_cpu_seconds_total{cpu="${cpu}",mode="user"} ${(elapsed * 0.2).toFixed(2)}`)
      lines.push(`node_cpu_seconds_total{cpu="${cpu}",mode="system"} ${(elapsed * 0.05).toFixed(2)}`)
    }
    const total = 16 * 2 ** 30
    lines.push(
      `node_load1 ${state.load1}`,
      `node_memory_MemTotal_bytes ${total}`,
      `node_memory_MemAvailable_bytes ${Math.round(total * (1 - state.memoryUsed))}`,
      `node_filesystem_size_bytes{device="/dev/sda1",fstype="xfs",mountpoint="/"} 107374182400`,
      `node_filesystem_avail_bytes{device="/dev/sda1",fstype="xfs",mountpoint="/"} ${Math.round(107374182400 * (1 - state.diskUsed))}`,
      `node_filesystem_size_bytes{device="tmpfs",fstype="tmpfs",mountpoint="/run"} 1000`,
      `node_filesystem_avail_bytes{device="tmpfs",fstype="tmpfs",mountpoint="/run"} 1`,
      `node_boot_time_seconds ${Math.round(Date.now() / 1000) - 12 * 86400}`,
      `node_time_seconds ${(Date.now() / 1000).toFixed(3)}`,
    )
    return c.text(lines.join('\n') + '\n')
  })
  return { app, state }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 9100)
  serve({ fetch: createFakeExporter().app.fetch, port })
  console.log(`fake node_exporter on http://localhost:${port}/metrics`)
}
