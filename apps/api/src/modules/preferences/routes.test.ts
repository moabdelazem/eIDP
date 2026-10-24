// Each person's own preferences, through the API: what they save is theirs,
// read back as saved, and nobody else's. Needs Postgres and LDAP.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createApp } from '../../app.ts'
import { closeDb, migrate, query } from '../../lib/db.ts'

const app = createApp()
const tokens: Record<string, string> = {}
// alice's and bob's own preferences in the shared dev database, put back as they were afterwards.
let kept: { uid: string; name: string; value: unknown; updated_at: Date }[] = []

function call(who: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

before(async () => {
  await migrate()
  for (const who of ['alice', 'bob']) {
    const res = await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: who, password: `${who}pw` }) })
    tokens[who] = ((await res.json()) as { token: string }).token
  }
  kept = (await query(`select * from user_preferences where uid in ('alice', 'bob')`)).rows as typeof kept
  await query(`delete from user_preferences where uid in ('alice', 'bob')`)
})

after(async () => {
  await query(`delete from user_preferences where uid in ('alice', 'bob')`)
  for (const row of kept) {
    await query('insert into user_preferences (uid, name, value, updated_at) values ($1, $2, $3, $4)', [row.uid, row.name, JSON.stringify(row.value), row.updated_at])
  }
  await closeDb()
})

test('nothing saved reads as no layout, so the page uses its own', async () => {
  const res = await call('bob', 'GET', '/preferences/overview')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { layout: null, updatedAt: null })
  assert.equal((await app.request('/preferences/overview')).status, 401, 'signed in only')
})

test('a saved layout is read back as saved, each card once, and is only that person’s', async () => {
  const saved = await call('bob', 'PUT', '/preferences/overview', { order: ['pipelines', 'needs-you', 'pipelines', 'requests'], hidden: ['catalog'] })
  assert.equal(saved.status, 200)
  const back = (await (await call('bob', 'GET', '/preferences/overview')).json()) as { layout: unknown; updatedAt: string }
  assert.deepEqual(back.layout, { order: ['pipelines', 'needs-you', 'requests'], hidden: ['catalog'] })
  assert.ok(back.updatedAt)
  assert.deepEqual(await (await call('alice', 'GET', '/preferences/overview')).json(), { layout: null, updatedAt: null }, 'alice has her own, not bob’s')

  // Saving again replaces it.
  await call('bob', 'PUT', '/preferences/overview', { order: ['requests'], hidden: [] })
  assert.deepEqual(((await (await call('bob', 'GET', '/preferences/overview')).json()) as { layout: unknown }).layout, { order: ['requests'], hidden: [] })
})

test('a layout must be card names; reset goes back to the portal’s own', async () => {
  for (const bad of [{ order: ['<script>'], hidden: [] }, { order: 'pipelines', hidden: [] }, { order: Array.from({ length: 41 }, (_, i) => `c-${'x'.repeat(i % 5)}`), hidden: [] }]) {
    const res = await call('bob', 'PUT', '/preferences/overview', bad)
    assert.equal(res.status, 400)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code !== undefined, true)
  }
  assert.equal((await call('bob', 'DELETE', '/preferences/overview')).status, 204)
  assert.deepEqual(await (await call('bob', 'GET', '/preferences/overview')).json(), { layout: null, updatedAt: null })
})

test('the theme and colours are kept with the person, checked, and read back by them alone', async () => {
  assert.deepEqual(await (await call('alice', 'GET', '/preferences/appearance')).json(), { appearance: null, updatedAt: null })
  const saved = await call('alice', 'PUT', '/preferences/appearance', { theme: 'dark', palette: 'efinance' })
  assert.equal(saved.status, 200)
  const back = (await (await call('alice', 'GET', '/preferences/appearance')).json()) as { appearance: unknown; updatedAt: string }
  assert.deepEqual(back.appearance, { theme: 'dark', palette: 'efinance' })
  assert.ok(back.updatedAt)
  // Changed, it is replaced; bob's is still his own (none).
  await call('alice', 'PUT', '/preferences/appearance', { theme: 'light', palette: 'classic' })
  assert.deepEqual(((await (await call('alice', 'GET', '/preferences/appearance')).json()) as { appearance: unknown }).appearance, { theme: 'light', palette: 'classic' })
  assert.deepEqual(((await (await call('bob', 'GET', '/preferences/appearance')).json()) as { appearance: unknown }).appearance, null)
  // The Overview layout beside it is untouched.
  assert.deepEqual(((await (await call('alice', 'GET', '/preferences/overview')).json()) as { layout: unknown }).layout, null)
  for (const body of [{ theme: 'blue', palette: 'classic' }, { theme: 'dark', palette: 'neon' }, { theme: 'dark' }]) {
    assert.equal((await call('alice', 'PUT', '/preferences/appearance', body)).status, 400, JSON.stringify(body))
  }
})
