import { config } from '../../lib/config.ts'
import { ApiError } from '../../lib/errors.ts'

/**
 * Jira Data Center / Server (on-prem) REST client — `<base>/rest/api/2/...`.
 *
 * v2, not v3: v3 is Cloud's, and Data Center speaks v2 only. Settings are
 * optional so the API boots without them, like Azure DevOps.
 */

export type JiraConfig = {
  baseUrl: string
  /** The full Authorization header value. */
  authorization: string
  projectTemplate: string
  memberRole: string
}

/** Reads Jira settings, or explains exactly which ones are missing. */
export function jiraConfig(): JiraConfig {
  const missing = (['JIRA_BASE_URL', 'JIRA_TOKEN'] as const).filter((key) => !config[key])
  if (missing.length > 0) {
    throw new ApiError(
      503,
      'jira_not_configured',
      `Jira is not configured: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set.`,
    )
  }
  return {
    baseUrl: config.JIRA_BASE_URL!.replace(/\/+$/, ''),
    authorization: authHeader(config.JIRA_TOKEN!, config.JIRA_USERNAME),
    projectTemplate: config.JIRA_PROJECT_TEMPLATE,
    memberRole: config.JIRA_MEMBER_ROLE,
  }
}

/**
 * A personal access token is a Bearer token. A username turns it into Basic
 * auth with the token as the password — servers before 8.14 have no PATs.
 */
export function authHeader(token: string, username?: string): string {
  return username ? `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}` : `Bearer ${token}`
}

export function apiUrl(baseUrl: string, path: string, query: Record<string, string | number> = {}): string {
  const url = new URL(`${baseUrl}/rest/api/2/${path.replace(/^\/+/, '')}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
  return url.toString()
}

export function jiraGet<T>(path: string, query?: Record<string, string | number>): Promise<T> {
  return jiraRequest<T>('GET', path, query)
}

export function jiraPost<T>(path: string, body: unknown): Promise<T> {
  return jiraRequest<T>('POST', path, undefined, body)
}

async function jiraRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  query?: Record<string, string | number>,
  body?: unknown,
): Promise<T> {
  const jira = jiraConfig()
  let res: Response
  try {
    res = await fetch(apiUrl(jira.baseUrl, path, query), {
      method,
      headers: {
        authorization: jira.authorization,
        accept: 'application/json',
        // Jira's XSRF check is for browser forms; say plainly this is not one.
        'x-atlassian-token': 'no-check',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.HTTP_TIMEOUT_SECONDS * 1000),
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') throw new ApiError(504, 'jira_timeout', 'Jira took too long to answer.')
    throw new ApiError(502, 'jira_unreachable', 'Cannot reach Jira.')
  }

  if (!res.ok) throw await jiraError(res)
  if (res.status === 204) return undefined as T

  // Behind SSO, a dead token can come back as the login page with a 200.
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) {
    throw new ApiError(502, 'jira_not_authenticated', 'Jira returned a sign-in page. The access token is likely expired.')
  }
  return (await res.json()) as T
}

/**
 * Jira's error shape: `{ errorMessages: [...], errors: { field: message } }`.
 * Both halves are read, because project creation puts its reasons in `errors`.
 */
export function errorDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const { errorMessages, errors } = body as { errorMessages?: unknown; errors?: unknown }
  const messages = [
    ...(Array.isArray(errorMessages) ? errorMessages.map(String) : []),
    ...(errors && typeof errors === 'object' ? Object.values(errors).map(String) : []),
  ]
  return messages.join(' ')
}

async function jiraError(res: Response): Promise<ApiError> {
  const detail = errorDetail(await res.json().catch(() => null))
  // Seraph, Jira's login filter, says why it refused in a header — including
  // AUTHENTICATION_DENIED, a 403 meaning the account now needs a CAPTCHA.
  if (res.status === 401 || /AUTHENTICAT/.test(res.headers.get('x-seraph-loginreason') ?? '')) {
    return new ApiError(502, 'jira_not_authenticated', 'Jira rejected the access token.')
  }
  if (res.status === 403) {
    return new ApiError(502, 'jira_forbidden', detail || 'The Jira service account is not allowed to do that.')
  }
  if (res.status === 404) return new ApiError(404, 'jira_not_found', detail || 'Not found in Jira.')
  if (res.status === 400) return new ApiError(502, 'jira_refused', detail || 'Jira refused the request.')
  return new ApiError(502, 'jira_error', detail || `Jira returned ${res.status}.`)
}
