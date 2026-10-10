import assert from 'node:assert/strict'
import { test } from 'node:test'
import { levelOf, similar } from './risk.ts'

test('names that differ in case, punctuation, a suffix or a typo are similar', () => {
  assert.ok(similar('loan-scoring', 'Loan_Scoring'))
  assert.ok(similar('loan-scoring', 'loan-scoring-v2'))
  assert.ok(similar('loan-scoring-api', 'loan-scorinq-api'))
  assert.ok(similar('Payments Platform', 'payments_platform'))
})

test('names that merely share a word are not', () => {
  assert.ok(!similar('loan-scoring', 'loan-origination'))
  assert.ok(!similar('api', 'agriland-api'))
  assert.ok(!similar('web', 'wed'))
})

test('the level is the count of cautions, and nothing else', () => {
  const info = { level: 'info' as const, text: 'x' }
  const caution = { level: 'caution' as const, text: 'x' }
  assert.equal(levelOf([info, info]), 'low')
  assert.equal(levelOf([info, caution]), 'medium')
  assert.equal(levelOf([caution, caution, info]), 'high')
})
