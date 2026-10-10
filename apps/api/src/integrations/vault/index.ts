import { z } from 'zod'
import { CONFIG_KEYS } from '../../lib/config-schema.ts'
import { setSecretsState, type SecretsState } from '../../lib/secrets-state.ts'

/**
 * HashiCorp Vault as the source of the API's secrets, with `.env` behind it.
 *
 * Runs before anything reads `lib/config.ts` — the entry points await it and
 * only then import the rest — and writes what it read into `process.env`, so
 * config parses exactly as it always has. A setting in Vault wins over the
 * same one in `.env`; a setting only in `.env` stays.
 *
 * If Vault is configured and cannot be read — unreachable, sealed, a refused
 * token, a path that is not there — nothing from it is applied (never half a
 * set of paths) and the API boots on `.env` alone, saying why. With
 * `VAULT_REQUIRED=true` that is a refusal to boot instead.
 *
 * Only names the API declares (`CONFIG_KEYS`) are taken from Vault: a secret
 * store must not be able to set NODE_OPTIONS or PATH for the API and every git
 * it starts. Values are never logged — names only.
 *
 * Its own settings are read from `process.env` directly, not from config:
 * they are what config waits for. KV v2 by default (`<mount>/data/<path>`),
 * v1 by setting. A token, or AppRole (whose token is revoked once read). A
 * private CA goes in NODE_EXTRA_CA_CERTS — Node's fetch takes no CA option.
 */

const blankAsUnset = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)

const VaultSettings = z
  .object({
    VAULT_ADDR: z.preprocess(blankAsUnset, z.string().url().optional()),
    VAULT_TOKEN: z.preprocess(blankAsUnset, z.string().optional()),
    VAULT_ROLE_ID: z.preprocess(blankAsUnset, z.string().optional()),
    VAULT_SECRET_ID: z.preprocess(blankAsUnset, z.string().optional()),
    VAULT_APPROLE_PATH: z.preprocess(blankAsUnset, z.string().default('approle')),
    VAULT_NAMESPACE: z.preprocess(blankAsUnset, z.string().optional()),
    VAULT_KV_MOUNT: z.preprocess(blankAsUnset, z.string().default('secret')),
    VAULT_KV_VERSION: z.preprocess(blankAsUnset, z.enum(['1', '2']).default('2')),
    /** One or more paths under the mount, comma-separated; a later path wins. */
    VAULT_SECRET_PATHS: z.preprocess(blankAsUnset, z.string().optional()),
    VAULT_TIMEOUT_SECONDS: z.preprocess(blankAsUnset, z.coerce.number().positive().default(5)),
    VAULT_REQUIRED: z.preprocess(blankAsUnset, z.enum(['true', 'false']).default('false')),
  })
  .passthrough()

type Settings = z.infer<typeof VaultSettings>

/** A Vault failure, worded for whoever reads the boot log. */
export class VaultError extends Error {}

const ATTEMPTS = 2
const RETRY_MS = 1000

/**
 * Reads the secrets into `env` (process.env by default) and records where the
 * settings came from. Never throws unless Vault is required and failed, or its
 * own settings are malformed.
 */
