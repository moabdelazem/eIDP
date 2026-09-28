import { createMiddleware } from 'hono/factory'
import { jwt } from 'hono/jwt'
import { isApprover } from '../integrations/ldap/index.ts'
import { config } from '../lib/config.ts'
import { ApiError } from '../lib/errors.ts'
import type { SessionClaims } from '../services/session.ts'

/** The context every route sees. Extend `Variables` as middleware is added. */
export type AppEnv = {
  Variables: {
    jwtPayload: SessionClaims
  }
}

/** Rejects the request with 401 unless it carries a valid session token. */
export const requireAuth = jwt({ secret: config.JWT_SECRET, alg: 'HS256' })

/**
 * DevOps-only. Every route that is DevOps-only declares this, so
 * `grep -rn requireDevOps routes/` lists the whole admin surface.
 *
 * Membership is asked of the directory on every call, never read from the
 * token: a role in a token outlives a removal from the group by the length
 * of the session. Services that act for DevOps check again as well, so a
 * route that forgets this guard still cannot act.
 */
export const requireDevOps = createMiddleware<AppEnv>(async (c, next) => {
  if (!(await isApprover(c.get('jwtPayload').sub))) {
    throw new ApiError(403, 'devops_only', `Only the ${config.APPROVER_GROUP} team can do that.`)
  }
  await next()
})
