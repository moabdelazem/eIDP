import { useCallback } from 'react'
import { keepPreviousData, useQuery, type QueryKey } from '@tanstack/react-query'
import { ApiError } from './api-client.ts'

export type Resource<T> = {
  data: T | undefined
  error: string | null
  /** Nothing to show yet for this key — the first load, or a new key while the last one's data stands in. */
  loading: boolean
  reload: () => void
}

/**
 * Loads something and keeps it fresh, through the shared cache
 * (`lib/query-client.ts`). `key` names what is fetched — the same key in two
 * components is one request and one answer — and carries everything the
 * fetch depends on, so a new value is a new fetch.
 *
 * `pollMs` refetches on an interval while the tab is visible; `null` stops
 * polling, which is how a page watching an in-flight request stops once it
 * settles. While a new key loads, the previous key's data stays on screen
 * (`loading` says so), as a table keeps its rows while the next page comes.
 */
export function useResource<T>(key: QueryKey, fetcher: () => Promise<T>, { pollMs = null as number | null } = {}): Resource<T> {
  const query = useQuery({
    queryKey: key,
    queryFn: fetcher,
    refetchInterval: pollMs ?? false,
    placeholderData: keepPreviousData,
  })
  const { refetch } = query
  // Stable, so a context or memo that hands it on does not change every render.
  const reload = useCallback(() => void refetch(), [refetch])
  return {
    data: query.data,
    error: query.error ? (query.error instanceof ApiError ? query.error.message : 'Something went wrong. Try again.') : null,
    loading: query.isPending || query.isPlaceholderData,
    reload,
  }
}
