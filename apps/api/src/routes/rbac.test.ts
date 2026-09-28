// Who can reach the DevOps-only surface. Needs the openldap container:
// alice is in DEVOPS, bob is not.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sign } from 'hono/jwt'
import { createApp } from '../app.ts'
import { config } from '../lib/config.ts'

const app = createApp()

/**
 * Every DevOps-only endpoint. A new admin route belongs in this list; the
 * `requireDevOps` guard on it is what makes these tests pass.
 */
const DEVOPS_ONLY: [method: string, path: string][] = [
  ['GET', '/requests/pool'],
  ['POST', '/requests/00000000-0000-0000-0000-000000000000/approve'],
  ['POST', '/requests/00000000-0000-0000-0000-000000000000/reject'],
  ['POST', '/requests/00000000-0000-0000-0000-000000000000/retry'],
  ['POST', '/catalog/sync'],
]

async function login(username: string): Promise<string> {
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: `${username}pw` }),
  })
  return ((await res.json()) as { token: string }).token
}

function call(token: string, method: string, path: string) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'POST' ? '{}' : undefined,
  })
}

const bob = await login('bob')
const alice = await login('alice')

for (const [method, path] of DEVOPS_ONLY) {
  test(`${method} ${path} refuses someone outside DevOps`, async () => {
    const res = await call(bob, method, path)
    assert.equal(res.status, 403)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'devops_only')
  })

  test(`${method} ${path} lets DevOps through the guard`, async () => {
    // Past the guard it may still be 404 (no such request) or 503 (nothing to
    // sync) — what matters is that it is not a refusal.
    assert.notEqual((await call(alice, method, path)).status, 403)
  })
}

test('a token that claims the approver role grants nothing by itself', async () => {
  // Validly signed, but bob is not in DEVOPS. The server asks the directory,
  // so a stale or forged role claim cannot open the admin surface.
  const forged = await sign(
    { sub: 'bob', name: 'Bob Example', mail: 'bob@eidp.local', roles: ['approver'], exp: Math.floor(Date.now() / 1000) + 600 },
    config.JWT_SECRET,
  )
  for (const [method, path] of DEVOPS_ONLY) {
    assert.equal((await call(forged, method, path)).status, 403, `${method} ${path}`)
  }
})

test('anyone signed in can still read the map and file requests', async () => {
  // The guard is for the admin surface only; locking these would break the product.
  assert.notEqual((await call(bob, 'GET', '/catalog/status')).status, 403)
  assert.notEqual((await call(bob, 'GET', '/requests/mine')).status, 403)
})

test('without a session, the admin surface is a 401, not a 403', async () => {
  for (const [method, path] of DEVOPS_ONLY) {
    const res = await app.request(path, { method })
    assert.equal(res.status, 401, `${method} ${path}`)
  }
})
