import { Hono } from 'hono'
import { z } from 'zod'
import * as healthService from '../integrations/health-service/index.ts'
import { validate } from '../lib/validate.ts'
import { requireAuth, requirePermission, type AppEnv } from '../middleware/auth.ts'
import { health } from '../services/health.ts'

/**
 * The portal's health for DevOps. `/health` (the page's "now") is checked
 * here, where the credentials are; history, our machines and alerts belong
 * to the health service (apps/health) and are asked of it on the person's
 * behalf — the permissions are the portal's, the service trusts the token.
 * `/health` at the root stays the public liveness probe.
 */
const MachineId = z.object({ id: z.string().uuid() })
/** The service validates the body properly; this only keeps it an object. */
const Machine = z.record(z.string(), z.unknown())

const actor = (c: { get: (key: 'jwtPayload') => { sub: string; name: string } }) => {
  const me = c.get('jwtPayload')
  return `${me.sub} (${me.name})`
}

export const systemRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/health', requirePermission('system.health'), async (c) => c.json(await health({ fresh: c.req.query('fresh') === '1' })))

  // Uptime by day, response times and incidents — the portal's dependencies and our machines alike.
  .get('/history', requirePermission('system.health'), validate('query', z.object({ days: z.coerce.number().int().min(1).max(365).default(90) })), async (c) =>
    c.json(await healthService.call(`/history?days=${c.req.valid('query').days}`)),
  )

  .get('/machines', requirePermission('system.health'), async (c) => c.json(await healthService.call('/machines')))
  .post('/machines', requirePermission('machines.manage'), validate('json', Machine), async (c) =>
    c.json(await healthService.call('/machines', { method: 'POST', body: c.req.valid('json'), actor: actor(c) }), 201),
  )
  .put('/machines/:id', requirePermission('machines.manage'), validate('param', MachineId), validate('json', Machine), async (c) =>
    c.json(await healthService.call(`/machines/${c.req.valid('param').id}`, { method: 'PUT', body: c.req.valid('json'), actor: actor(c) })),
  )
  .delete('/machines/:id', requirePermission('machines.manage'), validate('param', MachineId), async (c) => {
    await healthService.call(`/machines/${c.req.valid('param').id}`, { method: 'DELETE', actor: actor(c) })
    return c.body(null, 204)
  })
  // Check one now, recorded as a sample — after adding it, or to see a fix land.
  .post('/machines/:id/check', requirePermission('system.health'), validate('param', MachineId), async (c) =>
    c.json(await healthService.call(`/machines/${c.req.valid('param').id}/check`, { method: 'POST' })),
  )

  // The outbox: what went down and came back, and whether it has been sent (the mail service will).
  .get('/alerts', requirePermission('system.health'), async (c) => c.json(await healthService.call('/alerts?limit=50')))
