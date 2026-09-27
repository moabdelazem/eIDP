import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parseInventories, splitEnvironment, type InventorySystem } from './parse.ts'

const root = fileURLToPath(new URL('./__fixtures__/repo', import.meta.url))
const systems = await parseInventories(root)
const byDir = (dir: string): InventorySystem => {
  const found = systems.find((s) => s.dir === dir)
  assert.ok(found, `no system ${dir}`)
  return found
}

test('a directory without group_vars is not a system', () => {
  assert.deepEqual(
    systems.map((s) => s.dir),
    ['AgriLand', 'NBFS'],
  )
})

test('system metadata comes from group_vars/all/project.yml', () => {
  const agriland = byDir('AgriLand')
  assert.equal(agriland.projectName, 'AgriLand')
  assert.equal(agriland.company, 'eFinance')
  assert.deepEqual(agriland.teams, { dev: 'DEVdotNET', qc: 'QC', uat: 'DEVOPS', prd: 'DEVOPS' })
  assert.deepEqual(agriland.approvers, ['DEVOPS'])
  assert.deepEqual(byDir('NBFS').approvers, ['DEVOPS', 'SECURITY'])
})

test('an empty list written as a bare dash is empty, not one member', () => {
  // YAML reads `- ` with no value as [null]; taken at face value that is a team.
  assert.deepEqual(byDir('AgriLand').policy.dev_team_list, [null])
  assert.deepEqual(byDir('AgriLand').opsTeams, ['DEVOPS'])
  assert.deepEqual(byDir('NBFS').managers, [])
})

test('policy keeps the leftovers and drops what is modelled', () => {
  const policy = byDir('AgriLand').policy
  assert.equal(policy.qc_waittime, '1440')
  assert.equal(policy.project_name, undefined)
  assert.equal(policy.prd_team, undefined)
  assert.equal(policy.prd_approvers, undefined)
})

test('a flat system has no environment on its applications', () => {
  const apps = byDir('AgriLand').applications
  assert.deepEqual(
    apps.map((a) => a.name).sort(),
    ['AgriLand-API', 'AgriLand-Mobile'],
  )
  assert.ok(apps.every((a) => a.environment === null))
})

test('an env prefix marks an override of the base app, not a new app', () => {
  const apps = byDir('NBFS').applications
  assert.ok(apps.every((a) => a.name === 'nfp-backend'))
  // Compare as a set: Array.sort stringifies, so null would land after 'dev'.
  assert.deepEqual(new Set(apps.map((a) => a.environment)), new Set([null, 'dev', 'prd', 'prd_dr']))
  assert.equal(apps.length, 4)
})

test('prd_dr wins over prd, which is the longer-prefix trap', () => {
  assert.deepEqual(splitEnvironment('prd_dr_nfp-backend'), {
    environment: 'prd_dr',
    name: 'nfp-backend',
  })
  assert.deepEqual(splitEnvironment('prd_nfp-backend'), {
    environment: 'prd',
    name: 'nfp-backend',
  })
})

test('an app named after an environment word is not mistaken for a prefix', () => {
  assert.deepEqual(splitEnvironment('development-portal'), {
    environment: null,
    name: 'development-portal',
  })
})

test('cicd fields are typed, and quoted booleans are coerced', () => {
  const api = byDir('AgriLand').applications.find((a) => a.name === 'AgriLand-API')!
  assert.equal(api.repository, 'agriland-api')
  assert.equal(api.deployPlatform, 'OpenShift')
  assert.equal(api.microservice, true)
  const mobile = byDir('AgriLand').applications.find((a) => a.name === 'AgriLand-Mobile')!
  assert.equal(mobile.microservice, false)
})

test('unmodelled cicd fields survive in the descriptor', () => {
  const api = byDir('AgriLand').applications.find((a) => a.name === 'AgriLand-API')!
  assert.equal(api.descriptor.replicas, 2)
})

test('technologies come from filenames, deduped case- and separator-insensitively', () => {
  const api = byDir('AgriLand').applications.find((a) => a.name === 'AgriLand-API')!
  // dotnet and DotNetCore are different stacks and both survive; YAJSW/yajsw
  // are one; ocp_resources/ocp-resources are descriptors, not technologies.
  assert.deepEqual(api.technologies, ['dotnet', 'DotNetCore', 'YAJSW'])
})

test('shell scripts beside the descriptors are not technologies', () => {
  const api = byDir('AgriLand').applications.find((a) => a.name === 'AgriLand-API')!
  assert.ok(!api.technologies.some((t) => t.includes('getAll')))
})

test('a vault-encrypted file is skipped, not fed to the yaml parser', () => {
  const base = byDir('NBFS').applications.find((a) => a.environment === null)!
  assert.equal(base.repository, 'nfp-backend')
  assert.ok(!base.technologies.includes('vault'))
})
