import { tokenStore } from './token-store.ts'

const BASE = '/api'

/** An error the API described. `code` is stable; `message` is fit to show. */
export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

type ApiErrorBody = { error?: { code?: string; message?: string } }

/**
 * The only place that talks to the API. Attaches the session token, and turns
 * a failure response into an ApiError carrying the message the API wrote —
 * the UI should not be inventing its own wording for a server-side outcome.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const token = tokenStore.get()
  if (token) headers.set('authorization', `Bearer ${token}`)

  let res: Response
  try {
    res = await fetch(BASE + path, { ...init, headers })
  } catch {
    throw new ApiError(0, 'unreachable', 'Cannot reach the portal. Check your connection.')
  }

  if (!res.ok) {
    // A session that expired mid-use is dead everywhere, not just on this call.
    if (res.status === 401) tokenStore.clear()
    throw new ApiError(res.status, ...(await describe(res)))
  }

  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

async function describe(res: Response): Promise<[code: string, message: string]> {
  try {
    const body = (await res.json()) as ApiErrorBody
    if (body.error?.message) return [body.error.code ?? 'error', body.error.message]
  } catch {
    /* not JSON — fall through to the generic message */
  }
  return ['error', `The portal returned an unexpected error (${res.status}).`]
}
