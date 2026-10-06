// schema.sql runs top to bottom on every start, against a database that
// already holds rows of every kind the portal has ever written. A step that
// narrows a constraint, even one a later step widens again, refuses to boot
// once such a row exists — which is how a Jira request once stopped the API
// coming back up. Needs the postgres container.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { closeDb, ensureSchema, query } from './db.ts'

const made: { requests: string[]; audit: string[] } = { requests: [], audit: [] }

after(async () => {
  if (made.requests.length) await query('delete from requests where id = any($1::uuid[])', [made.requests])
  if (made.audit.length) await query('delete from rbac_audit where id = any($1::bigint[])', [made.audit])
  await closeDb()
})

test('the schema applies again over rows of the newest kinds', async () => {
  await ensureSchema()
  const jira = await query<{ id: string }>(
    `insert into requests (kind, project, project_key, justification, requested_by, requested_by_name)
     values ('create_jira_project', $1, $2, 'schema test', 'schema-test', 'Schema test') returning id`,
    [`Schema Test ${Date.now()}`, `ST${Date.now() % 100000}`],
  )
  made.requests.push(jira.rows[0]!.id)
  const update = await query<{ id: string }>(
    `insert into rbac_audit (actor, action, binding, previous) values ('schema-test', 'update', '{}'::jsonb, '{}'::jsonb) returning id`,
  )
  made.audit.push(update.rows[0]!.id)

  await ensureSchema()
  await ensureSchema()
  assert.ok(true, 'it booted twice over them')
})
