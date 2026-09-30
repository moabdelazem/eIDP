import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apiUrl, authHeader, errorDetail, jiraConfig } from './client.ts'
import { jiraKeyProblem, jiraNameProblem } from '../../services/request-rules.ts'

test('a personal access token is a Bearer token', () => {
  assert.equal(authHeader('tok'), 'Bearer tok')
})

test('with a username, the token is sent as its password', () => {
  assert.equal(authHeader('tok', 'svc-eidp'), `Basic ${Buffer.from('svc-eidp:tok').toString('base64')}`)
})

test('urls are v2 under /rest/api, with query parameters encoded', () => {
  assert.equal(
    apiUrl('https://jira.example.com/jira', 'groups/picker', { query: 'Payments Team', maxResults: 100 }),
    'https://jira.example.com/jira/rest/api/2/groups/picker?query=Payments+Team&maxResults=100',
  )
})

test('both halves of Jira’s error collection are read', () => {
  assert.equal(
    errorDetail({ errorMessages: ['No.'], errors: { projectKey: 'Key taken.', projectLead: 'No such lead.' } }),
    'No. Key taken. No such lead.',
  )
  assert.equal(errorDetail('<html>'), '')
})

test('missing settings are named', () => {
  // The unit tests run without JIRA_* set, which is the case we want.
  if (process.env.JIRA_BASE_URL) return
  assert.throws(jiraConfig, /JIRA_BASE_URL and JIRA_TOKEN/)
})

test('keys are caught locally only where every Jira agrees', () => {
  assert.equal(jiraKeyProblem('PAY'), null)
  assert.equal(jiraKeyProblem('PAY2'), null) // a server may allow digits; it decides
  assert.match(jiraKeyProblem('pay')!, /uppercase letter/)
  assert.match(jiraKeyProblem('2PAY')!, /uppercase letter/)
  assert.match(jiraKeyProblem('PA-Y')!, /letters and digits/)
  assert.match(jiraKeyProblem('P')!, /two characters/)
})

test('names are trimmed and bounded', () => {
  assert.equal(jiraNameProblem('Loan Scoring'), null)
  assert.match(jiraNameProblem(' Loan')!, /space/)
  assert.match(jiraNameProblem('x'.repeat(81))!, /at most 80/)
})
