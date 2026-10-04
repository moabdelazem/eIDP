// Loading the API's secrets from Vault, with .env behind it — against a fake
// Vault, into a plain object standing in for process.env.
import assert from 'node:assert/strict'
import { createServer, type AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import { serve } from '@hono/node-server'
import { createFakeVault } from './fake-server.ts'
import { loadSecrets } from './index.ts'

const fake = createFakeVault({
  namespace: 'eidp',
  secrets: {
    'eidp/common': { LDAP_BIND_PASSWORD: 'common-pass', JIRA_TOKEN: 'common-jira' },
    'eidp/api': {
      JWT_SECRET: 'vault-jwt-secret-0123456789',
      JIRA_TOKEN: 'api-jira',
      OLLAMA_NUM_CTX: 16384,
      // Names the API does not read — one of them dangerous — and a value no
      // environment variable can hold.
      NODE_OPTIONS: '--require /tmp/evil.js',
      PATH: '/tmp/evil',
      LDAP_URL: { nested: true },
    },
    'eidp/locked': { JWT_SECRET: 'never-read-0123456789' },
  },
  readable: ['eidp/common', 'eidp/api', 'eidp/missing'],
})
const server = serve({ fetch: fake.app.fetch, port: 0 })
await new Promise((resolve) => server.once('listening', resolve))
const ADDR = `http://localhost:${(server.address() as AddressInfo).port}`

after(() => server.close())

/** An environment as .env would leave it, plus Vault's settings. */
function env(vault: Record<string, string>) {
  return { JWT_SECRET: 'env-jwt-secret-0123456789', LDAP_BIND_PASSWORD: 'env-pass', VAULT_NAMESPACE: 'eidp', ...vault } as NodeJS.ProcessEnv
}

test('without VAULT_ADDR, .env is all there is', async () => {
  const e = env({})
  assert.deepEqual(await loadSecrets(e), { source: 'env' })
  assert.equal(e.JWT_SECRET, 'env-jwt-secret-0123456789')
})

test('Vault wins over .env, later paths over earlier, and only names the API reads are taken', async () => {
  const e = env({ VAULT_ADDR: ADDR, VAULT_TOKEN: 'dev-root', VAULT_SECRET_PATHS: 'eidp/common, eidp/api' })
  const state = await loadSecrets(e)
  assert.equal(state.source, 'vault')
  if (state.source !== 'vault') return
  assert.equal(e.JWT_SECRET, 'vault-jwt-secret-0123456789')
  assert.equal(e.LDAP_BIND_PASSWORD, 'common-pass')
  assert.equal(e.JIRA_TOKEN, 'api-jira', 'the later path wins')
  assert.equal(e.OLLAMA_NUM_CTX, '16384', 'numbers become strings')
  assert.equal(e.NODE_OPTIONS, undefined)
  assert.equal(e.PATH, undefined)
  assert.equal(e.LDAP_URL, undefined, 'an object is no environment variable')
  assert.deepEqual(state.loaded, ['JIRA_TOKEN', 'JWT_SECRET', 'LDAP_BIND_PASSWORD', 'OLLAMA_NUM_CTX'])
  assert.deepEqual(state.ignored, ['NODE_OPTIONS', 'PATH'])
  // KV v2 paths, the namespace on every call.
  assert.ok(fake.requests.some((r) => r.path === '/v1/secret/data/eidp/api' && r.namespace === 'eidp' && r.token === 'dev-root'))
})

test('AppRole logs in, reads with the token it was issued, and revokes it after', async () => {
  const before = fake.requests.length
  const e = env({ VAULT_ADDR: ADDR, VAULT_ROLE_ID: 'eidp-role', VAULT_SECRET_ID: 'eidp-secret', VAULT_SECRET_PATHS: 'eidp/api' })
  assert.equal((await loadSecrets(e)).source, 'vault')
  const mine = fake.requests.slice(before)
  const read = mine.find((r) => r.path === '/v1/secret/data/eidp/api')!
  assert.match(read.token!, /^hvs\.approle-/)
  assert.deepEqual(fake.revoked, [read.token])
  assert.equal(mine.at(-1)!.path, '/v1/auth/token/revoke-self')
})

test('KV version 1 reads the path under the mount directly', async () => {
  const v1 = createFakeVault({ secrets: { 'eidp/api': { JWT_SECRET: 'kv1-jwt-secret-0123456789' } } })
  const s = serve({ fetch: v1.app.fetch, port: 0 })
  await new Promise((resolve) => s.once('listening', resolve))
  try {
    const e = env({ VAULT_ADDR: `http://localhost:${(s.address() as AddressInfo).port}`, VAULT_TOKEN: 'dev-root', VAULT_KV_MOUNT: 'kv', VAULT_KV_VERSION: '1', VAULT_SECRET_PATHS: 'eidp/api' })
    assert.equal((await loadSecrets(e)).source, 'vault')
    assert.equal(e.JWT_SECRET, 'kv1-jwt-secret-0123456789')
    assert.equal(v1.requests[0]!.path, '/v1/kv/eidp/api')
  } finally {
    s.close()
  }
})

/** Loads with these settings and expects .env to stand, with `reason` said. */
async function fallsBack(vault: Record<string, string>, reason: RegExp) {
  const e = env({ VAULT_ADDR: ADDR, ...vault })
  const state = await loadSecrets(e)
  assert.equal(state.source, 'env-fallback', JSON.stringify(state))
  if (state.source === 'env-fallback') assert.match(state.error, reason)
  assert.equal(e.JWT_SECRET, 'env-jwt-secret-0123456789', '.env stands')
  assert.equal(e.LDAP_BIND_PASSWORD, 'env-pass', 'nothing half-applied')
}

test('when Vault cannot be read, .env stands — and the reason names what to fix', async () => {
  await fallsBack({ VAULT_TOKEN: 'wrong', VAULT_SECRET_PATHS: 'eidp/api' }, /refused to read secret\/eidp\/api \(403\): permission denied — .*policy/s)
  // One path readable, the next not: neither is applied.
  await fallsBack({ VAULT_TOKEN: 'dev-root', VAULT_SECRET_PATHS: 'eidp/common,eidp/locked' }, /refused to read secret\/eidp\/locked/)
  await fallsBack({ VAULT_TOKEN: 'dev-root', VAULT_SECRET_PATHS: 'eidp/missing' }, /no secret at secret\/eidp\/missing \(404\).*VAULT_KV_MOUNT/)
  await fallsBack({ VAULT_ROLE_ID: 'eidp-role', VAULT_SECRET_ID: 'nope', VAULT_SECRET_PATHS: 'eidp/api' }, /refused the AppRole login \(400\): invalid role or secret ID/)
  await fallsBack({ VAULT_TOKEN: 'dev-root' }, /VAULT_SECRET_PATHS is not/)
  await fallsBack({ VAULT_SECRET_PATHS: 'eidp/api' }, /no way to log in/)
  await fallsBack({ VAULT_TOKEN: 'dev-root', VAULT_SECRET_PATHS: 'eidp/api', VAULT_NAMESPACE: 'other' }, /no secret at/)
})

test('a sealed or unreachable Vault falls back after one more try', async () => {
  fake.seal()
  try {
    await fallsBack({ VAULT_TOKEN: 'dev-root', VAULT_SECRET_PATHS: 'eidp/api' }, /sealed/)
  } finally {
    fake.seal(false)
  }
  // A port that was free a moment ago: nothing listens there.
  const probe = createServer().listen(0)
  await new Promise((resolve) => probe.once('listening', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise((resolve) => probe.close(resolve))
  await fallsBack({ VAULT_ADDR: `http://127.0.0.1:${port}`, VAULT_TOKEN: 'dev-root', VAULT_SECRET_PATHS: 'eidp/api' }, /Cannot reach Vault at http:\/\/127\.0\.0\.1:\d+: connection refused/)
})

test('VAULT_REQUIRED turns a fallback into a refusal to boot', async () => {
  const e = env({ VAULT_ADDR: ADDR, VAULT_TOKEN: 'wrong', VAULT_SECRET_PATHS: 'eidp/api', VAULT_REQUIRED: 'true' })
  await assert.rejects(loadSecrets(e), /403.*VAULT_REQUIRED is true/s)
  assert.equal(e.JWT_SECRET, 'env-jwt-secret-0123456789')
})

test('malformed Vault settings are named', async () => {
  await assert.rejects(loadSecrets(env({ VAULT_ADDR: 'not a url' })), /Vault settings are not usable:\n {2}VAULT_ADDR/)
})
