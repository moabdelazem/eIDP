const KEY = 'eidp.token'
/** The admin's own token, kept aside while they view the portal as someone else. */
const OWN_KEY = 'eidp.token.own'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null // private mode, blocked storage
  }
}

const listeners = new Set<() => void>()

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* the session just won't survive a reload */
  }
  if (key === KEY) for (const listener of listeners) listener()
}

/**
 * Where the session token lives. Owned here rather than by the auth feature so
 * the API client can read it without importing a feature.
 */
export const tokenStore = {
  /** Called whenever the session changes hands — signing in or out, viewing as someone, a dead session. */
  onChange(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  get(): string | null {
    return read(KEY)
  },
  set(token: string): void {
    write(KEY, token)
  },
  /**
   * Ends the current session. A "view as" session ending — expired, or the
   * admin's permission revoked — returns to the admin's own session rather
   * than signing them out.
   */
  clear(): void {
    const own = read(OWN_KEY)
    write(KEY, own)
    write(OWN_KEY, null)
  },
  /** Signing out: both sessions go. */
  clearAll(): void {
    write(KEY, null)
    write(OWN_KEY, null)
  },
  /** Starts viewing as someone else, keeping the admin's own token aside. */
  assume(token: string): void {
    if (!read(OWN_KEY)) write(OWN_KEY, read(KEY))
    write(KEY, token)
  },
}
