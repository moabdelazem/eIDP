// Integration check — needs `docker compose up -d openldap` and the seed LDIF.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authenticate } from './ldap.ts'

test('valid credentials return the user', async () => {
  const user = await authenticate('alice', 'alicepw')
  assert.equal(user?.uid, 'alice')
  assert.equal(user?.mail, 'alice@eidp.local')
})

test('wrong password is rejected', async () => {
  assert.equal(await authenticate('alice', 'nope'), null)
})

test('unknown user is rejected', async () => {
  assert.equal(await authenticate('nobody', 'alicepw'), null)
})

test('empty password does not become an anonymous bind', async () => {
  assert.equal(await authenticate('alice', ''), null)
})

test('filter metacharacters do not match everything', async () => {
  assert.equal(await authenticate('*', 'alicepw'), null)
})
