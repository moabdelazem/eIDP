import { Hono } from 'hono'
import { z } from 'zod'
import { authenticate, profileOf } from '../integrations/ldap/index.ts'
import { ApiError } from '../lib/errors.ts'
import { validate } from '../lib/validate.ts'
import { requireAuth, type AppEnv } from '../middleware/auth.ts'
import { issueSession } from '../services/session.ts'

const LoginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

export const authRoutes = new Hono<AppEnv>()
  .post('/login', validate('json', LoginBody), async (c) => {
    const { username, password } = c.req.valid('json')

    const user = await authenticate(username, password)
    if (!user) {
      throw new ApiError(401, 'invalid_credentials', "That username and password don't match.")
    }

    const { token, expiresAt } = await issueSession(user)
    return c.json({ token, expiresAt })
  })
  .get('/me', requireAuth, (c) => c.json(c.get('jwtPayload')))

  /**
   * Who you are according to the directory right now — title, department,
   * groups, and whether you can approve. Live rather than from the token, so a
   * session that predates a group change, or predates roles entirely, still
   * shows the truth.
   */
  .get('/profile', requireAuth, async (c) => {
    const profile = await profileOf(c.get('jwtPayload').sub)
    if (!profile) {
      throw new ApiError(404, 'profile_not_found', 'The directory no longer has an account for you.')
    }
    return c.json(profile)
  })
