const KEY = 'eidp.token'

/**
 * Where the session token lives. Owned here rather than by the auth feature so
 * the API client can read it without importing a feature.
 */
export const tokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(KEY)
    } catch {
      return null // private mode, blocked storage
    }
  },
  set(token: string): void {
    try {
      localStorage.setItem(KEY, token)
    } catch {
      /* the session just won't survive a reload */
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(KEY)
    } catch {
      /* nothing to do */
    }
  },
}
