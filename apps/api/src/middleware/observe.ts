import { randomUUID } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import { routePath } from 'hono/route'
import { log, withLogContext } from '../lib/log.ts'
import { httpDuration, httpRequests, requestEnded, requestStarted } from '../lib/metrics.ts'

/** An id a caller may hand us: Envoy's are UUIDs; anything else odd is replaced rather than logged. */
const ACCEPTABLE_ID = /^[\w.:-]{8,128}$/

/**
 * Every request gets an id — the Gateway's `x-request-id` when it sent one,
 * so a line in Envoy's access log and ours are the same request — which goes
 * back in the response and onto every log line written while handling it
 * (`lib/log.ts`). Then one line per request, and its metrics.
 *
 * Probes are counted but not logged: the kubelet asks every few seconds, and
 * a draining pod answers not-ready on purpose. `/health/ready` logs the
 * failure that matters — Postgres not answering — itself.
 */
export const observe = createMiddleware(async (c, next) => {
  const sent = c.req.header('x-request-id')
  const requestId = sent && ACCEPTABLE_ID.test(sent) ? sent : randomUUID()
  c.header('x-request-id', requestId)
  const started = performance.now()
  requestStarted()
  try {
    await withLogContext({ requestId }, async () => {
      await next()
      const seconds = (performance.now() - started) / 1000
      const status = c.res.status
      // The pattern, not the path: `/jenkins/builds/:job/:number`, one series however many builds.
      const matched = routePath(c, -1)
      const route = status === 404 && (!matched || matched.endsWith('*')) ? 'unmatched' : matched || 'unmatched'
      httpRequests.inc({ method: c.req.method, route, status: String(status) })
      httpDuration.observe({ method: c.req.method, route }, seconds)
      if (c.req.path.startsWith('/health')) return
      const line = { method: c.req.method, path: c.req.path, route, status, ms: Math.round(seconds * 1000) }
      if (status >= 500) log.error('request', line)
      else log.info('request', line)
    })
  } finally {
    requestEnded()
  }
})
