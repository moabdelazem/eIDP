import { Hono } from 'hono'
import { z } from 'zod'
import { ApiError } from '../lib/errors.ts'
import { validate } from '../lib/validate.ts'
import { accessFrom, requireAuth, requirePermission, type AppEnv } from '../middleware/auth.ts'
import { demandTeam, digest, generate, recentWeeks, storedWeeks, teamsFor, weekOf } from '../services/digest.ts'
import { can } from '../services/rbac.ts'

const Week = z.object({ week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A week is the date of its Monday, YYYY-MM-DD.').optional() })

/**
 * Weekly digests, per team. Anyone reads their own teams'; `digests.all`
 * reads every team's and may write a finished week again.
 */
export const digestRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)

  // The teams you may read, which of them you are in, and the weeks on offer.
  .get('/', requirePermission('catalog.view'), async (c) => {
    const access = await accessFrom(c)
    const { teams, mine } = await teamsFor(access)
    return c.json({ teams, mine, weeks: recentWeeks(), current: weekOf(new Date()), canRegenerate: can(access, 'digests.all') })
  })

  .get('/:team', requirePermission('catalog.view'), validate('query', Week), async (c) => {
    const team = await demandTeam(await accessFrom(c), c.req.param('team'))
    const week = c.req.valid('query').week ?? recentWeeks()[1]!
    const [result, kept] = await Promise.all([digest(team, week), storedWeeks(team)])
    const weeks = [...new Set([...recentWeeks(), ...kept])].sort().reverse()
    return c.json({ ...result, weeks })
  })

  // Counted and written again — after a fix to the facts, or when the model was down.
  .post('/:team/regenerate', requirePermission('digests.all'), validate('json', z.object({ week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })), async (c) => {
    const team = await demandTeam(await accessFrom(c), c.req.param('team'))
    const { week } = c.req.valid('json')
    if (week >= weekOf(new Date())) throw new ApiError(400, 'week_in_progress', 'The week in progress is counted live; it is written up once it ends.')
    if (!recentWeeks().includes(week)) throw new ApiError(400, 'too_old', `The builds of the week of ${week} are no longer kept, so it cannot be counted again.`)
    return c.json(await generate(team, week))
  })
