import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './api-client.ts'

export type Resource<T> = {
  data: T | undefined
  error: string | null
  loading: boolean
  reload: () => void
}

/**
 * Loads something and keeps it fresh. `pollMs` refetches on an interval while
 * the component is mounted and the tab is visible; `null` stops polling, which
 * is how a page watching an in-flight request stops once it settles.
 *
 * ponytail: no cache shared between components, no deduplication. When two
 * screens start fetching the same thing, that is the moment for TanStack Query.
 */
export function useResource<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  { pollMs = null as number | null } = {},
): Resource<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fetcher, deps)

  const run = useCallback(() => {
    const mine = ++generation.current
    load()
      .then((value) => {
        if (mine !== generation.current) return // a newer load has started
        setData(value)
        setError(null)
      })
      .catch((err: unknown) => {
        if (mine !== generation.current) return
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
      })
      .finally(() => {
        if (mine === generation.current) setLoading(false)
      })
  }, [load])

  useEffect(() => {
    setLoading(true)
    run()
  }, [run])

  useEffect(() => {
    if (pollMs === null) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') run()
    }, pollMs)
    return () => clearInterval(timer)
  }, [run, pollMs])

  return { data, error, loading, reload: run }
}
