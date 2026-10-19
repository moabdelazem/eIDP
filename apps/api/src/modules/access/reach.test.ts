// Which systems of the catalog someone sees (catalogReach), worked out from
// their groups and bindings alone: no directory, no database rows.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Binding } from '@eidp/contracts/rbac'

const { catalogReach, grantsOf } = await import('./service.ts')

const binding = (role: string, scopeType: Binding['scopeType'] = 'global', scope: string | null = null): Binding => ({
  id: `${role}-${scope}`,
  subjectType: 'user',
  subject: 'dave',
  role,
  scopeType,
  scope,
  reason: 'test',
  expiresAt: null,
  createdBy: 'alice',
  createdAt: '',
  builtIn: false,
})
const accessWith = (groups: string[], ...bindings: Binding[]) => {
  const all = [binding('member'), ...bindings]
  return { uid: 'dave', groups, bindings: all, grants: grantsOf(all) }
}

const pay = { project: 'Loans', teams: { dev: 'Payments', prd: 'DEVOPS' }, approvers: [], managers: [] }
const nb = { project: 'NFP', teams: { dev: 'NBTeam' }, approvers: ['NB-Approvers'], managers: ['erin'], opsTeams: ['OPS'] }

test('a member sees the systems their groups own, in any case, and no others', () => {
  const reach = catalogReach(accessWith(['payments']))
  assert.equal(reach.all, false)
  assert.equal(reach.sees(pay), true)
  assert.equal(reach.sees(nb), false)
})

test('approvers, managers and operations teams count as owners; so does a person named there', () => {
  assert.equal(catalogReach(accessWith(['nb-approvers'])).sees(nb), true)
  assert.equal(catalogReach(accessWith(['OPS'])).sees(nb), true)
  assert.equal(catalogReach({ ...accessWith([]), uid: 'Erin' }).sees(nb), true)
})

test('a binding scoped to a team or a project reaches what it is scoped to', () => {
  assert.equal(catalogReach(accessWith([], binding('team-lead', 'team', 'nbteam'))).sees(nb), true)
  assert.equal(catalogReach(accessWith([], binding('project-viewer', 'project', 'nfp'))).sees(nb), true)
  assert.equal(catalogReach(accessWith([], binding('project-viewer', 'project', 'nfp'))).sees(pay), false)
})

test('catalog.view_all everywhere sees every system', () => {
  for (const role of ['project-viewer', 'approver', 'devops-admin']) {
    const reach = catalogReach(accessWith([], binding(role)))
    assert.equal(reach.all, true, role)
    assert.equal(reach.sees(nb), true, role)
  }
})
