import { Hono } from 'hono'
import { z } from 'zod'
import { authenticate, profileOf } from '../integrations/ldap/index.ts'
import { ApiError } from '../lib/errors.ts'
import { validate } from '../lib/validate.ts'
import { requireAuth, requirePermission, type AppEnv } from '../middleware/auth.ts'
import { issueAssumedSession, issueSession } from '../services/session.ts'
import { accessOf, auditAssume, can, ROLES, type Role } from '../services/rbac.ts'

const AssumeBody = z.object({ uid: z.string().min(1).max(256) })

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
   * A read-only session as someone else, for an admin to see what they see.
   * Refused from inside one (it is a POST, and those are read-only), so views
   * never nest; audited like a grant.
   */
  .post('/assume', requireAuth, requirePermission('rbac.view_as'), validate('json', AssumeBody), async (c) => {
    const actor = c.get('jwtPayload')
    const { uid } = c.req.valid('json')
    if (uid.trim().toLowerCase() === actor.sub.toLowerCase()) {
      throw new ApiError(400, 'assume_self', 'That is you already.')
    }
    const target = await profileOf(uid.trim())
    if (!target) throw new ApiError(404, 'user_not_found', `The directory has no account called ${uid}.`)
    const session = await issueAssumedSession(target, { uid: actor.sub, name: actor.name })
    await auditAssume(actor.sub, target.uid)
    return c.json(session)
  })

  /**
   * Who you are according to the directory right now — title, department,
   * groups, and whether you can approve. Live rather than from the token, so a
   * session that predates a group change, or predates roles entirely, still
   * shows the truth.
   */
  .get('/profile', requireAuth, async (c) => {
    const uid = c.get('jwtPayload').sub
    const [profile, access] = await Promise.all([profileOf(uid), accessOf(uid)])
    if (!profile) {
      throw new ApiError(404, 'profile_not_found', 'The directory no longer has an account for you.')
    }
    return c.json({
      ...profile,
      // What the UI shows and hides by. The API checks again on every call.
      isApprover: can(access, 'requests.decide'),
      access: {
        roles: access.bindings.map((b) => ({
          role: b.role,
          label: ROLES[b.role as Role]?.label ?? b.role,
          via: b.subjectType === 'user' ? 'you, by name' : b.subject,
          scopeType: b.scopeType,
          scope: b.scope,
          expiresAt: b.expiresAt,
        })),
        grants: access.grants.map(({ permission, scopeType, scope }) => ({ permission, scopeType, scope })),
      },
    })
  })
