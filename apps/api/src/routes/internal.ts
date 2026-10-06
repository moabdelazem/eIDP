import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { config } from '../lib/config.ts'
import { ApiError } from '../lib/errors.ts'
import type { AppEnv } from '../middleware/auth.ts'
import { health } from '../services/health.ts'

/**
 * For the health service, not for people: the portal's own dependencies,
 * checked now, read every few minutes and kept as history there. It takes
 * the shared `HEALTH_TOKEN`, never a session — so it works when sign-in does
 * not, which is exactly when it matters. Without a token set, it is not here.
 */
function authorised(header: string | undefined): boolean {
  if (!config.HEALTH_TOKEN) return false
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '')
  const expected = Buffer.from(config.HEALTH_TOKEN)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export const internalRoutes = new Hono<AppEnv>().get('/health', async (c) => {
  if (!config.HEALTH_TOKEN) throw new ApiError(404, 'not_found', 'Not found.')
  if (!authorised(c.req.header('authorization'))) throw new ApiError(401, 'unauthorised', 'That is not the health service’s token.')
  return c.json(await health({ fresh: c.req.query('fresh') === '1' }))
})
