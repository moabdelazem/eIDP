import { sign } from 'hono/jwt'
import { config } from '../../lib/config.ts'
import { groupsOf, isApproverGroup, type DirectoryUser } from '../../integrations/ldap/index.ts'

/** What a signed session carries. Anything here is visible to the client. */
export type SessionClaims = {
  sub: string
  name: string
  mail: string
  /**
   * What the UI may offer. A hint only: every decision re-checks the directory,
   * because a role in a token outlives a removal from the group.
   */
  roles: string[]
  exp: number
  /**
   * Set when an admin is viewing the portal as `sub` (RFC 8693's actor claim):
   * who is really behind the session. Such a session is read-only, and ends
   * the moment the actor loses `rbac.view_as` — see middleware/auth.ts.
   */
  act?: { sub: string; name: string }
}

export type IssuedSession = {
  token: string
  expiresAt: number
}

/** How long a "view as" session lasts: long enough to look around, not to forget it. */
const ASSUMED_TTL_SECONDS = 3600

/**
 * A read-only session as `target`, carrying `actor` so every request knows who
 * is really looking. No roles claim: what the target may do is worked out from
 * the directory, the same as for them.
 */
export async function issueAssumedSession(
  target: { uid: string; name: string; mail: string },
  actor: { uid: string; name: string },
): Promise<IssuedSession> {
  const expiresAt = Math.floor(Date.now() / 1000) + ASSUMED_TTL_SECONDS
  const claims: SessionClaims = {
    sub: target.uid,
    name: target.name,
    mail: target.mail,
    roles: [],
    exp: expiresAt,
    act: { sub: actor.uid, name: actor.name },
  }
  return { token: await sign(claims, config.JWT_SECRET), expiresAt }
}

export async function issueSession(user: DirectoryUser): Promise<IssuedSession> {
  const expiresAt = Math.floor(Date.now() / 1000) + config.SESSION_TTL_HOURS * 3600
  // Only the group that matters goes in the token. An AD user in 200 groups
  // would otherwise push the header past what proxies accept.
  const groups = await groupsOf(user.dn)
  const claims: SessionClaims = {
    sub: user.uid,
    name: user.name,
    mail: user.mail,
    roles: groups.some(isApproverGroup) ? ['approver'] : [],
    exp: expiresAt,
  }
  return { token: await sign(claims, config.JWT_SECRET), expiresAt }
}
