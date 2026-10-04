import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../lib/validate.ts'
import { requireAuth, requirePermission, type AppEnv } from '../middleware/auth.ts'
import { health, history } from '../services/health.ts'

/**
 * The portal's health, component by component, for DevOps. `/health` stays
 * the public liveness probe; this one names servers and versions, so it is
 * behind `system.health`. `?fresh=1` asks everything again now instead of
 * from the 15-second cache.
 */
export const systemRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/health', requirePermission('system.health'), async (c) => c.json(await health({ fresh: c.req.query('fresh') === '1' })))

  // Uptime by day, recent response times and past incidents, from the samples taken every few minutes.
  .get('/history', requirePermission('system.health'), validate('query', z.object({ days: z.coerce.number().int().min(1).max(365).default(90) })), async (c) =>
    c.json(await history(c.req.valid('query').days)),
  )
