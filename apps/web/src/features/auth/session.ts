import { tokenStore } from '@/lib/token-store.ts'

/** Who is signed in, as read from the token. */
export type Session = {
  token: string
  uid: string
  name: string
  mail: string
  /** What the UI may offer. The API re-checks every decision against AD. */
  roles: string[]
  /** Set while an admin views the portal as `uid`: who is really looking. Read-only. */
  actor: { uid: string; name: string } | null
}

/** The session the browser already holds, or null if there is none worth using. */
export function restoreSession(): Session | null {
  const token = tokenStore.get()
  if (!token) return null

  const session = decode(token)
  if (!session) tokenStore.clear()
  return session
}

/**
 * Reads the claims out of a JWT. This is for display only — the API verifies
 * the signature on every request, so nothing here is trusted for access.
 * Returns null for a token that is unreadable or already expired.
 */
export function decode(token: string): Session | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const claims = JSON.parse(atob(part)) as Record<string, unknown>

    if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) return null

    return {
      token,
      uid: String(claims.sub ?? ''),
      name: String(claims.name ?? ''),
      mail: String(claims.mail ?? ''),
      roles: Array.isArray(claims.roles) ? claims.roles.map(String) : [],
      actor:
        claims.act && typeof claims.act === 'object'
          ? { uid: String((claims.act as Record<string, unknown>).sub ?? ''), name: String((claims.act as Record<string, unknown>).name ?? '') }
          : null,
    }
  } catch {
    return null
  }
}
