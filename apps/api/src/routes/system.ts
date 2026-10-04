import { Hono } from 'hono'
import { requireAuth, requirePermission, type AppEnv } from '../middleware/auth.ts'
import { health } from '../services/health.ts'

/**
 * The portal's health, component by component, for DevOps. `/health` stays
 * the public liveness probe; this one names servers and versions, so it is
 * behind `system.health`. `?fresh=1` asks everything again now instead of
 * from the 15-second cache.
 */
export const systemRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/health', requirePermission('system.health'), async (c) => c.json(await health({ fresh: c.req.query('fresh') === '1' })))
