import { config } from '../../lib/config.ts'
import { ApiError } from '../../lib/errors.ts'

/**
 * Azure DevOps Server (on-prem) REST client.
 *
 * URLs are `<base>/<project>/_apis/<area>?api-version=<version>`, where the
 * base already carries the collection. The api-version is pinned to the
 * server release, so it is config rather than a constant.
 */

export type AdoConfig = {
  baseUrl: string
  pat: string
  apiVersion: string
}

/** Reads ADO settings, or explains exactly which ones are missing. */
export function adoConfig(): AdoConfig {
  const missing = (['ADO_BASE_URL', 'ADO_PAT'] as const).filter((key) => !config[key])
  if (missing.length > 0) {
    throw new ApiError(
      503,
      'ado_not_configured',
      `Azure DevOps is not configured: ${missing.join(' and ')} ${
        missing.length > 1 ? 'are' : 'is'
      } not set.`,
    )
  }
  return {
    baseUrl: config.ADO_BASE_URL!.replace(/\/+$/, ''),
    pat: config.ADO_PAT!,
    apiVersion: config.ADO_API_VERSION,
  }
}

/** A PAT authenticates as an empty username with the token as the password. */
export function authHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
}

/** Builds a collection- or project-scoped API URL. */
export function apiUrl(
  ado: AdoConfig,
  path: string,
  options: { project?: string; query?: Record<string, string | number | boolean> } = {},
): string {
  const base = ado.baseUrl.replace(/\/+$/, '')
  const scope = options.project ? `/${encodeURIComponent(options.project)}` : ''
  const url = new URL(`${base}${scope}/_apis/${path.replace(/^\/+/, '')}`)
  url.searchParams.set('api-version', ado.apiVersion)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/** A page of results. ADO wraps collections in `{ count, value }`. */
type AdoList<T> = { count: number; value: T[] }

export async function adoGet<T>(
  path: string,
  options: { project?: string; query?: Record<string, string | number | boolean> } = {},
): Promise<T> {
  const ado = adoConfig()
  const url = apiUrl(ado, path, options)

  let res: Response
  try {
    res = await fetch(url, {
      headers: { authorization: authHeader(ado.pat), accept: 'application/json' },
    })
  } catch {
    throw new ApiError(502, 'ado_unreachable', 'Cannot reach Azure DevOps.')
  }

  if (!res.ok) throw await adoError(res)

  // A PAT that has expired gets an HTML sign-in page with a 200, not a 401.
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) {
    throw new ApiError(
      502,
      'ado_not_authenticated',
      'Azure DevOps returned a sign-in page. The personal access token is likely expired.',
    )
  }
  return (await res.json()) as T
}

export async function adoGetList<T>(
  path: string,
  options: { project?: string; query?: Record<string, string | number | boolean> } = {},
): Promise<T[]> {
  return (await adoGet<AdoList<T>>(path, options)).value ?? []
}

async function adoError(res: Response): Promise<ApiError> {
  const detail = await res
    .json()
    .then((body: unknown) =>
      body && typeof body === 'object' && 'message' in body ? String(body.message) : '',
    )
    .catch(() => '')

  if (res.status === 401 || res.status === 203) {
    return new ApiError(502, 'ado_not_authenticated', 'Azure DevOps rejected the access token.')
  }
  if (res.status === 404) {
    return new ApiError(404, 'ado_not_found', detail || 'Not found in Azure DevOps.')
  }
  return new ApiError(502, 'ado_error', detail || `Azure DevOps returned ${res.status}.`)
}
