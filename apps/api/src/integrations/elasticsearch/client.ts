import { config } from '../../lib/config.ts'
import { ApiError } from '../../lib/errors.ts'

/**
 * Elasticsearch REST client — the store of the ELK stack — over Node's fetch.
 * No client library: the portal needs five calls, and `@elastic/elasticsearch`
 * would bring its own transport for them.
 *
 * Settings are optional so the API boots without them, like Jira. A private
 * CA is trusted through NODE_EXTRA_CA_CERTS, as for Vault: Node's fetch has no
 * per-request CA setting.
 */

export type EsConfig = {
  baseUrl: string
  /** The full Authorization header value. */
  authorization: string
  /** The indices the portal may touch, as written in ELASTICSEARCH_INDICES. */
  indices: string[]
}

/** Reads the settings, or explains exactly which are missing. */
export function esConfig(): EsConfig {
  if (!config.ELASTICSEARCH_URL) {
    throw new ApiError(503, 'elasticsearch_not_configured', 'Elasticsearch is not configured: ELASTICSEARCH_URL is not set.')
  }
  const authorization = authHeader({ apiKey: config.ELASTICSEARCH_API_KEY, username: config.ELASTICSEARCH_USERNAME, password: config.ELASTICSEARCH_PASSWORD })
  if (!authorization) {
    throw new ApiError(
      503,
      'elasticsearch_not_configured',
      'Elasticsearch is not configured: set ELASTICSEARCH_API_KEY, or ELASTICSEARCH_USERNAME and ELASTICSEARCH_PASSWORD.',
    )
  }
  return { baseUrl: config.ELASTICSEARCH_URL.replace(/\/+$/, ''), authorization, indices: parseIndices(config.ELASTICSEARCH_INDICES) }
}

/** An API key wins over a username and password; neither is no header at all. */
export function authHeader({ apiKey, username, password }: { apiKey?: string; username?: string; password?: string }): string | null {
  if (apiKey) return `ApiKey ${apiKey}`
  if (username && password) return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  return null
}

export function parseIndices(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * Whether the portal may touch `index`: it is named in the list, or matches an
 * entry's `*`. Nothing else in the cluster is reachable through the portal.
 */
export function indexAllowed(index: string, allowed: string[]): boolean {
  return allowed.some((entry) => new RegExp(`^${entry.split('*').map(escape).join('.*')}$`).test(index))
}

const escape = (part: string) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

/**
 * Elasticsearch's own rules for an index name, so a bad one is refused here
 * with a reason instead of reaching the cluster: lowercase; none of
 * `\ / * ? " < > | , #`, a space or a colon; not starting with `-`, `_` or
 * `+`; not `.` or `..`; at most 255 bytes. One concrete index — never a
 * wildcard, a list or an alias pattern, which would reach past the allowlist.
 */
export function indexNameProblem(name: string): string | null {
  if (!name) return 'An index name is needed.'
  if (name !== name.toLowerCase()) return 'Index names are lowercase.'
  if (/[\\/*?"<>|,# :]/.test(name)) return 'An index name has none of \\ / * ? " < > | , # : or a space.'
  if (/^[-_+]/.test(name)) return 'An index name does not start with -, _ or +.'
  if (name === '.' || name === '..') return 'An index name is not . or ..'
  if (Buffer.byteLength(name) > 255) return 'An index name is at most 255 bytes.'
  return null
}

/** Throws unless `index` is a valid name the portal may touch. */
export function assertIndex(index: string): EsConfig {
  const es = esConfig()
  const problem = indexNameProblem(index)
  if (problem) throw new ApiError(400, 'invalid_index', problem)
  if (!indexAllowed(index, es.indices)) {
    // Not "does not exist": whether an index outside the list exists is not the caller's to learn.
    throw new ApiError(403, 'index_not_allowed', `The portal does not read or write ${index}. DevOps list the indices it may use in ELASTICSEARCH_INDICES.`)
  }
  return es
}

/**
 * Keys that run code on the cluster — a Painless script inside a query, a
 * runtime field. A search reads; it never runs a script someone sent.
 */
const SCRIPTED = new Set(['script', 'script_score', 'script_fields', 'runtime_mappings', 'stored_script', 'scripted_metric'])

/** The first scripted key anywhere in a search body, or null. */
export function scriptIn(value: unknown, depth = 0): string | null {
  if (depth > 32 || value === null || typeof value !== 'object') return null
  for (const [key, inner] of Object.entries(value)) {
    if (SCRIPTED.has(key)) return key
    const found = scriptIn(inner, depth + 1)
    if (found) return found
  }
  return null
}

export function esRequest<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, query: Record<string, string> = {}): Promise<T> {
  const es = esConfig()
  const url = new URL(`${es.baseUrl}/${path.replace(/^\/+/, '')}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return send<T>(url, method, es.authorization, body)
}

async function send<T>(url: URL, method: string, authorization: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.HTTP_TIMEOUT_SECONDS * 1000),
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') throw new ApiError(504, 'elasticsearch_timeout', 'Elasticsearch took too long to answer.')
    throw new ApiError(502, 'elasticsearch_unreachable', 'Cannot reach Elasticsearch.')
  }
  if (!res.ok) throw await esError(res)
  return (await res.json()) as T
}

/**
 * Elasticsearch's error shape: `{ error: { type, reason, root_cause: [...] }, status }`.
 * The reason is the useful part ("failed to parse field [x] of type [long]").
 */
export function errorReason(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const error = (body as { error?: unknown }).error
  if (typeof error === 'string') return error
  if (!error || typeof error !== 'object') return ''
  const { reason, type, root_cause } = error as { reason?: unknown; type?: unknown; root_cause?: unknown }
  const root = Array.isArray(root_cause) && root_cause[0] && typeof root_cause[0] === 'object' ? (root_cause[0] as { reason?: unknown }).reason : undefined
  return String(reason ?? root ?? type ?? '')
}

async function esError(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => null)
  const reason = errorReason(body)
  if (res.status === 401) return new ApiError(502, 'elasticsearch_not_authenticated', 'Elasticsearch rejected the portal’s credentials.')
  if (res.status === 403) return new ApiError(502, 'elasticsearch_forbidden', reason || 'The portal’s Elasticsearch account is not allowed to do that.')
  if (res.status === 404) return new ApiError(404, 'elasticsearch_not_found', reason || 'Not found in Elasticsearch.')
  if (res.status === 400) return new ApiError(400, 'elasticsearch_refused', reason || 'Elasticsearch refused the request.')
  if (res.status === 409) return new ApiError(409, 'elasticsearch_conflict', reason || 'A document with that id already exists.')
  if (res.status === 429) return new ApiError(503, 'elasticsearch_busy', 'Elasticsearch is too busy to answer. Try again shortly.')
  return new ApiError(502, 'elasticsearch_error', reason || `Elasticsearch returned ${res.status}.`)
}
