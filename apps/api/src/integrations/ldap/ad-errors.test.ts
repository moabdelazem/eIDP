import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBindFailure } from './ad-errors.ts'

/** Real shape of an Active Directory bind rejection. */
const adError = (data: string) =>
  new Error(
    `80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data ${data}, v3839`,
  )

test('an expired password is named, not hidden behind a generic refusal', () => {
  const failure = readBindFailure(adError('532'))
  assert.equal(failure?.code, 'password_expired')
})

test('a locked account is named, so people stop retrying into a longer lockout', () => {
  assert.equal(readBindFailure(adError('775'))?.code, 'account_locked')
})

test('a disabled account is named', () => {
  assert.equal(readBindFailure(adError('533'))?.code, 'account_disabled')
})

test('a wrong password stays generic', () => {
  // 52e is "invalid credentials". Saying so is fine; saying 525 "no such user"
  // separately would let anyone test whether an account name exists.
  assert.equal(readBindFailure(adError('52e')), null)
})

test('an unknown user stays generic, so the form is not an account oracle', () => {
  assert.equal(readBindFailure(adError('525')), null)
})

test('the sub-code is matched case-insensitively', () => {
  assert.equal(readBindFailure(adError('52E')), null)
  assert.equal(readBindFailure(adError('775'))?.code, 'account_locked')
})

test('a non-AD error carries no sub-code and is left alone', () => {
  assert.equal(readBindFailure(new Error('Invalid Credentials')), null)
  assert.equal(readBindFailure('something else'), null)
})

test('a number that merely looks like a sub-code elsewhere is not read as one', () => {
  assert.equal(readBindFailure(new Error('connection reset after 532 ms')), null)
})
