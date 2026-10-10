import { config } from '../../lib/config.ts'
import { ApiError } from '../../lib/errors.ts'

/**
 * Jenkins' remote access API: `<url>/<path>/api/json`, with `tree` to say
 * which fields to send — without it Jenkins serialises far more than asked.
 *
 * Authenticated with a user's API token over Basic auth. Calls made that way
 * are exempt from CSRF crumbs (Jenkins 2.96+), so no crumb is fetched; a
 * password in JENKINS_TOKEN would be refused on every POST.
 */

export type JenkinsConfig = { url: string; authorization: string }

/** Reads Jenkins settings, or explains exactly which ones are missing. */
export function jenkinsConfig(): JenkinsConfig {
  const missing = (['JENKINS_URL', 'JENKINS_USER', 'JENKINS_TOKEN'] as const).filter((key) => !config[key])
  if (missing.length > 0) {
    const last = missing.pop()!
    const names = missing.length ? `${missing.join(', ')} and ${last}` : last
    throw new ApiError(503, 'jenkins_not_configured', `Jenkins is not configured: ${names} ${missing.length ? 'are' : 'is'} not set.`)
  }
  return {
    url: config.JENKINS_URL!.replace(/\/+$/, ''),
    authorization: `Basic ${Buffer.from(`${config.JENKINS_USER}:${config.JENKINS_TOKEN}`).toString('base64')}`,
  }
}

/**
 * The URL path of a job from its full name. Folders nest as repeated `job/`
 * segments: `payments/loan-api` lives at `job/payments/job/loan-api`.
 */
export function jobPath(fullName: string): string {
  return fullName
    .split('/')
    .map((segment) => `job/${encodeURIComponent(segment)}`)
    .join('/')
}

/** The reverse of `jobPath`, for URLs Jenkins hands back (queue items, executors). */
export function fullNameFromUrl(url: string): string | null {
  const names = [...new URL(url, 'http://x').pathname.matchAll(/\/job\/([^/]+)/g)].map((m) => decodeURIComponent(m[1]!))
  return names.length ? names.join('/') : null
}

export function apiUrl(base: string, path: string, query: Record<string, string | number> = {}): string {
  const url = new URL(`${base}/${path.replace(/^\/+/, '')}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
  return url.toString()
}

async function send(method: 'GET' | 'POST', path: string, query?: Record<string, string | number>, form?: URLSearchParams): Promise<Response> {
  const jenkins = jenkinsConfig()
  let res: Response
  try {
    res = await fetch(apiUrl(jenkins.url, path, query), {
      method,
      headers: {
        authorization: jenkins.authorization,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form,
      // Several actions answer with a redirect to an HTML page; the redirect
      // itself is the success, and following it would fetch the page.
      redirect: 'manual',
    })
  } catch {
    throw new ApiError(502, 'jenkins_unreachable', 'Cannot reach Jenkins.')
  }
  if (res.status >= 300 && res.status < 400) return res
  if (!res.ok) throw await jenkinsError(res)
  return res
}

export async function jenkinsGet<T>(path: string, query?: Record<string, string | number>): Promise<T> {
  const res = await send('GET', path, query)
  const type = res.headers.get('content-type') ?? ''
  // A reverse proxy's SSO page comes back as HTML with a 200.
  if (!type.includes('json')) {
    throw new ApiError(502, 'jenkins_not_authenticated', 'Jenkins returned a page instead of data. Check JENKINS_USER and JENKINS_TOKEN.')
  }
  return (await res.json()) as T
}

/**
 * The first `maxBytes` of a text resource, then the connection is dropped —
 * where a build log says which agent it started on, without reading the rest.
 */
export async function jenkinsHead(path: string, maxBytes: number): Promise<string> {
  const res = await send('GET', path)
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const chunks: Buffer[] = []
  let read = 0
  try {
    while (read < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      read += value.length
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8')
}

/** A text resource whole — an item's `config.xml`. */
export async function jenkinsText(path: string): Promise<string> {
  return (await send('GET', path)).text()
}

/** A POST that acts. Returns the response for the headers some actions answer with. */
export function jenkinsPost(path: string, form?: URLSearchParams, query?: Record<string, string | number>): Promise<Response> {
  return send('POST', path, query, form)
}

/**
 * The last `maxBytes` of a text resource — a build log can be hundreds of
 * megabytes, and the end is where a failure explains itself. Read as a stream
 * and only the tail kept, so a huge log costs time, not memory.
 *
 * ponytail: still downloads the whole log. `logText/progressiveText?start=`
 * would skip ahead, but needs the size first; worth it when logs get that big.
 */
export async function jenkinsTail(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const res = await send('GET', path)
  const chunks: Buffer[] = []
  let kept = 0
  let truncated = false
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk))
    kept += chunk.length
    while (kept - chunks[0]!.length >= maxBytes) {
      kept -= chunks.shift()!.length
      truncated = true
    }
  }
  let buffer = Buffer.concat(chunks)
  if (buffer.length > maxBytes) {
    buffer = buffer.subarray(buffer.length - maxBytes)
    truncated = true
  }
  let text = buffer.toString('utf8')
  // Cut to a whole line, so the first line shown is not half of one.
  if (truncated) text = text.slice(text.indexOf('\n') + 1)
  return { text, truncated }
}

async function jenkinsError(res: Response): Promise<ApiError> {
  // Jenkins errors are HTML pages; the status says more than the body.
  if (res.status === 401 || (res.status === 403 && res.headers.get('x-you-are-authenticated-as') === 'anonymous')) {
    return new ApiError(502, 'jenkins_not_authenticated', 'Jenkins rejected the API token.')
  }
  if (res.status === 403) {
    return new ApiError(502, 'jenkins_forbidden', 'The Jenkins service account is not allowed to do that.')
  }
  if (res.status === 404) return new ApiError(404, 'jenkins_not_found', 'Jenkins has no such job or build.')
  return new ApiError(502, 'jenkins_error', `Jenkins returned ${res.status}.`)
}
