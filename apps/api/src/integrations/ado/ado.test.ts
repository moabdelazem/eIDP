import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adoConfig, apiUrl, authHeader } from './client.ts'

const ado = { baseUrl: 'https://tfs.example.com/tfs/DefaultCollection', pat: 'tok', apiVersion: '6.0' }

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
