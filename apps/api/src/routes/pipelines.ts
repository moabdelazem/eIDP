import { Hono } from 'hono'
import { accessFrom, requireAuth, requirePermission, type AppEnv } from '../middleware/auth.ts'
import * as pipelines from '../services/pipelines.ts'

/**
 * My pipelines: the Jenkins jobs that are the caller's, with what they may do
 * about each. Opening a build and acting on one go through `/jenkins`, which
 * checks the same relation per job.
 */
export const pipelineRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)

  .get('/', requirePermission('pipelines.view'), async (c) => {
    const claims = c.get('jwtPayload')
    return c.json(await pipelines.mine(await accessFrom(c), { uid: claims.sub, name: claims.name }))
  })
