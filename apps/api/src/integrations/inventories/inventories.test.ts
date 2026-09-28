import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parseInventories, splitEnvironment, type InventorySystem } from './parse.ts'

const root = fileURLToPath(new URL('./__fixtures__/repo', import.meta.url))
const { systems, warnings } = await parseInventories(root)
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

const agrilandApi = () => byDir('AgriLand').applications.find((a) => a.name === 'AgriLand-API')!

test('the technology file is read, not just cicd.yml', () => {
  // The images, ports, route and resources live in dotnet.yml. Reading
  // cicd.yml alone used to throw all of it away.
  const d = agrilandApi().descriptor as Record<string, any>
  assert.deepEqual(d.build_image, { name: 'dotnet/sdk', tag: '10.0' })
  assert.deepEqual(d.deploy_image, { name: 'dotnet/aspnet', tag: '10.0' })
  assert.equal(d.server.port, 8080)
  assert.equal(d.ocp_service.expose_nodeport, 30091)
  assert.equal(d.route.path, '/')
  assert.equal(d.resources.limits.memory, '2048Mi')
  assert.equal(d.nuget_name, 'GFN_Portal')
  // …while cicd.yml still supplies what only it has.
  assert.equal(agrilandApi().repository, 'agriland-api')
})

test('files merge in Ansible order: a later filename replaces an earlier one', () => {
  // dotnet.yml sorts after cicd.yml, so its replicas win.
  assert.equal(agrilandApi().descriptor.replicas, 1)
  // Spring.yml sorts BEFORE cicd.yml — capitals first, by code point, as
  // Python's sorted() does — so there cicd.yml wins.
  const nfp = byDir('NBFS').applications.find((a) => a.environment === null)!
  assert.equal(nfp.descriptor.replicas, 2)
  assert.equal((nfp.descriptor.server as { port: number }).port, 8081)
})

test('an environment override keeps its own values', () => {
  const prd = byDir('NBFS').applications.find((a) => a.environment === 'prd')!
  assert.equal(prd.descriptor.replicas, 3)
})

test('a duplicate key keeps the last value, as Ansible does, rather than failing', () => {
  assert.equal(agrilandApi().descriptor.jvm_hint, 'last')
})

test('a broken file is skipped and named, and the rest of the catalog still builds', () => {
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /^AgriLand\/group_vars\/AgriLand-API\/logging\.yml: /)
  // The same application is still there, with everything the good files held.
  assert.equal(agrilandApi().descriptor.nuget_name, 'GFN_Portal')
  assert.deepEqual(
    systems.map((s) => s.dir),
    ['AgriLand', 'NBFS'],
  )
})

test('secrets never leave the parser: plaintext passwords and inline vault values', () => {
  const d = agrilandApi().descriptor
  assert.equal(d.db_password, '[hidden]')
  // Without a !vault handler the ciphertext would be stored as the value.
  assert.equal(d.api_token, '[hidden]')
  assert.ok(!JSON.stringify(d).includes('ANSIBLE_VAULT'))
  assert.ok(!JSON.stringify(d).includes('hunter2'))
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
