import { connect } from 'node:net'
import { config } from './config.ts'

/**
 * Checking one machine, by what it lists — nothing is installed on it for
 * this, and nothing is assumed:
 *
 * - **Ports**: a TCP connection to each (SSH's 22, a database's 5432…). A
 *   port that accepts is up; ICMP ping needs privileges a service should not
 *   have, and a port is what people actually use anyway.
 * - **HTTP URL**: answers with a status below 500.
 * - **node_exporter** (Prometheus'), where the machine runs one: CPU, memory,
 *   the fullest disk, load per core and uptime, read from its text format.
 *   CPU is busy time between two samples, so it appears from the second.
 *
 * Down when nothing it lists answers; degraded when part of it does not, or
 * a resource is past its limit (`LIMITS`); ok otherwise.
 */

export type Machine = {
  id: string
  name: string
  host: string
  ports: number[]
  httpUrl: string | null
  exporterUrl: string | null
  group: string
  environment: string | null
  notify: string[]
  notes: string | null
  enabled: boolean
}

export type Metrics = {
  ports: { port: number; ok: boolean; ms: number | null; error: string | null }[]
  http: { ok: boolean; status: number | null; ms: number | null; error: string | null } | null
  exporter: { ok: boolean; error: string | null } | null
  /** 0–1, busy share of all cores since the last sample; null on the first. */
  cpu: number | null
  cores: number | null
  load1: number | null
  /** 0–1, used share of memory (MemAvailable counts as free). */
  memory: number | null
  /** The fullest real filesystem. */
  disk: { mount: string; used: number } | null
  uptimeSeconds: number | null
}

export type Reading = { status: 'ok' | 'degraded' | 'down'; summary: string; latencyMs: number | null; metrics: Metrics }

/** Past these, a machine is degraded and says which. */
export const LIMITS = { cpu: 0.95, memory: 0.95, disk: 0.9, loadPerCore: 2 } as const

/** Previous CPU counters per machine, for busy time between samples. In memory: a restart costs one sample's CPU. */
const lastCpu = new Map<string, { idle: number; total: number }>()

export async function checkMachine(machine: Machine): Promise<Reading> {
  const timeout = config.MACHINE_TIMEOUT_MS
  const [ports, http, exporter] = await Promise.all([
    Promise.all(machine.ports.map((port) => tcp(machine.host, port, timeout))),
    machine.httpUrl ? httpCheck(machine.httpUrl, timeout) : Promise.resolve(null),
    machine.exporterUrl ? scrape(machine.exporterUrl, timeout) : Promise.resolve(null),
  ])

  const metrics: Metrics = { ports, http, exporter: exporter && { ok: exporter.ok, error: exporter.error }, cpu: null, cores: null, load1: null, memory: null, disk: null, uptimeSeconds: null }
  if (exporter?.ok) Object.assign(metrics, readings(machine.id, exporter.series))

  const checks = [...ports.map((p) => p.ok), ...(http ? [http.ok] : []), ...(exporter ? [exporter.ok] : [])]
  const answered = checks.filter(Boolean).length
  const timings = [...ports.map((p) => p.ms), http?.ms ?? null].filter((ms): ms is number => ms !== null)
  const latencyMs = timings.length ? Math.round(timings.reduce((a, b) => a + b, 0) / timings.length) : null

  if (checks.length === 0) return { status: 'down', summary: 'Nothing to check: give it a port, a URL or a node_exporter.', latencyMs, metrics }
  if (answered === 0) {
    const first = ports[0]?.error ?? http?.error ?? exporter?.error ?? 'No answer.'
    return { status: 'down', summary: `Not reachable: ${first}`, latencyMs, metrics }
  }

  const problems: string[] = []
  for (const p of ports) if (!p.ok) problems.push(`port ${p.port} closed`)
  if (http && !http.ok) problems.push(`${machine.httpUrl} ${http.status ? `answered ${http.status}` : 'did not answer'}`)
  if (exporter && !exporter.ok) problems.push('node_exporter did not answer')
  if (metrics.cpu !== null && metrics.cpu >= LIMITS.cpu) problems.push(`CPU at ${pct(metrics.cpu)}`)
  if (metrics.memory !== null && metrics.memory >= LIMITS.memory) problems.push(`memory at ${pct(metrics.memory)}`)
  if (metrics.disk && metrics.disk.used >= LIMITS.disk) problems.push(`disk ${metrics.disk.mount} ${pct(metrics.disk.used)} full`)
  if (metrics.load1 !== null && metrics.cores && metrics.load1 / metrics.cores >= LIMITS.loadPerCore) problems.push(`load ${metrics.load1.toFixed(1)} on ${metrics.cores} cores`)

  if (problems.length) return { status: 'degraded', summary: capitalise(problems.join(', ')) + '.', latencyMs, metrics }
  const parts = [
    `${answered} of ${checks.length} answered`,
    metrics.cpu !== null && `CPU ${pct(metrics.cpu)}`,
    metrics.memory !== null && `memory ${pct(metrics.memory)}`,
    metrics.disk && `disk ${pct(metrics.disk.used)} on ${metrics.disk.mount}`,
  ].filter(Boolean)
  return { status: 'ok', summary: capitalise(parts.join(', ')) + '.', latencyMs, metrics }
}

