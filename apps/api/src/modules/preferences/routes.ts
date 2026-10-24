import type { AppearancePreference, OverviewPreference } from '@eidp/contracts/preferences'
import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../../lib/validate.ts'
import { requireAuth, type AppEnv } from '../../middleware/auth.ts'
import { appearance, overviewLayout, resetOverviewLayout, saveAppearance, saveOverviewLayout } from './service.ts'

/** A card's id: what the web app names it (features/overview/cards.tsx). */
const CardId = z.string().regex(/^[a-z][a-z-]{0,39}$/, 'A card is named in lower case, with dashes.')
const Layout = z.object({ order: z.array(CardId).max(40), hidden: z.array(CardId).max(40) })
const Appearance = z.object({ theme: z.enum(['light', 'dark', 'system']), palette: z.enum(['classic', 'efinance']) }).strict()

/**
 * Your own preferences, and only yours: who you are comes from your session,
 * never from the request.
 */
export const preferenceRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)

  .get('/overview', async (c) => c.json((await overviewLayout(c.get('jwtPayload').sub)) satisfies OverviewPreference))

  .put('/overview', validate('json', Layout), async (c) => c.json((await saveOverviewLayout(c.get('jwtPayload').sub, c.req.valid('json'))) satisfies OverviewPreference))

  /** The theme and colours, so they follow the person to any browser, not just the one they chose them in. */
  .get('/appearance', async (c) => c.json((await appearance(c.get('jwtPayload').sub)) satisfies AppearancePreference))

  .put('/appearance', validate('json', Appearance), async (c) => c.json((await saveAppearance(c.get('jwtPayload').sub, c.req.valid('json'))) satisfies AppearancePreference))

  .delete('/overview', async (c) => {
    await resetOverviewLayout(c.get('jwtPayload').sub)
    return c.body(null, 204)
  })
