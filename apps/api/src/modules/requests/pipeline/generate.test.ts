// The generator against what the old new_applications.py wrote: the
// inventory file, the namespaces, and each technology's patches. Checked
// byte for byte against the Python when ported; these pin it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PipelineSpec } from '@eidp/contracts/requests'
import { TECHNOLOGIES } from './definitions.ts'
import { applicationFiles, inventoryFile, namespaceFile, teamYml } from './generate.ts'
import type { PipelineContext } from './technologies.ts'
import { setKey, setNested } from './yaml-edit.ts'

const ctx = (spec: Partial<PipelineSpec>): PipelineContext => ({
  spec: { application: 'Billing_Api', deployTarget: 'OCP', technology: '', version: null, library: false, fields: {}, newProject: null, ...spec },
  system: 'Billing',
  manifestsDir: 'Billing',
  collection: 'DefaultCollection',
  project: 'Billing',
  repository: 'billing-api',
  repositoryUrl: '',
  requestedBy: { uid: 'bob', name: 'Bob' },
})
const files = (key: string, spec: Partial<PipelineSpec>, templates: Record<string, string>) =>
  Object.fromEntries(
    applicationFiles(key, TECHNOLOGIES[key]!, ctx({ technology: key, ...spec }), Object.entries(templates).map(([path, content]) => ({ path, content }))).map((f) => [f.path, f.content]),
  )

test('the inventory file: OCP without preprod, K8s with it, a database on localhost', () => {
  assert.equal(
    inventoryFile('a', 'OCP', false),
    'all:\n  children:\n    a:\n      children:\n        dev_a:\n          hosts:\n            dev_ocp:\n\n        qc_a:\n          hosts:\n            qc_ocp:\n\n        uat_a:\n          hosts:\n            uat_ocp:\n\n        prd_a:\n          hosts:\n            prd_ocp:\n            prd_dr_ocp:\n',
  )
  assert.match(inventoryFile('a', 'K8s', false), /preprod_a:\n {10}hosts:\n {12}preprod_k8s:\n\n/)
  assert.doesNotMatch(inventoryFile('a', 'K8s', true), /k8s|ocp|preprod/)
})

test('a namespace: the cluster by environment, a placeholder for what is not given', () => {
  assert.deepEqual(namespaceFile('S', 'prd_dr', { name: 'pay-prd', user: null }, 'OCP'), {
    path: 'S/host_vars/prd_dr_ocp/vars.yml',
    content: 'cluster_type: DR\n\nocp_namespace:\n  name: pay-prd\n  user: changeme\n  token: changeme\n',
  })
  assert.equal(namespaceFile('S', 'preprod', { name: 'p', user: 'u' }, 'K8s').content, 'cluster_type: HQ\n\nk8s_namespace:\n  name: p\n  user: u\n  token:\n')
})

test('setKey and setNested touch one line and keep the rest, quotes included', () => {
  assert.equal(setKey('a: 1\nb: 2\n', 'b', '3'), 'a: 1\nb: 3\n')
  assert.equal(setKey('a: 1\n  b: 2\n', 'b', '3'), 'a: 1\n  b: 2\n', 'top level only')
  assert.equal(setKey('a: 1\n\n', 'b', '"x"', { append: true }), 'a: 1\nb: "x"\n')
  assert.equal(setNested('img:\n  tag: "1"\nother:\n  tag: 2\n', 'img', 'tag', '9'), 'img:\n  tag: "9"\nother:\n  tag: 2\n')
  assert.equal(setNested('img:\n  name: x\nother:\n  tag: 2\n', 'img', 'tag', '9'), 'img:\n  name: x\nother:\n  tag: 2\n', 'not found in its block')
})

test('Maven: artifact and group set, group_path follows group_id, the image tags from the version', () => {
  const out = files('Maven_InContainer', { version: '21', fields: { artifact_id: 'billing', group_id: 'eg.efinance.billing' } }, {
    'Spring.yml': 'artifact_id: old\ngroup_id: old.group\ngroup_path: old/group\nbuild_image:\n  tag: x\ndeploy_image:\n  tag: "y"\n',
    'cicd.yml': 'repository_name: __APPLICATION__\n',
  })
  assert.equal(
    out['Billing/group_vars/Billing_Api/Spring.yml'],
    'artifact_id: billing\ngroup_id: eg.efinance.billing\ngroup_path: eg.efinance.billing\nbuild_image:\n  tag: 3-eclipse-temurin-21\ndeploy_image:\n  tag: "21-alpine"\n',
  )
  assert.equal(out['Billing/group_vars/Billing_Api/cicd.yml'], 'repository_name: billing-api\n', 'the repository, not the application name')
})

test('a library: nothing deployed', () => {
  const out = files('PHP_Laravel', { version: '8.2-apache', library: true }, { 'cicd.yml': 'deploy_technology: OCP\ndeploy_platform: OCP\napp_type: App\n' })
  assert.equal(out['Billing/group_vars/Billing_Api/cicd.yml'], 'deploy_technology: None\ndeploy_platform: None\napp_type: Lib\n')
})

test('the reverse proxy’s Dockerfile follows the deploy target; NPM’s ocp_resources.yml is written as defined', () => {
  assert.match(files('Tag_Nginx_RP', { deployTarget: 'K8s', version: 'alpine-slim' }, { 'cicd.yml': 'a: 1\n' })['Billing/group_vars/Billing_Api/cicd.yml']!, /^dockerfile_name: "Dockerfile_RP_k8s"$/m)
  const npm = files('NPM_InContainer', { version: '22' }, { 'cicd.yml': 'a: 1\n', 'ocp_resources.yml': 'replicas: 9\n' })
  assert.match(npm['Billing/group_vars/Billing_Api/ocp_resources.yml']!, /^replicas: 1$/m)
})

test('team.yml: the old order, DEVOPS where a list must not be empty, and the answer given for auto-deploy', () => {
  const yml = teamYml({ company: 'eFinance', devTeam: 'DEVdotNET', qcTeam: 'QC', uatTeam: 'UAT', prdTeam: 'OPS', automaticDeployToQc: true, devTeamList: [], opsTeamList: [], prdOnly: [], prdApprovers: ['lead'], projectManagers: [] })
  assert.equal(
    yml,
    'company: eFinance\nautomatic_deploy_to_qc: "true"\ndev_team: DEVdotNET\nqc_team: QC\nuat_team: UAT\nprd_team: OPS\ndev_team_list:\n  -\nops_team_list:\n  - DEVOPS\nprd_approvers:\n  - lead\nprd_only:\n  - DEVOPS\nproject_managers:\n  - DEVOPS\n',
  )
})
