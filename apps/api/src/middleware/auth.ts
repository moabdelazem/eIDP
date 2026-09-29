import { createMiddleware } from 'hono/factory'
import { jwt } from 'hono/jwt'
import { config } from '../lib/config.ts'
import { ApiError } from '../lib/errors.ts'
import { accessOf, can, canSomewhere, describe, type Access, type Permission } from '../services/rbac.ts'
import type { SessionClaims } from '../services/session.ts'

/** The context every route sees. Extend `Variables` as middleware is added. */
export type AppEnv = {
  Variables: {
    jwtPayload: SessionClaims
    /** Set by `requirePermission`; read it with `accessFrom`. */
    access?: Access
  }
}

const verifyToken = jwt({ secret: config.JWT_SECRET, alg: 'HS256' })

/**
 * Rejects the request with 401 unless it carries a valid session token — and
 * holds a "view as" session to what it is: read-only, and only while the
 * admin behind it still may view as others. Checked on every request, so
 * revoking the permission ends a session already handed out.
 */
export const requireAuth = createMiddleware<AppEnv>((c, next) =>
  verifyToken(c, async () => {
    const actor = c.get('jwtPayload').act
    if (actor) {
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
        throw new ApiError(
          403,
          'viewing_as',
          `You’re viewing the portal as ${c.get('jwtPayload').name}, which is read-only. Return to your own account to make changes.`,
        )
      }
      if (!can(await accessOf(actor.sub), 'rbac.view_as')) {
        throw new ApiError(401, 'view_as_revoked', 'You can no longer view the portal as someone else. Sign in again.')
      }
    }
    await next()
  }),
)

/**
 * Refuses unless the caller holds `permission`. Every guarded route declares
 * it, so `grep -rn requirePermission routes/` lists who may reach what.
 *
 * `scoped: true` lets through anyone who holds it *somewhere* — a team lead on
 * the approvals queue — and leaves the per-item decision to the service,
 * which knows the target. Access is worked out from the directory and the
 * bindings on every call, never read from the token.
 */
export function requirePermission(permission: Permission, { scoped = false } = {}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const access = await accessOf(c.get('jwtPayload').sub)
    c.set('access', access)
    if (!(scoped ? canSomewhere(access, permission) : can(access, permission))) {
      throw new ApiError(403, 'forbidden', `You don’t have permission to ${describe(permission)}.`)
    }
    await next()
  })
}

/** The caller's access: from the guard when it ran, worked out now when it did not. */
export async function accessFrom(c: { get(key: 'access'): Access | undefined; get(key: 'jwtPayload'): SessionClaims }): Promise<Access> {
  return c.get('access') ?? (await accessOf(c.get('jwtPayload').sub))
}
