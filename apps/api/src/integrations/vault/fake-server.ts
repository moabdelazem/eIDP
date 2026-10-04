/**
 * A small stand-in for HashiCorp Vault, for tests and for running the API
 * against "Vault" locally.
 *
 *   pnpm --filter @eidp/api vault:fake
 *   VAULT_ADDR=http://localhost:8201 VAULT_TOKEN=dev-root VAULT_SECRET_PATHS=eidp/api
 *
 * KV v2 at `secret/`, KV v1 at `kv/`, a static token and an AppRole login,
 * namespaces when asked for one, and Vault's `{"errors": [...]}` refusals.
 * It can be sealed on request.
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

export type FakeVaultOptions = {
  token?: string
  approle?: { roleId: string; secretId: string }
  /** When set, requests without this X-Vault-Namespace see an empty Vault. */
  namespace?: string
  /** Secrets by path, under both mounts. */
  secrets?: Record<string, Record<string, unknown>>
  /** Paths the token may read; all when unset. */
  readable?: string[]
}

export function createFakeVault({
  token = 'dev-root',
  approle = { roleId: 'eidp-role', secretId: 'eidp-secret' },
  namespace,
  secrets = {},
  readable,
}: FakeVaultOptions = {}) {
  let sealed = false
  const issued = new Set<string>()
  const revoked: string[] = []
  /** Every request, for tests: method, path and the token it carried. */
  const requests: { method: string; path: string; token: string | null; namespace: string | null }[] = []

  const app = new Hono()
  const errors = (messages: string[], status: 400 | 403 | 404 | 503) => ({ body: { errors: messages }, status })

  app.use('/v1/*', async (c, next) => {
    requests.push({ method: c.req.method, path: c.req.path, token: c.req.header('x-vault-token') ?? null, namespace: c.req.header('x-vault-namespace') ?? null })
    if (sealed && c.req.path !== '/v1/sys/health') return c.json({ errors: ['Vault is sealed'] }, 503)
    await next()
  })

  const authorised = (t: string | undefined) => t === token || (t !== undefined && issued.has(t))
  const inNamespace = (ns: string | undefined) => !namespace || ns === namespace

  // Answers sealed with 503 by itself, like Vault — before the sealed middleware would.
  app.get('/v1/sys/health', (c) =>
    c.json({ initialized: true, sealed, standby: false, version: '1.17.2', cluster_name: 'vault-fake' }, sealed ? 503 : 200),
  )

  app.post('/v1/auth/approle/login', async (c) => {
    const body = await c.req.json<{ role_id?: string; secret_id?: string }>()
    if (!inNamespace(c.req.header('x-vault-namespace')) || body.role_id !== approle.roleId || body.secret_id !== approle.secretId) {
      const e = errors(['invalid role or secret ID'], 400)
      return c.json(e.body, e.status)
    }
    const client = `hvs.approle-${issued.size + 1}`
    issued.add(client)
    return c.json({ auth: { client_token: client, policies: ['eidp'], lease_duration: 3600 } })
  })

  app.post('/v1/auth/token/revoke-self', (c) => {
    const t = c.req.header('x-vault-token')
    if (t && issued.delete(t)) revoked.push(t)
    return c.body(null, 204)
  })

  app.get('/v1/:mount/*', (c) => {
    if (!authorised(c.req.header('x-vault-token'))) {
      const e = errors(['permission denied'], 403)
      return c.json(e.body, e.status)
    }
    const mount = c.req.param('mount')
    const rest = c.req.path.slice(`/v1/${mount}/`.length)
    const v2 = mount === 'secret'
    if (v2 && !rest.startsWith('data/')) return c.json({ errors: [] }, 404)
    const path = v2 ? rest.slice('data/'.length) : rest
    if (readable && !readable.includes(path)) {
      const e = errors(['1 error occurred:\n\t* permission denied\n\n'], 403)
      return c.json(e.body, e.status)
    }
    const data = inNamespace(c.req.header('x-vault-namespace')) ? secrets[path] : undefined
    if (data === undefined) return c.json({ errors: [] }, 404)
    return c.json(v2 ? { data: { data, metadata: { version: 3 } } } : { data })
  })

  return {
    app,
    requests,
    revoked,
    seal: (next = true) => {
      sealed = next
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_VAULT_PORT ?? 8201)
  const fake = createFakeVault({
    secrets: {
      'eidp/api': { JWT_SECRET: 'from-vault-jwt-secret-0123456789', LDAP_BIND_PASSWORD: 'admin' },
    },
  })
  serve({ fetch: fake.app.fetch, port })
  console.log(`fake Vault on http://localhost:${port}`)
  console.log(`  VAULT_ADDR=http://localhost:${port} VAULT_TOKEN=dev-root VAULT_SECRET_PATHS=eidp/api`)
}
