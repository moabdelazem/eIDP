// What a pipeline's files may carry: a credential copied from the reference
// application stops the write; a placeholder, an expression or a vaulted value
// does not.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { credentialsIn } from './files.ts'

test('a literal credential is found by its key, whatever the quoting or nesting', () => {
  const yaml = ['db:', '  password: s3cret', "api_key: 'abc'", '  - token: "t"', 'connection_string: |', 'name: app'].join('\n')
  assert.deepEqual(credentialsIn(yaml), ['password', 'api_key', 'token', 'connection_string'])
})

test('placeholders, expressions, vaulted and empty values are not credentials', () => {
  const yaml = ['token: changeme', 'password: "{{ vault_db_password }}"', 'secret: !vault |', 'api_key:', 'pwd: ~', 'private_key: null'].join('\n')
  assert.deepEqual(credentialsIn(yaml), [])
})
