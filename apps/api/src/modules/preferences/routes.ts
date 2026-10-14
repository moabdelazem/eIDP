import type { OverviewPreference } from '@eidp/contracts/preferences'
import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../../lib/validate.ts'
import { requireAuth, type AppEnv } from '../../middleware/auth.ts'
import { overviewLayout, resetOverviewLayout, saveOverviewLayout } from './service.ts'

/** A card's id: what the web app names it (features/overview/cards.tsx). */
const CardId = z.string().regex(/^[a-z][a-z-]{0,39}$/, 'A card is named in lower case, with dashes.')
const Layout = z.object({ order: z.array(CardId).max(40), hidden: z.array(CardId).max(40) })

/**
 * Your own preferences, and only yours: who you are comes from your session,
 * never from the request.
 */
export const preferenceRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)

  .get('/overview', async (c) => c.json((await overviewLayout(c.get('jwtPayload').sub)) satisfies OverviewPreference))

  .put('/overview', validate('json', Layout), async (c) => c.json((await saveOverviewLayout(c.get('jwtPayload').sub, c.req.valid('json'))) satisfies OverviewPreference))

  .delete('/overview', async (c) => {
    await resetOverviewLayout(c.get('jwtPayload').sub)
    return c.body(null, 204)
  })
