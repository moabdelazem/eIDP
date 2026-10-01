// Reading who Jenkins lets see which job, from both strategies the portal
// understands. The fake states one rule set two ways, so both must agree.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import { serve } from '@hono/node-server'
import { createFakeJenkins } from './fake-server.ts'

const fake = createFakeJenkins()
const server = serve({ fetch: fake.app.fetch, port: 0 })
await new Promise((resolve) => server.once('listening', resolve))
process.env.JENKINS_URL = `http://localhost:${(server.address() as AddressInfo).port}/jenkins`
process.env.JENKINS_USER = 'eidp'
process.env.JENKINS_TOKEN = 'fake'

const { parseMatrix, readAccess } = await import('./access.ts')

after(() => server.close())

const READ = 'hudson.model.Item.Read'

test('every matrix spelling is read, and only Job/Read counts', () => {
  const xml = `<project><properties><hudson.security.AuthorizationMatrixProperty>
    <permission>${READ}:carol</permission>
    <permission>GROUP:${READ}:Payments</permission>
    <permission>USER:${READ}:bob</permission>
    <permission>GROUP:hudson.model.Item.Build:Builders</permission>
    <entry><group><name>DEV&amp;OPS</name><permission>${READ}</permission></group></entry>
    <entry><user><name>erin</name><permission>hudson.model.Item.Build</permission></user></entry>
    <entry><userOrGroup><name>frank</name><permission>${READ}</permission></userOrGroup></entry>
  </hudson.security.AuthorizationMatrixProperty></properties></project>`
  const matrix = parseMatrix(xml)!
  assert.equal(matrix.inherits, true)
  assert.deepEqual(new Set(matrix.read.map((r) => `${r.sidType}:${r.sid}`)), new Set(['either:carol', 'group:Payments', 'user:bob', 'group:DEV&OPS', 'either:frank']))
})

test('grants to everyone name no team and are dropped; a job that stops inheriting says so', () => {
  const matrix = parseMatrix(`<x><hudson.security.AuthorizationMatrixProperty>
    <inheritanceStrategy class="org.jenkinsci.plugins.matrixauth.inheritance.NonInheritingStrategy"/>
    <permission>GROUP:${READ}:authenticated</permission><permission>${READ}:anonymous</permission>
  </hudson.security.AuthorizationMatrixProperty></x>`)!
  assert.equal(matrix.inherits, false)
  assert.deepEqual(matrix.read, [])
  assert.equal(parseMatrix('<project><properties/></project>'), null)
})

/** The rules as "job ← sid" lines, for comparing strategies. */
async function rules() {
  const read = await readAccess()
  return { source: read.source, warnings: read.warnings, lines: new Set(read.grants.map((g) => `${g.job} <- ${g.sidType === 'user' ? 'user ' : ''}${g.sid}`)) }
}

const EXPECTED = new Set([
  'payments/loan-scoring-api <- Payments',
  'payments/payments-web <- Payments',
  'payments/loan-scoring-api <- DEVOPS',
  'payments/payments-web <- DEVOPS',
  'payments/deploy-prod <- DEVOPS',
  'agriland-api/main <- user dave',
  'agriland-api/feature%2Fscoring <- user dave',
])

test('the role-based strategy: patterns over full names, Read only, everyone dropped', async () => {
  fake.setAccess('role-strategy')
  const read = await rules()
  assert.equal(read.source, 'role-strategy')
  assert.deepEqual(read.lines, EXPECTED)
  assert.deepEqual(read.warnings, [])
})

test('matrix grants flow down folders, and stop where a job stops inheriting', async () => {
  fake.setAccess('matrix')
  const read = await rules()
  assert.equal(read.source, 'matrix')
  // deploy-prod sits in payments but keeps only its own grant: DEVOPS.
  assert.deepEqual(read.lines, EXPECTED)
  assert.ok(fake.configReads.includes('payments'), 'folders are read, not only jobs')
})

test('a Jenkins with neither has no rules, and says so', async () => {
  fake.setAccess('none')
  const read = await rules()
  assert.equal(read.source, 'none')
  assert.equal(read.lines.size, 0)
})
