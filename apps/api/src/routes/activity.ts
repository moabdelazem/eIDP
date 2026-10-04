import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../lib/validate.ts'
import { requireAuth, requirePermission, type AppEnv } from '../middleware/auth.ts'
import * as activity from '../services/activity.ts'

const Window = z.object({ window: z.enum(['24h', '7d', '30d']).default('7d') })

const Feed = Window.extend({
  who: z.string().max(256).optional(),
  group: z.enum(activity.GROUPS).optional(),
  q: z.string().max(200).optional(),
  before: z.string().datetime().optional(),
})

const Visit = z.object({ path: z.string().min(1).max(2000).regex(/^\//, 'A portal path.') })

/**
 * Platform activity. Reading it is `activity.view` (DevOps admins): it shows
 * who did what. Reporting a page opened is anyone signed in — the portal's own
 * shell does it — and, being a POST, is refused while viewing as someone else,
 * so an admin's look around is never put down to the person they viewed as.
 */
export const activityRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)

  .post('/visit', validate('json', Visit), async (c) => {
    const me = c.get('jwtPayload')
    await activity.recordVisit(me.sub, me.name, c.req.valid('json').path)
    return c.body(null, 204)
  })

  .get('/overview', requirePermission('activity.view'), validate('query', Window), async (c) => c.json(await activity.overview(c.req.valid('query').window)))

  .get('/feed', requirePermission('activity.view'), validate('query', Feed), async (c) => c.json(await activity.feed(c.req.valid('query'))))

  .get('/people', requirePermission('activity.view'), validate('query', Window), async (c) => c.json(await activity.people(c.req.valid('query').window)))
