import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../../lib/validate.ts'
import { accessFrom, requireAuth, requirePermission, type AppEnv } from '../../middleware/auth.ts'
import * as pipelines from './service.ts'

/**
 * My pipelines: the runs that are the caller's — theirs by name, or their
 * team's projects' — with what they may do about each. Opening a build and
 * acting on one go through `/jenkins`, which judges the run the same way.
 */
export const pipelineRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)

  .get('/', requirePermission('pipelines.view'), validate('query', z.object({ window: z.enum(['24h', '7d', '30d']).default('7d') })), async (c) => {
    const claims = c.get('jwtPayload')
    const me = { uid: claims.sub, name: claims.name, mail: claims.mail }
    return c.json(await pipelines.mine(await accessFrom(c), me, c.req.valid('query').window))
  })
