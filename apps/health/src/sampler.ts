import { raiseAlerts, type Alert } from './alerts.ts'
import { config } from './config.ts'
import { prune } from './history.ts'
import { checkMachine, type Machine, type Reading } from './machines.ts'
import { componentOf, enabledMachines, recordSamples, type Sample } from './store.ts'

/**
 * One round: the portal and what it depends on, and every machine — all at
 * once — recorded as one moment, then judged for alerts.
 *
 * The portal knows how to check its own dependencies (it holds their
 * credentials and integrations) and says so at `/internal/health`; this reads
 * that the way a monitor scrapes any service. When the portal does not
 * answer, it is recorded down — the one thing that matters then — and its
 * dependencies get no sample rather than a guess.
 */

export type Round = { at: string; portal: { ok: boolean; error: string | null }; samples: Sample[]; alerts: Alert[] }

type PortalHealth = { components: { id: string; name: string; status: Sample['status']; summary: string; latencyMs: number | null }[] }

const PORTAL_TIMEOUT_MS = 20_000
const FIRST_ROUND_DELAY_MS = 20_000

let lastRound: { at: string; ok: boolean } | null = null
export const lastRoundAt = () => lastRound

export async function sampleOnce(): Promise<Round> {
  const at = new Date()
  const [portal, machines] = await Promise.all([scrapePortal(), enabledMachines().then((list) => Promise.all(list.map(async (m) => ({ m, r: await checkMachine(m) }))))])

  const samples: (Sample & { recipients?: string[] })[] = [
    { component: 'portal', name: 'e-IDP portal API', status: portal.ok ? 'ok' : 'down', summary: portal.ok ? 'Answering.' : `Not answering: ${portal.error}`, latencyMs: portal.ms },
    ...portal.components.map((c) => ({ component: c.id, name: c.name, status: c.status, summary: c.summary, latencyMs: c.latencyMs })),
    ...machines.map(({ m, r }) => machineSample(m, r)),
  ]
  await recordSamples(at, samples)
  const alerts = await raiseAlerts(samples)
  await prune()
  lastRound = { at: at.toISOString(), ok: true }
  return { at: at.toISOString(), portal: { ok: portal.ok, error: portal.error }, samples, alerts }
}

export function machineSample(m: Machine, r: Reading): Sample & { recipients: string[] } {
  return { component: componentOf(m.id), name: m.name, status: r.status, summary: r.summary, latencyMs: r.latencyMs, metrics: r.metrics, recipients: m.notify }
}

async function scrapePortal(): Promise<{ ok: boolean; error: string | null; ms: number | null; components: PortalHealth['components'] }> {
  const started = performance.now()
  try {
    const res = await fetch(new URL('/internal/health?fresh=1', config.PORTAL_URL), {
      headers: { authorization: `Bearer ${config.HEALTH_TOKEN}` },
      signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS),
    })
    const ms = Math.round(performance.now() - started)
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'it refused the health token — HEALTH_TOKEN differs between the two', ms, components: [] }
    if (!res.ok) return { ok: false, error: `it answered ${res.status}`, ms, components: [] }
    const body = (await res.json()) as PortalHealth
    return { ok: true, error: null, ms, components: body.components }
  } catch (err) {
    const timeout = err instanceof Error && err.name === 'TimeoutError'
    return { ok: false, error: timeout ? `no answer within ${PORTAL_TIMEOUT_MS / 1000}s` : (err as Error).message, ms: null, components: [] }
  }
}

/** Every HEALTH_SAMPLE_MINUTES, one round at a time: a slow round is never overlapped by the next. */
export function startSampling(): () => void {
  if (config.HEALTH_SAMPLE_MINUTES <= 0) return () => {}
  let running = false
  const tick = () => {
    if (running) return
    running = true
    sampleOnce()
      .then((round) => round.alerts.length && console.log(`health: ${round.alerts.length} alert(s) raised: ${round.alerts.map((a) => `${a.name} ${a.kind}`).join(', ')}`))
      .catch((err) => {
        lastRound = { at: new Date().toISOString(), ok: false }
        console.error('health: sample round failed:', err instanceof Error ? err.message : err)
      })
      .finally(() => {
        running = false
      })
  }
  // The first round waits a little: started beside the portal, it would otherwise
  // find the portal still booting and put a false outage in its history.
  const first = setTimeout(tick, FIRST_ROUND_DELAY_MS)
  const timer = setInterval(tick, config.HEALTH_SAMPLE_MINUTES * 60_000)
  first.unref()
  timer.unref()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
