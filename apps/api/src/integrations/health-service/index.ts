import { config } from '../../lib/config.ts'
import { ApiError } from '../../lib/errors.ts'

/**
 * The health service (apps/health), an outside system like any other: it
 * samples the portal and our machines on its own, keeps the history, the
 * machines and the alert outbox. The portal asks it on DevOps' behalf, with
 * the shared `HEALTH_TOKEN`, naming who asked in `x-eidp-actor` so its audit
 * says who changed a machine. Its refusals already have the portal's shape
 * (`{ error: { code, message } }`), so they pass through as they are.
 *
 * Optional, like ADO: without it the portal still checks everything now, and
 * says history, machines and alerts need the health service.
 */

const TIMEOUT_MS = 15_000

export type HealthServiceConfig = { url: string; token: string }

export function healthServiceConfig(): HealthServiceConfig | null {
  return config.HEALTH_SERVICE_URL && config.HEALTH_TOKEN ? { url: config.HEALTH_SERVICE_URL.replace(/\/+$/, ''), token: config.HEALTH_TOKEN } : null
}

function required(): HealthServiceConfig {
  const c = healthServiceConfig()
  if (!c) {
    const missing = [!config.HEALTH_SERVICE_URL && 'HEALTH_SERVICE_URL', !config.HEALTH_TOKEN && 'HEALTH_TOKEN'].filter(Boolean).join(' and ')
    throw new ApiError(503, 'health_service_not_configured', `The health service is not configured: ${missing} ${missing.includes(' and ') ? 'are' : 'is'} not set on the portal.`)
  }
  return c
}

/** Calls `/v1<path>`; its answer, or its refusal as the portal's own. */
export async function call<T>(path: string, { method = 'GET', body, actor }: { method?: string; body?: unknown; actor?: string } = {}): Promise<T> {
  const c = required()
  let res: Response
  try {
    res = await fetch(`${c.url}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${c.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(actor ? { 'x-eidp-actor': actor } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    const timeout = err instanceof Error && err.name === 'TimeoutError'
    throw new ApiError(503, 'health_service_unreachable', `The health service at ${c.url} ${timeout ? `did not answer within ${TIMEOUT_MS / 1000}s` : 'cannot be reached'}. Is it running?`)
  }
  if (res.status === 401) throw new ApiError(503, 'health_service_refused', 'The health service refused the portal’s token: HEALTH_TOKEN differs between the two.')
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    const status = res.status === 404 || res.status === 409 || res.status === 400 ? res.status : 502
    throw new ApiError(status, body?.error?.code ?? 'health_service_error', body?.error?.message ?? `The health service answered ${res.status}.`)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

/** Its liveness and last round — what the portal's own health check reports about it. */
export async function liveness(): Promise<{ ok: boolean; lastRound: { at: string; ok: boolean } | null; sampleMinutes: number }> {
  const c = required()
  const res = await fetch(`${c.url}/health`, { signal: AbortSignal.timeout(5_000) })
  if (!res.ok) throw new Error(`The health service answered ${res.status}.`)
  return (await res.json()) as Awaited<ReturnType<typeof liveness>>
}
