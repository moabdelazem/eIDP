import { lazy, type ComponentType } from 'react'

const RELOADED = 'eidp.chunk-reload'

/**
 * A page loaded the first time someone opens it, so the bundle everyone
 * downloads carries only the shell and the landing page.
 *
 * After a deploy, a tab still on the old build asks for chunks the server no
 * longer has. Rather than a dead page, it reloads once onto the new build; a
 * second failure in a row is a real one and is thrown to the error page.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each page keeps its own props through M[K]
export function lazyPage<M extends Record<K, ComponentType<any>>, K extends keyof M & string>(load: () => Promise<M>, name: K) {
  return lazy<M[K]>(async () => {
    try {
      const module = await load()
      try {
        sessionStorage.removeItem(RELOADED)
      } catch {
        // Storage may be blocked; the reload guard just does not hold.
      }
      return { default: module[name] }
    } catch (err) {
      let reloaded = true
      try {
        reloaded = sessionStorage.getItem(RELOADED) === '1'
        if (!reloaded) sessionStorage.setItem(RELOADED, '1')
      } catch {
        // Without storage, never reload: that could loop.
      }
      if (!reloaded) {
        window.location.reload()
        return new Promise<never>(() => {})
      }
      throw err
    }
  })
}