export async function loadSecrets(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<SecretsState> {
  const parsed = VaultSettings.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error(`Vault settings are not usable:\n${problems.join('\n')}`)
  }
  const s = parsed.data
  if (!s.VAULT_ADDR) return record({ source: 'env' })

  const paths = (s.VAULT_SECRET_PATHS ?? '')
    .split(',')
    .map((p) => p.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
  try {
    if (paths.length === 0) throw new VaultError('VAULT_ADDR is set but VAULT_SECRET_PATHS is not — name the path the secrets are under.')
    const values = await read(s, paths, fetcher)
    const known = new Set(CONFIG_KEYS)
    const loaded: string[] = []
    const ignored: string[] = []
    for (const [key, value] of Object.entries(values)) {
      if (!known.has(key)) ignored.push(key)
      else {
        env[key] = value
        loaded.push(key)
      }
    }
    return record({ source: 'vault', paths, loaded: loaded.sort(), ignored: ignored.sort() })
  } catch (err) {
    const error = err instanceof VaultError ? err.message : `Vault could not be read: ${err instanceof Error ? err.message : String(err)}`
    if (s.VAULT_REQUIRED === 'true') throw new Error(`${error}\nVAULT_REQUIRED is true, so the API will not start on .env alone.`)
    return record({ source: 'env-fallback', paths, error })
  }
}

function record(state: SecretsState): SecretsState {
  setSecretsState(state)
  return state
}

/** Every path, in order, merged — or a VaultError naming what went wrong. All or nothing. */
async function read(s: Settings, paths: string[], fetcher: typeof fetch): Promise<Record<string, string>> {
  const vault = client(s, fetcher)
  const { token, issued } = await login(s, vault)
  try {
    const merged: Record<string, string> = {}
    for (const path of paths) Object.assign(merged, await readPath(s, vault, token, path))
    return merged
  } finally {
    // A token AppRole issued for this boot is not needed after it.
    if (issued) await vault('POST', 'auth/token/revoke-self', token).catch(() => {})
  }
}

type Call = (method: 'GET' | 'POST', path: string, token: string | null, body?: unknown) => Promise<{ status: number; json: any }>

function client(s: Settings, fetcher: typeof fetch): Call {
  const base = s.VAULT_ADDR!.replace(/\/+$/, '')
  return async (method, path, token, body) => {
    let lastError: unknown
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const res = await fetcher(`${base}/v1/${path}`, {
          method,
          headers: {
            ...(token ? { 'X-Vault-Token': token } : {}),
            ...(s.VAULT_NAMESPACE ? { 'X-Vault-Namespace': s.VAULT_NAMESPACE } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(s.VAULT_TIMEOUT_SECONDS * 1000),
        })
        // Sealed, or a standby without a leader: worth one more try.
        if ((res.status === 503 || res.status === 429) && attempt < ATTEMPTS) {
          await new Promise((r) => setTimeout(r, RETRY_MS))
          continue
        }
        const text = await res.text()
        return { status: res.status, json: text ? safeJson(text) : null }
      } catch (err) {
        lastError = err
        if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_MS))
      }
    }
    const reason = lastError instanceof Error && lastError.name === 'TimeoutError' ? `no answer within ${s.VAULT_TIMEOUT_SECONDS}s` : unreachable(lastError)
    throw new VaultError(`Cannot reach Vault at ${base}: ${reason}.`)
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function unreachable(err: unknown): string {
  // localhost tries ::1 and 127.0.0.1, and fails as an AggregateError of both.
  const inner = (err as { cause?: { code?: string; message?: string; errors?: { code?: string }[] } })?.cause
  const cause = inner?.code ?? inner?.errors?.[0]?.code
  if (cause === 'ECONNREFUSED') return 'connection refused'
  if (cause === 'ENOTFOUND') return 'no such host'
  if (cause && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(cause)) return `its certificate is not trusted (${cause}) — put the CA in NODE_EXTRA_CA_CERTS`
  if (inner?.message) return inner.message
  return err instanceof Error ? err.message : String(err)
}

/** Vault's own words, from `{"errors": [...]}`. */
function vaultSays(json: any): string {
  // Vault wraps them as "1 error occurred:\n\t* permission denied\n\n"; one line reads better in a log.
  const errors = Array.isArray(json?.errors)
    ? json.errors
        .filter((e: unknown): e is string => typeof e === 'string')
        .map((e: string) => e.replace(/^\d+ errors? occurred:/, '').replace(/^\s*\*\s*/gm, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
    : []
  return errors.length ? `: ${errors.join('; ')}` : ''
}

async function login(s: Settings, vault: Call): Promise<{ token: string; issued: boolean }> {
  if (s.VAULT_ROLE_ID && s.VAULT_SECRET_ID) {
    const { status, json } = await vault('POST', `auth/${s.VAULT_APPROLE_PATH}/login`, null, { role_id: s.VAULT_ROLE_ID, secret_id: s.VAULT_SECRET_ID })
    const token = json?.auth?.client_token
    if (status !== 200 || typeof token !== 'string') {
      throw new VaultError(`Vault refused the AppRole login (${status})${vaultSays(json)} — check VAULT_ROLE_ID and VAULT_SECRET_ID.`)
    }
    return { token, issued: true }
  }
  if (s.VAULT_TOKEN) return { token: s.VAULT_TOKEN, issued: false }
  throw new VaultError('VAULT_ADDR is set but there is no way to log in — set VAULT_TOKEN, or VAULT_ROLE_ID and VAULT_SECRET_ID.')
}

async function readPath(s: Settings, vault: Call, token: string, path: string): Promise<Record<string, string>> {
  const mount = s.VAULT_KV_MOUNT.replace(/^\/+|\/+$/g, '')
  const url = s.VAULT_KV_VERSION === '2' ? `${mount}/data/${path}` : `${mount}/${path}`
  const where = `${mount}/${path}`
  const { status, json } = await vault('GET', url, token)
  if (status === 403) throw new VaultError(`Vault refused to read ${where} (403)${vaultSays(json)} — the token's policy must allow read on ${url}.`)
  if (status === 404) {
    throw new VaultError(`Vault has no secret at ${where} (404) — check VAULT_KV_MOUNT, VAULT_SECRET_PATHS and VAULT_KV_VERSION (${s.VAULT_KV_VERSION}).`)
  }
  if (status === 503) throw new VaultError(`Vault is sealed or has no active node (503)${vaultSays(json)}.`)
  if (status !== 200) throw new VaultError(`Vault answered ${status} reading ${where}${vaultSays(json)}.`)
  const data = s.VAULT_KV_VERSION === '2' ? json?.data?.data : json?.data
  // KV v2 keeps a deleted version's metadata and answers with data: null.
  if (!data || typeof data !== 'object') throw new VaultError(`The secret at ${where} is empty or its latest version is deleted.`)
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value === 'string') values[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') values[key] = String(value)
    // Objects and lists cannot be an environment variable; leave them out.
  }
  return values
}

