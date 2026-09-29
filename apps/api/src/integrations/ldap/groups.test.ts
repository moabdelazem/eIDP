// Needs the openldap container with the seeded DEVOPS group.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseGroupFilter, groupFilter, groupsOf } from './groups.ts'
import { profileOf } from './profile.ts'

const AD = { vendor: 'Active Directory (dc01.efinance.com.eg)', isActiveDirectory: true }
const OPENLDAP = { vendor: 'OpenLDAP', isActiveDirectory: false }
const AD_USER_FILTER = '(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))'

test('Active Directory gets the in-chain filter, so nested groups count', () => {
  const { filter } = chooseGroupFilter(AD, undefined)
  assert.match(filter, /objectClass=group\)/)
  assert.match(filter, /1\.2\.840\.113556\.1\.4\.1941/)
})

test('OpenLDAP gets direct groupOfNames membership', () => {
  assert.match(chooseGroupFilter(OPENLDAP, undefined).filter, /groupOfNames/)
})

test('a server that will not describe itself is recognised as AD by its user filter', () => {
  // The bug this exists for: an AD .env written before LDAP_GROUP_FILTER was a
  // setting fell back to the OpenLDAP filter, found no groups, and nobody in
  // DEVOPS could approve anything.
  const chosen = chooseGroupFilter(null, AD_USER_FILTER)
  assert.match(chosen.filter, /objectClass=group\)/)
  assert.match(chosen.source, /inferred Active Directory/)
})

test('a silent server with no AD hints falls back to groupOfNames', () => {
  assert.match(chooseGroupFilter(null, undefined).filter, /groupOfNames/)
})

test('the live directory is detected, not assumed', async () => {
  const { source } = await groupFilter()
  assert.equal(source, 'detected OpenLDAP')
})

test('group names come back by cn', async () => {
  assert.deepEqual(await groupsOf('uid=alice,ou=people,dc=eidp,dc=local'), ['DEVOPS', 'Payments'])
  assert.deepEqual(await groupsOf('uid=bob,ou=people,dc=eidp,dc=local'), ['Payments'])
})

test('a dn is escaped before it enters the group filter', async () => {
  // Unescaped, the `*` and parentheses would widen the filter to every group.
  assert.deepEqual(await groupsOf('uid=*)(member=*'), [])
})

test('the profile carries title, department, manager and groups', async () => {
  const bob = await profileOf('bob')
  assert.equal(bob?.title, 'Backend Developer')
  // OpenLDAP spells it departmentNumber; AD spells it department.
  assert.equal(bob?.department, 'Payments')
  // The manager attribute is a DN; people want a name.
  assert.equal(bob?.manager, 'Alice Example')
  assert.equal(bob?.isApprover, false)

  const alice = await profileOf('alice')
  assert.deepEqual(alice?.groups, ['DEVOPS', 'Payments'])
  assert.equal(alice?.isApprover, true)
})

test('an account that does not exist has no profile', async () => {
  assert.equal(await profileOf('nobody'), null)
})
