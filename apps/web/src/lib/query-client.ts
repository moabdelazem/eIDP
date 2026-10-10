import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './api-client.ts'
import { tokenStore } from './token-store.ts'

/**
 * The one cache of what the API answered, shared by every component that asks
 * for the same thing (`useResource`'s key): the sidebar's approvals count,
 * the Overview and the Approvals page read one request, and a reload in one
 * refreshes all three.
 *
 * - **An answer is not retried.** A 4xx, or a 503 this API wrote ("not
 *   configured", "not built yet"), is what it means to say. Only an
 *   unreachable portal or a proxy's 502/504 — a restart mid-deploy — is
 *   tried once more.
 * - **Five seconds fresh.** Opening a page another just loaded reads the
 *   cache; after that, mounting or refocusing the tab asks again.
 * - **The cache is someone's.** Every change of session — sign-in, sign-out,
 *   viewing as someone, a dead token — empties it, so one person's data never
 *   shows for the next, even for a frame.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: (failures, error) => failures < 1 && (!(error instanceof ApiError) || [0, 502, 504].includes(error.status)),
    },
  },
})

tokenStore.onChange(() => queryClient.clear())