const pct = (n: number) => `${Math.round(n * 100)}%`
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function tcp(host: string, port: number, timeout: number): Promise<Metrics['ports'][number]> {
  const started = performance.now()
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (ok: boolean, error: string | null) => {
      socket.destroy()
      resolve({ port, ok, ms: ok ? Math.round(performance.now() - started) : null, error })
    }
    socket.setTimeout(timeout, () => done(false, `no answer on ${host}:${port} within ${timeout / 1000}s`))
    socket.once('connect', () => done(true, null))
    socket.once('error', (err: NodeJS.ErrnoException) =>
      done(false, err.code === 'ECONNREFUSED' ? `${host}:${port} refused the connection` : err.code === 'ENOTFOUND' ? `${host} is not a known host` : `${host}:${port}: ${err.code ?? err.message}`),
    )
  })
}

async function httpCheck(url: string, timeout: number): Promise<NonNullable<Metrics['http']>> {
  const started = performance.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'manual' })
    await res.body?.cancel()
    return { ok: res.status < 500, status: res.status, ms: Math.round(performance.now() - started), error: res.status < 500 ? null : `answered ${res.status}` }
  } catch (err) {
    return { ok: false, status: null, ms: null, error: err instanceof Error && err.name === 'TimeoutError' ? `${url} did not answer within ${timeout / 1000}s` : `${url}: ${(err as Error).message}` }
  }
}

/** One Prometheus sample: a metric name, its labels and its value. */
export type Series = { name: string; labels: Record<string, string>; value: number }[]

async function scrape(url: string, timeout: number): Promise<{ ok: boolean; error: string | null; series: Series }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) })
    if (!res.ok) return { ok: false, error: `node_exporter answered ${res.status}`, series: [] }
    return { ok: true, error: null, series: parseMetrics(await res.text()) }
  } catch (err) {
    return { ok: false, error: `node_exporter: ${(err as Error).message}`, series: [] }
  }
}

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g
/** Only what we read — the rest of an exporter's thousand lines is skipped unparsed. */
const WANTED = /^node_(cpu_seconds_total|load1|memory_MemTotal_bytes|memory_MemAvailable_bytes|filesystem_size_bytes|filesystem_avail_bytes|boot_time_seconds|time_seconds)$/

/** Prometheus' text exposition format, the lines we read. */
export function parseMetrics(text: string): Series {
  const out: Series = []
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const m = LINE.exec(line)
    if (!m || !WANTED.test(m[1]!)) continue
    const labels: Record<string, string> = {}
    for (const l of (m[2] ?? '').matchAll(LABEL)) labels[l[1]!] = l[2]!
    out.push({ name: m[1]!, labels, value: Number(m[3]) })
  }
  return out
}

/** Filesystems that are not disks anyone fills. */
const VIRTUAL_FS = new Set(['tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'proc', 'sysfs', 'ramfs', 'nsfs', 'fuse.lxcfs'])

export function readings(id: string, series: Series): Pick<Metrics, 'cpu' | 'cores' | 'load1' | 'memory' | 'disk' | 'uptimeSeconds'> {
  const one = (name: string) => series.find((s) => s.name === name)?.value ?? null
  const cpuRows = series.filter((s) => s.name === 'node_cpu_seconds_total')
  const cores = new Set(cpuRows.map((s) => s.labels.cpu)).size || null
  let cpu: number | null = null
  if (cpuRows.length) {
    const idle = cpuRows.filter((s) => s.labels.mode === 'idle' || s.labels.mode === 'iowait').reduce((n, s) => n + s.value, 0)
    const total = cpuRows.reduce((n, s) => n + s.value, 0)
    const before = lastCpu.get(id)
    if (before && total > before.total) cpu = Math.min(1, Math.max(0, 1 - (idle - before.idle) / (total - before.total)))
    lastCpu.set(id, { idle, total })
  }
  const memTotal = one('node_memory_MemTotal_bytes')
  const memAvail = one('node_memory_MemAvailable_bytes')
  const sizes = series.filter((s) => s.name === 'node_filesystem_size_bytes' && !VIRTUAL_FS.has(s.labels.fstype ?? '') && s.value > 0)
  let disk: Metrics['disk'] = null
  for (const size of sizes) {
    const avail = series.find((s) => s.name === 'node_filesystem_avail_bytes' && s.labels.mountpoint === size.labels.mountpoint && s.labels.device === size.labels.device)
    if (!avail) continue
    const used = 1 - avail.value / size.value
    if (!disk || used > disk.used) disk = { mount: size.labels.mountpoint ?? '?', used }
  }
  const boot = one('node_boot_time_seconds')
  const now = one('node_time_seconds')
  return {
    cpu,
    cores,
    load1: one('node_load1'),
    memory: memTotal && memAvail !== null ? 1 - memAvail / memTotal : null,
    disk,
    uptimeSeconds: boot && now ? Math.max(0, Math.round(now - boot)) : null,
  }
}
