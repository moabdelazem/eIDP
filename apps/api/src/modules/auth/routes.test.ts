// Drives the real app through app.request(), so route wiring, validation and
// the error shape are all covered. Needs openldap up.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from '../../app.ts'

const app = createApp()

const login = (body: unknown) =>
  app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

test('valid credentials return a token', async () => {
  const res = await login({ username: 'alice', password: 'alicepw' })
  assert.equal(res.status, 200)
  const { token, expiresAt } = (await res.json()) as { token: string; expiresAt: number }
  assert.ok(token.split('.').length === 3)
  assert.ok(expiresAt > Math.floor(Date.now() / 1000))
})

test('wrong password is 401 with a stable code', async () => {
  const res = await login({ username: 'alice', password: 'nope' })
  assert.equal(res.status, 401)
  assert.equal((await res.json()).error.code, 'invalid_credentials')
})

test('a missing field is 400, not 500', async () => {
  const res = await login({ username: 'alice' })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error.code, 'invalid_request')
})

test('a body that is not json is 400, not 500', async () => {
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  })
  assert.equal(res.status, 400)
})

test('/auth/me needs a token', async () => {
  assert.equal((await app.request('/auth/me')).status, 401)
})

test('/auth/me returns the claims from the token', async () => {
  const { token } = (await (await login({ username: 'alice', password: 'alicepw' })).json()) as {
    token: string
  }
  const res = await app.request('/auth/me', { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(res.status, 200)
  const claims = (await res.json()) as { sub: string; mail: string }
  assert.equal(claims.sub, 'alice')
  assert.equal(claims.mail, 'alice@eidp.local')
})

test('health is up', async () => {
  assert.equal((await app.request('/health')).status, 200)
})
