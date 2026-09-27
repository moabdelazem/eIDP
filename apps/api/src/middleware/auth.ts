import { jwt } from 'hono/jwt'
import { config } from '../lib/config.ts'
import type { SessionClaims } from '../services/session.ts'

/** The context every route sees. Extend `Variables` as middleware is added. */
export type AppEnv = {
  Variables: {
    jwtPayload: SessionClaims
  }
}

/** Rejects the request with 401 unless it carries a valid session token. */
export const requireAuth = jwt({ secret: config.JWT_SECRET, alg: 'HS256' })
