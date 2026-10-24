import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authHeader, errorReason, indexAllowed, indexNameProblem, parseIndices, scriptIn } from './client.ts'

test('an API key wins over a username and password', () => {
  assert.equal(authHeader({ apiKey: 'k', username: 'u', password: 'p' }), 'ApiKey k')
  assert.equal(authHeader({ username: 'u', password: 'p' }), `Basic ${Buffer.from('u:p').toString('base64')}`)
  assert.equal(authHeader({ username: 'u' }), null)
  assert.equal(authHeader({}), null)
})

test('the allowlist is names and * patterns, nothing else', () => {
  const allowed = parseIndices(' eidp-* , audit-2026 ,, ')
  assert.deepEqual(allowed, ['eidp-*', 'audit-2026'])
  assert.ok(indexAllowed('eidp-applications', allowed))
  assert.ok(indexAllowed('audit-2026', allowed))
  assert.ok(!indexAllowed('audit-2026x', allowed))
  assert.ok(!indexAllowed('xeidp-applications', allowed))
  // A dot in an entry is a dot, not "any character".
  assert.ok(!indexAllowed('logsx2026', ['logs.2026']))
  assert.ok(!indexAllowed('anything', []))
})

test('index names follow Elasticsearch’s rules, and are one concrete index', () => {
  assert.equal(indexNameProblem('eidp-applications'), null)
  assert.match(indexNameProblem('Eidp')!, /lowercase/)
  assert.match(indexNameProblem('eidp-*')!, /none of/)
  assert.match(indexNameProblem('a,b')!, /none of/)
  assert.match(indexNameProblem('remote:index')!, /none of/)
  assert.match(indexNameProblem('_all')!, /does not start/)
  assert.match(indexNameProblem('..')!, /not \. or \.\./)
  assert.match(indexNameProblem('x'.repeat(256))!, /255 bytes/)
  assert.match(indexNameProblem('')!, /needed/)
})

test('a script anywhere in a search body is found', () => {
  assert.equal(scriptIn({ match_all: {} }), null)
  assert.equal(scriptIn({ bool: { filter: [{ term: { a: 1 } }, { script: { script: 'x' } }] } }), 'script')
  assert.equal(scriptIn([{ _script: { type: 'number' } }, { runtime_mappings: {} }]), 'runtime_mappings')
  assert.equal(scriptIn({ function_score: { script_score: {} } }), 'script_score')
})

test('Elasticsearch’s error reason is read from its error shape', () => {
  assert.equal(errorReason({ error: { type: 't', reason: 'failed to parse' } }), 'failed to parse')
  assert.equal(errorReason({ error: { root_cause: [{ reason: 'root' }] } }), 'root')
  assert.equal(errorReason({ error: 'plain' }), 'plain')
  assert.equal(errorReason('<html>'), '')
})
