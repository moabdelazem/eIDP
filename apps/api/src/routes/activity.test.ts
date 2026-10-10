// Platform activity end to end: real LDAP for who signs in, real Postgres for
// what is recorded. Other test files sign in at the same time, so every check
// here looks for its own lines rather than counting everything.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createApp } from '../app.ts'
import { closeDb, migrate, query } from '../lib/db.ts'
import { cleanPath, sectionOf } from '../services/activity.ts'

const app = createApp()
const tokens: Record<string, string> = {}
const NOBODY = 'activity-test-nobody'
let eventFloor = 0
let jenkinsFloor = 0
let auditFloor = 0

async function login(username: string, password: string) {
  return app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
}

function call(token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function json<T = Record<string, any>>(res: Response): Promise<T> {
  assert.ok(res.ok, `${res.status}: ${await res.clone().text()}`)
  return (await res.json()) as T
}

const maxId = async (table: string) => Number((await query<{ max: string | null }>(`select max(id) from ${table}`)).rows[0]?.max ?? 0)

before(async () => {
  await migrate()
  ;[eventFloor, jenkinsFloor, auditFloor] = await Promise.all([maxId('activity_events'), maxId('jenkins_audit'), maxId('rbac_audit')])
  for (const who of ['alice', 'bob']) tokens[who] = ((await json(await login(who, `${who}pw`))) as { token: string }).token
})

after(async () => {
  // Ours, and whatever the files beside us signed in meanwhile — test noise either way.
  await query('delete from activity_events where id > $1', [eventFloor])
  await query('delete from jenkins_audit where id > $1', [jenkinsFloor])
  await query(`delete from rbac_audit where id > $1 and action = 'assume' and actor = 'alice' and target = 'dave'`, [auditFloor])
  await closeDb()
})

test('a sign-in is recorded, and so is a refused one — with the name typed and why, never the password', async () => {
  const signedIn = (await json<{ items: any[] }>(await call(tokens.alice!, 'GET', '/activity/feed?window=24h&who=bob&group=sign-in'))).items
  assert.ok(signedIn.some((e) => e.kind === 'sign_in' && e.verb === 'signed in'))

  assert.equal((await login(NOBODY, 'hunter2-not-a-password')).status, 401)
  const refused = (await json<{ items: any[] }>(await call(tokens.alice!, 'GET', `/activity/feed?window=24h&who=${NOBODY}`))).items
  assert.equal(refused[0].kind, 'sign_in_failed')
  assert.equal(refused[0].ok, false)
  assert.equal(refused[0].note, 'wrong name or password')

  const { rows } = await query('select * from activity_events where id > $1 and uid = $2', [eventFloor, NOBODY])
  assert.ok(!JSON.stringify(rows).includes('hunter2'), 'the password is stored nowhere')
})

test('five refusals of one name in the window are called out', async () => {
  for (let i = 0; i < 4; i++) await login(NOBODY, 'still-wrong')
  const { refused } = await json<{ refused: any[] }>(await call(tokens.alice!, 'GET', '/activity/overview?window=24h'))
  const flagged = refused.find((r) => r.uid === NOBODY)
  assert.ok(flagged, 'the name is flagged')
  assert.ok(flagged.count >= 5)
  assert.deepEqual(flagged.reasons, ['wrong name or password'])
})

test('a page opened is kept as its path alone, once per half minute, in its part of the portal', async () => {
  for (let i = 0; i < 3; i++) {
    const res = await call(tokens.bob!, 'POST', '/activity/visit', { path: '/pipelines?q=private-search#x' })
    assert.equal(res.status, 204)
  }
  const { rows } = await query<{ path: string; section: string }>(`select path, section from activity_events where id > $1 and uid = 'bob' and kind = 'visit'`, [eventFloor])
  assert.deepEqual(rows, [{ path: '/pipelines', section: 'My pipelines' }])
  assert.equal((await call(tokens.bob!, 'POST', '/activity/visit', { path: 'https://elsewhere.example.com/' })).status, 400)

  const { sections } = await json<{ sections: any[] }>(await call(tokens.alice!, 'GET', '/activity/overview?window=24h'))
  assert.ok(sections.find((s) => s.label === 'My pipelines')?.value >= 1)
  // Visits count, but are not lines in the feed.
  assert.ok((await json<{ items: any[] }>(await call(tokens.alice!, 'GET', '/activity/feed?window=24h&who=bob'))).items.every((e) => e.kind !== 'visit'))

  const bob = (await json<any[]>(await call(tokens.alice!, 'GET', '/activity/people?window=24h'))).find((p) => p.uid === 'bob')
  assert.ok(bob.visits >= 1)
  assert.equal(bob.topSection, 'My pipelines')
})

test('what an admin looks at while viewing as someone is never put down to them', async () => {
  const { token } = await json<{ token: string }>(await call(tokens.alice!, 'POST', '/auth/assume', { uid: 'dave' }))
  const res = await call(token, 'POST', '/activity/visit', { path: '/' })
  assert.equal(res.status, 403)
  const { rows } = await query(`select 1 from activity_events where id > $1 and uid = 'dave' and kind = 'visit'`, [eventFloor])
  assert.equal(rows.length, 0)
})

test('Jenkins actions read as sentences that lead to the build, and a refused one says it was tried', async () => {
  await query(
    `insert into jenkins_audit (actor, actor_name, action, job, build, ok, error) values
       ('alice', 'Alice Example', 'rebuild', 'payments/loan-api', 7, true, null),
       ('alice', 'Alice Example', 'stop', 'payments/loan-api', 8, false, 'Jenkins said no')`,
  )
  const { items } = await json<{ items: any[] }>(await call(tokens.alice!, 'GET', '/activity/feed?window=24h&who=alice&group=jenkins'))
  const [stop, rebuild] = items
  assert.equal(stop.verb, 'tried to stop')
  assert.equal(stop.ok, false)
  assert.equal(stop.note, 'Jenkins said no')
  assert.equal(rebuild.verb, 'ran again')
  assert.equal(rebuild.target, 'payments/loan-api #7')
  assert.equal(rebuild.link, '/jenkins/build?job=payments%2Floan-api&number=7')

  // Words narrow it; LIKE's wildcards are only characters.
  assert.equal((await json<{ items: any[] }>(await call(tokens.alice!, 'GET', '/activity/feed?window=24h&who=alice&group=jenkins&q=loan-api%20%237'))).items.length, 0)
  assert.equal((await json<{ items: any[] }>(await call(tokens.alice!, 'GET', '/activity/feed?window=24h&who=alice&group=jenkins&q=said%20no'))).items.length, 1)
  assert.equal((await json<{ items: any[] }>(await call(tokens.alice!, 'GET', '/activity/feed?window=24h&who=alice&group=jenkins&q=%25'))).items.length, 0)
})

test('the overview counts this window against the one before', async () => {
  const body = await json<any>(await call(tokens.alice!, 'GET', '/activity/overview?window=7d'))
  assert.ok(body.totals.people.now >= 2)
  assert.ok(body.totals.signIns.now >= 2)
  assert.equal(typeof body.totals.signIns.before, 'number')
  // A day per bar over a week: seven or eight of them, depending on the hour.
  assert.ok(body.series.length >= 7 && body.series.length <= 8)
  assert.ok(body.series.at(-1).people >= 2)
})

test('only DevOps read it; anyone signed in reports a page', async () => {
  for (const path of ['/activity/overview', '/activity/feed', '/activity/people']) {
    assert.equal((await call(tokens.bob!, 'GET', path)).status, 403)
  }
})

test('paths are cleaned and put in their part of the portal', () => {
  assert.equal(cleanPath('/jenkins/build?job=a&number=1'), '/jenkins/build')
  assert.equal(cleanPath('//requests//new'), '/requests/new')
  assert.equal(sectionOf('/requests/new/azure-devops/project'), 'New request')
  assert.equal(sectionOf('/requests/0b6c…'), 'My requests')
  assert.equal(sectionOf('/projects/loan-api'), 'Projects map')
  assert.equal(sectionOf('/'), 'Overview')
  assert.equal(sectionOf('/nowhere'), 'Other')
})
