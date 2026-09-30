import assert from 'node:assert/strict'
import { test } from 'node:test'
import { excerpt, logLines, redact } from './build-explainer.ts'

test('credentials in URLs, auth headers and secret assignments are redacted', () => {
  assert.equal(redact('git fetch https://deploy:s3cr3t@git.example.com/a.git'), 'git fetch https://[hidden]@git.example.com/a.git')
  assert.equal(redact('curl -H "Authorization: Bearer abc.def.ghi" x'), 'curl -H "Authorization: Bearer [hidden]" x')
  assert.equal(redact('export DB_PASSWORD=hunter2'), 'export DB_PASSWORD=[hidden]')
  assert.equal(redact('api_key: "sk-123456"'), 'api_key: "[hidden]"')
  assert.equal(redact('mvn deploy --password hunter2 -q'), 'mvn deploy --password [hidden] -q')
  assert.equal(redact('using AKIAABCDEFGHIJKLMNOP now'), 'using [hidden] now')
  assert.equal(redact('token eyJhbGciOi.eyJzdWIiOi.c2ln here'), 'token [hidden] here')
  assert.equal(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----'), '[hidden private key]')
})

test('prose that merely mentions a secret word is left alone', () => {
  assert.equal(redact('The token expired at 10:00'), 'The token expired at 10:00')
  assert.equal(redact('Tests run: 42, Failures: 3'), 'Tests run: 42, Failures: 3')
  assert.equal(redact('passwordless login enabled'), 'passwordless login enabled')
})

test('ANSI colour codes are gone and lines are numbered from 1, as the page numbers them', () => {
  assert.deepEqual(logLines('\x1b[31mERROR\x1b[0m one\ntwo\n'), ['ERROR one', 'two'])
})

const log = (n: number, errors: Record<number, string>) =>
  Array.from({ length: n }, (_, i) => errors[i + 1] ?? `[INFO] step ${i + 1}`)

test('the excerpt keeps each error with its context, the stage headings and the end', () => {
  const lines = log(300, { 5: '[Pipeline] { (Build)', 100: '[Pipeline] { (Test)', 150: '[ERROR] Test failed: scoring', 300: 'Finished: FAILURE' })
  const { text, shown, trimmed } = excerpt(lines, 100_000)
  for (const n of [5, 100, 144, 150, 153, 271, 300]) assert.ok(shown.has(n), `line ${n}`)
  assert.ok(!shown.has(50) && !shown.has(200))
  assert.match(text, /^150: \[ERROR\] Test failed: scoring$/m)
  assert.match(text, /… \(\d+ lines not shown\)/)
  // Leaving out ordinary lines is the point; nothing worth reading was dropped.
  assert.equal(trimmed, false)
})

test('a log with no error line is read from its end', () => {
  const { shown } = excerpt(log(500, {}), 100_000)
  assert.ok(shown.has(500) && shown.has(381) && !shown.has(380))
})

test('when the budget is tight, the first error and the end win over errors in between', () => {
  const errors: Record<number, string> = { 1000: 'Finished: FAILURE' }
  for (const n of [100, 300, 500, 700, 900]) errors[n] = `[ERROR] failure number ${n}`
  const lines = log(1000, errors)
  const { shown } = excerpt(lines, 1_300)
  assert.ok(shown.has(100), 'the first error')
  assert.ok(shown.has(1000), 'the end')
  assert.ok(shown.has(900), 'then the error nearest the end')
  assert.ok(!shown.has(300), 'an error in between is dropped first')
  assert.equal(excerpt(lines, 1_300).trimmed, true)
})

test('secrets are redacted inside the excerpt, and every line is capped', () => {
  const lines = log(20, { 10: 'ERROR: push to https://ci:hunter2@repo.example.com failed', 12: `x${'y'.repeat(2000)}` })
  const { text } = excerpt(lines, 100_000)
  assert.ok(!text.includes('hunter2'))
  assert.ok(text.split('\n').every((line) => line.length <= 420))
})
