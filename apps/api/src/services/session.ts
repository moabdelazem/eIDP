import { sign } from 'hono/jwt'
import { config } from '../lib/config.ts'
import type { DirectoryUser } from '../integrations/ldap/index.ts'

/** What a signed session carries. Anything here is visible to the client. */
export type SessionClaims = {
  sub: string
  name: string
  mail: string
  exp: number
}

export type IssuedSession = {
  token: string
  expiresAt: number
}

export async function issueSession(user: DirectoryUser): Promise<IssuedSession> {
  const expiresAt = Math.floor(Date.now() / 1000) + config.SESSION_TTL_HOURS * 3600
  const claims: SessionClaims = {
    sub: user.uid,
    name: user.name,
    mail: user.mail,
    exp: expiresAt,
  }
  return { token: await sign(claims, config.JWT_SECRET), expiresAt }
}
