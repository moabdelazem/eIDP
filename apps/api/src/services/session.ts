import { sign } from 'hono/jwt'
import { config } from '../lib/config.ts'
import { groupsOf, isApproverGroup, type DirectoryUser } from '../integrations/ldap/index.ts'

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
}

export type IssuedSession = {
  token: string
  expiresAt: number
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
