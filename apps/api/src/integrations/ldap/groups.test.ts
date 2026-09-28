// Needs the openldap container with the seeded DEVOPS group.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupsOf, isApprover } from './groups.ts'

test('a member of DEVOPS is an approver', async () => {
  assert.equal(await isApprover('alice'), true)
  assert.equal(await isApprover('carol'), true)
})

test('a developer outside DEVOPS is not', async () => {
  assert.equal(await isApprover('bob'), false)
})

test('an account that does not exist is not an approver', async () => {
  assert.equal(await isApprover('nobody'), false)
})

test('group names come back by cn', async () => {
  assert.deepEqual(await groupsOf('uid=alice,ou=people,dc=eidp,dc=local'), ['DEVOPS'])
  assert.deepEqual(await groupsOf('uid=bob,ou=people,dc=eidp,dc=local'), [])
})

test('a dn is escaped before it enters the group filter', async () => {
  // Unescaped, the `*` and parentheses would widen the filter to every group.
  assert.deepEqual(await groupsOf('uid=*)(member=*'), [])
})
