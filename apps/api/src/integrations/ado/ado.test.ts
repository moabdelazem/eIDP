import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adoConfig, apiUrl, authHeader, isPreviewRefusal, splitCollection } from './client.ts'

const ado = {
  baseUrl: 'https://tfs.example.com/tfs/DefaultCollection',
  serverUrl: 'https://tfs.example.com/tfs',
  defaultCollection: 'DefaultCollection',
  pat: 'tok',
  apiVersion: '6.0',
}

test('a PAT authenticates as an empty username', () => {
  assert.equal(authHeader('tok'), `Basic ${Buffer.from(':tok').toString('base64')}`)
})

test('collection-scoped url carries the pinned api-version', () => {
  assert.equal(
    apiUrl(ado, 'projects'),
    'https://tfs.example.com/tfs/DefaultCollection/_apis/projects?api-version=6.0',
  )
})

test('project-scoped url puts the project before _apis', () => {
  assert.equal(
    apiUrl(ado, 'git/repositories', { project: 'ABE_LoanOriginationApp' }),
    'https://tfs.example.com/tfs/DefaultCollection/ABE_LoanOriginationApp/_apis/git/repositories?api-version=6.0',
  )
})

test('a project name with a space is encoded, not left raw', () => {
  assert.ok(apiUrl(ado, 'git/repositories', { project: 'Loan Origination' }).includes('Loan%20Origination'))
})

test('a trailing slash on the base url does not double up', () => {
  const url = apiUrl({ ...ado, baseUrl: 'https://tfs.example.com/tfs/Coll/' }, 'projects')
  assert.ok(!url.includes('//_apis'), url)
})

test('extra query parameters survive alongside api-version', () => {
  const url = apiUrl(ado, 'projects', { query: { $top: 1000 } })
  assert.ok(url.includes('api-version=6.0') && url.includes('%24top=1000'), url)
})

test('missing settings are named, not hidden behind a generic failure', () => {
  // Nothing sets ADO_* in the test environment, which is the case we want.
  assert.throws(adoConfig, (err: Error) => {
    assert.match(err.message, /ADO_BASE_URL and ADO_PAT/)
    return true
  })
})

test('the server and default collection are read off ADO_BASE_URL', () => {
  assert.deepEqual(splitCollection('https://tfs.example.com/tfs/DefaultCollection'), {
    serverUrl: 'https://tfs.example.com/tfs',
    defaultCollection: 'DefaultCollection',
  })
})

test('a collection at the root of the host still splits', () => {
  assert.deepEqual(splitCollection('https://tfs.example.com/EfinanceCollection/'), {
    serverUrl: 'https://tfs.example.com',
    defaultCollection: 'EfinanceCollection',
  })
})

test('ADO_SERVER_URL overrides the derived server', () => {
  assert.equal(
    splitCollection('https://tfs.example.com/tfs/Coll', 'https://other.example.com/tfs/').serverUrl,
    'https://other.example.com/tfs',
  )
})

test('server scope sits above every collection', () => {
  assert.equal(
    apiUrl(ado, 'projectCollections', { collection: null }),
    'https://tfs.example.com/tfs/_apis/projectCollections?api-version=6.0',
  )
})

test('a named collection replaces the default one', () => {
  assert.equal(
    apiUrl(ado, 'git/repositories', { collection: 'Other Coll', project: 'AgriLand' }),
    'https://tfs.example.com/tfs/Other%20Coll/AgriLand/_apis/git/repositories?api-version=6.0',
  )
})

test('a per-call api-version replaces the pinned one', () => {
  const url = new URL(apiUrl(ado, 'identities', { apiVersion: '6.0-preview' }))
  assert.equal(url.searchParams.get('api-version'), '6.0-preview')
})

test('the server refusing a preview API is recognised, and nothing else is', () => {
  assert.ok(isPreviewRefusal({ typeKey: 'VssInvalidPreviewVersionException', message: '' }))
  assert.ok(isPreviewRefusal({ message: 'The requested version "6.0" of the resource is under preview.' }))
  assert.ok(!isPreviewRefusal({ message: 'TF400948: A Git repository with the name x already exists.' }))
  assert.ok(!isPreviewRefusal(null))
})
