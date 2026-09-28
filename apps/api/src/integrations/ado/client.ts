import { config } from '../../lib/config.ts'
import { ApiError } from '../../lib/errors.ts'

/**
 * Azure DevOps Server (on-prem) REST client.
 *
 * Three scopes, one URL shape:
 *   server      <server>/_apis/...                       collections
 *   collection  <server>/<collection>/_apis/...          projects, processes
 *   project     <server>/<collection>/<project>/_apis/... repositories
 *
 * ADO_BASE_URL is "server + the default collection", which is what the
 * inventories sync has always used. The api-version is pinned to the server
 * release, so it is config rather than a constant.
 */

export type AdoConfig = {
  /** Default collection, as configured: ADO_BASE_URL. */
  baseUrl: string
  /** The root above every collection. */
  serverUrl: string
  /** The collection ADO_BASE_URL names. */
  defaultCollection: string
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
  const baseUrl = config.ADO_BASE_URL!.replace(/\/+$/, '')
  return {
    baseUrl,
    ...splitCollection(baseUrl, config.ADO_SERVER_URL),
    pat: config.ADO_PAT!,
    apiVersion: config.ADO_API_VERSION,
  }
}

/**
 * The collection is the last path segment of ADO_BASE_URL — that is the
 * documented contract. ADO_SERVER_URL overrides the server half for servers
 * mounted somewhere that contract does not describe.
 */
export function splitCollection(
  baseUrl: string,
  serverOverride?: string,
): { serverUrl: string; defaultCollection: string } {
  const url = new URL(baseUrl)
  const segments = url.pathname.split('/').filter(Boolean)
  const defaultCollection = decodeURIComponent(segments.pop() ?? '')
  url.pathname = segments.length ? `/${segments.join('/')}` : '/'
  return {
    serverUrl: (serverOverride ?? url.toString()).replace(/\/+$/, ''),
    defaultCollection,
  }
}

/** A PAT authenticates as an empty username with the token as the password. */
export function authHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
}

export type Scope = {
  /** Omit for the default collection; `null` for the server level. */
  collection?: string | null
  project?: string
  query?: Record<string, string | number | boolean>
  /** Overrides the configured api-version for one call. */
  apiVersion?: string
}

/** Builds an API URL at server, collection or project scope. */
export function apiUrl(ado: AdoConfig, path: string, options: Scope = {}): string {
  const base =
    options.collection === null
      ? ado.serverUrl
      : options.collection === undefined
        ? ado.baseUrl
        : `${ado.serverUrl}/${encodeURIComponent(options.collection)}`
  const scope = options.project ? `/${encodeURIComponent(options.project)}` : ''
  const url = new URL(`${base.replace(/\/+$/, '')}${scope}/_apis/${path.replace(/^\/+/, '')}`)
  url.searchParams.set('api-version', options.apiVersion ?? ado.apiVersion)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/** A page of results. ADO wraps collections in `{ count, value }`. */
type AdoList<T> = { count: number; value: T[] }

export function adoGet<T>(path: string, options: Scope = {}): Promise<T> {
  return adoRequest<T>('GET', path, options)
}

export function adoPost<T>(path: string, body: unknown, options: Scope = {}): Promise<T> {
  return adoRequest<T>('POST', path, options, body)
}

export function adoPut<T>(path: string, options: Scope = {}): Promise<T> {
  return adoRequest<T>('PUT', path, options)
}

async function adoRequest<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  options: Scope,
  body?: unknown,
): Promise<T> {
  const ado = adoConfig()
  const url = apiUrl(ado, path, options)

  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: authHeader(ado.pat),
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(502, 'ado_unreachable', 'Cannot reach Azure DevOps.')
  }

  if (!res.ok) {
    // Which APIs are still "preview" differs by server release — on 6.0 the
    // identity and security APIs are. The server says so in a 400 of its own;
    // ask once more with -preview rather than hardcoding a list per release.
    const version = options.apiVersion ?? ado.apiVersion
    if (res.status === 400 && !version.includes('-preview') && isPreviewRefusal(await res.clone().json().catch(() => null))) {
      return adoRequest<T>(method, path, { ...options, apiVersion: `${version}-preview` }, body)
    }
    throw await adoError(res)
  }
  // Adding a group member answers with no body at all on some releases.
  if (res.status === 204) return undefined as T

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

/** ADO's answer to a plain api-version on an API that is still in preview. */
export function isPreviewRefusal(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const { typeKey, message } = body as { typeKey?: unknown; message?: unknown }
  return typeKey === 'VssInvalidPreviewVersionException' || /is under preview/i.test(String(message ?? ''))
}

export async function adoGetList<T>(path: string, options: Scope = {}): Promise<T[]> {
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
  if (res.status === 409) {
    return new ApiError(409, 'ado_conflict', detail || 'That already exists in Azure DevOps.')
  }
  if (res.status === 403) {
    return new ApiError(
      502,
      'ado_forbidden',
      detail || 'The Azure DevOps service account is not allowed to do that.',
    )
  }
  return new ApiError(502, 'ado_error', detail || `Azure DevOps returned ${res.status}.`)
}
