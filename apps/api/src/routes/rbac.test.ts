// Who may do what. Needs the openldap and postgres containers: alice and carol
// are in DEVOPS, bob is in Payments only, dave is in no group at all — every
// binding here is made on dave, so the request tests running beside these
// never see bob's access change.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { sign } from 'hono/jwt'
import { createApp } from '../app.ts'
import { config } from '../lib/config.ts'
import { closeDb, ensureSchema, query } from '../lib/db.ts'
import { can, grantsOf, type Access, type Binding } from '../services/rbac.ts'
import { parseOldMap, planImport } from '../services/rbac-import.ts'

const app = createApp()

/**
 * Endpoints only DevOps reach. A new admin route belongs in this list; the
 * `requirePermission` guard on it is what makes these tests pass.
 */
const DEVOPS_ONLY: [method: string, path: string][] = [
  ['GET', '/requests/pool'],
  ['GET', '/requests/history'],
  ['POST', '/requests/00000000-0000-0000-0000-000000000000/approve'],
  ['POST', '/requests/00000000-0000-0000-0000-000000000000/reject'],
  ['POST', '/requests/00000000-0000-0000-0000-000000000000/retry'],
  ['POST', '/requests/00000000-0000-0000-0000-000000000000/assess'],
  ['POST', '/catalog/sync'],
  ['GET', '/rbac/roles'],
  ['GET', '/rbac/bindings'],
  ['POST', '/rbac/bindings'],
  ['DELETE', '/rbac/bindings/00000000-0000-0000-0000-000000000000'],
  ['GET', '/rbac/explain/bob'],
  ['GET', '/rbac/audit'],
  ['POST', '/auth/assume'],
  ['GET', '/jenkins'],
  ['GET', '/jenkins/run?job=x&number=1'],
  ['GET', '/jenkins/audit'],
  ['GET', '/jenkins/stats'],
  ['GET', '/jenkins/runs'],
  ['GET', '/jenkins/parameters'],
  ['POST', '/jenkins/sync'],
  ['GET', '/jenkins/explain?job=x&number=1'],
  ['POST', '/jenkins/explain'],
  ['POST', '/jenkins/rebuild'],
  ['POST', '/jenkins/stop'],
  ['POST', '/jenkins/queue/1/cancel'],
]

async function login(username: string): Promise<string> {
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: `${username}pw` }),
  })
  return ((await res.json()) as { token: string }).token
}

function call(token: string, method: string, path: string, body: unknown = method === 'GET' ? undefined : {}) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T

let bob = '', alice = '', dave = ''
const ids: string[] = []

/**
 * dave's bindings, and the audit rows these tests leave. The audit log is
 * append-only in the product; the tests share the dev database, and a real
 * log should not fill up with test noise.
 */
async function clearDave() {
  await query(`delete from rbac_bindings where lower(subject) = 'dave' and subject_type = 'user'`)
  await query(`delete from rbac_audit where lower(binding->>'subject') = 'dave' and binding->>'subjectType' = 'user'`)
  await query(`delete from rbac_audit where action = 'assume' and (actor = 'dave' or (actor = 'alice' and target = 'bob'))`)
}

/** A request row straight into the table — these tests are about who may decide it, not ADO. */
async function fileRequest(kind: 'grant_access' | 'create_repository', project: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `insert into requests (kind, collection, project, repository, justification, requested_by, requested_by_name, grantees, access_level)
     values ($1, 'DefaultCollection', $2, $3, 'rbac test', 'bob', 'Bob Example', $4, $5) returning id`,
    kind === 'grant_access'
      ? [kind, project, null, ['bob'], 'contribute']
      : [kind, project, `rbac-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, null, null],
  )
  ids.push(rows[0]!.id)
  return rows[0]!.id
}

before(async () => {
  await ensureSchema()
  await clearDave()
  ;[bob, alice, dave] = await Promise.all([login('bob'), login('alice'), login('dave')])
})

after(async () => {
  await clearDave()
  if (ids.length) await query('delete from requests where id = any($1)', [ids])
  await closeDb()
})

// ---- the DevOps surface ------------------------------------------------------

for (const [method, path] of DEVOPS_ONLY) {
  test(`${method} ${path} refuses someone outside DevOps`, async () => {
    const res = await call(bob, method, path)
    assert.equal(res.status, 403)
    assert.equal((await json<{ error: { code: string } }>(res)).error.code, 'forbidden')
  })

  test(`${method} ${path} lets DevOps through the guard`, async () => {
    // Past the guard it may still be 400, 404 or 503 — what matters is that
    // it is not a refusal.
    assert.notEqual((await call(alice, method, path)).status, 403)
  })
}

test('a token that claims the approver role grants nothing by itself', async () => {
  // Validly signed, but bob is not in DEVOPS. Access is worked out from the
  // directory and the bindings, so a stale or forged claim opens nothing.
  const forged = await sign(
    { sub: 'bob', name: 'Bob Example', mail: 'bob@eidp.local', roles: ['approver'], exp: Math.floor(Date.now() / 1000) + 600 },
    config.JWT_SECRET,
  )
  for (const [method, path] of DEVOPS_ONLY) {
    assert.equal((await call(forged, method, path)).status, 403, `${method} ${path}`)
  }
})

test('anyone signed in can still read the map and file requests', async () => {
  // Everyone is a member; locking these would break the product.
  assert.notEqual((await call(dave, 'GET', '/catalog/status')).status, 403)
  assert.notEqual((await call(dave, 'GET', '/requests/mine')).status, 403)
})

test('without a session, the admin surface is a 401, not a 403', async () => {
  for (const [method, path] of DEVOPS_ONLY) {
    assert.equal((await app.request(path, { method })).status, 401, `${method} ${path}`)
  }
})

// ---- what the profile says ---------------------------------------------------

test('the profile lists where each permission comes from', async () => {
  const profile = await json<{ isApprover: boolean; access: { roles: { role: string; via: string }[] } }>(
    await call(alice, 'GET', '/auth/profile'),
  )
  assert.equal(profile.isApprover, true)
  assert.ok(profile.access.roles.some((r) => r.role === 'devops-admin' && r.via === config.APPROVER_GROUP))
  assert.ok(profile.access.roles.some((r) => r.role === 'member'))

  const plain = await json<{ isApprover: boolean; access: { roles: { role: string }[] } }>(await call(dave, 'GET', '/auth/profile'))
  assert.equal(plain.isApprover, false)
  assert.deepEqual(plain.access.roles.map((r) => r.role), ['member'])
})

// ---- managing bindings -------------------------------------------------------

test('a binding is checked for sense before it is stored', async () => {
  const add = (body: Record<string, unknown>) => call(alice, 'POST', '/rbac/bindings', body)
  const base = { subjectType: 'user', subject: 'dave', role: 'approver', scopeType: 'global', reason: 'on call' }
  assert.equal((await add({ ...base, reason: '' })).status, 400, 'a grant to one person needs a reason')
  assert.equal((await add({ ...base, role: 'wizard' })).status, 400, 'no such role')
  assert.equal((await add({ ...base, role: 'member' })).status, 400, 'member is built in')
  assert.equal((await add({ ...base, subject: 'nobody-here' })).status, 400, 'unknown account')
  assert.equal((await add({ ...base, scopeType: 'team', scope: '' })).status, 400, 'scope needs a name')
  assert.equal((await add({ ...base, expiresAt: '2000-01-01' })).status, 400, 'expiry in the past')
})

test('granting a role takes effect at once, revoking it too, and both are audited', async () => {
  assert.equal((await call(dave, 'GET', '/requests/pool')).status, 403)

  const created = await json<{ id: string }>(
    await call(alice, 'POST', '/rbac/bindings', {
      subjectType: 'user', subject: 'dave', role: 'approver', scopeType: 'global', reason: 'covering the on-call week',
    }),
  )
  assert.equal((await call(dave, 'GET', '/requests/pool')).status, 200)
  assert.equal((await call(dave, 'GET', '/rbac/bindings')).status, 403, 'approver does not manage access')

  assert.equal((await call(alice, 'DELETE', `/rbac/bindings/${created.id}`)).status, 204)
  assert.equal((await call(dave, 'GET', '/requests/pool')).status, 403)

  const audit = await json<{ action: string; actor: string; binding: { id: string } }[]>(await call(alice, 'GET', '/rbac/audit'))
  const mine = audit.filter((e) => e.binding.id === created.id)
  assert.deepEqual(mine.map((e) => e.action).sort(), ['grant', 'revoke'])
  assert.ok(mine.every((e) => e.actor === 'alice'))
})

test('an expired binding grants nothing', async () => {
  const created = await json<{ id: string }>(
    await call(alice, 'POST', '/rbac/bindings', {
      subjectType: 'user', subject: 'dave', role: 'approver', scopeType: 'global', reason: 'one day', expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  )
  assert.equal((await call(dave, 'GET', '/requests/pool')).status, 200)
  await query(`update rbac_bindings set expires_at = now() - interval '1 minute' where id = $1`, [created.id])
  assert.equal((await call(dave, 'GET', '/requests/pool')).status, 403)
  await clearDave()
})

test('the built-in bindings cannot be removed from the admin page', async () => {
  const bindings = await json<{ id: string; builtIn: boolean }[]>(await call(alice, 'GET', '/rbac/bindings'))
  const builtIn = bindings.filter((b) => b.builtIn)
  assert.equal(builtIn.length, 2)
  for (const b of builtIn) assert.equal((await call(alice, 'DELETE', `/rbac/bindings/${b.id}`)).status, 400)
})

test('"why can dave…" names the binding behind each permission', async () => {
  const created = await json<{ id: string }>(
    await call(alice, 'POST', '/rbac/bindings', {
      subjectType: 'user', subject: 'dave', role: 'team-lead', scopeType: 'project', scope: 'LeadOnly', reason: 'leads LeadOnly',
    }),
  )
  const why = await json<{ groups: string[]; permissions: { permission: string; grants: { scope: string; via: string }[] }[] }>(
    await call(alice, 'GET', '/rbac/explain/dave'),
  )
  assert.deepEqual(why.groups, [])
  const decide = why.permissions.find((p) => p.permission === 'requests.decide_access')!
  assert.equal(decide.grants[0]!.scope, 'LeadOnly')
  assert.match(decide.grants[0]!.via, /user dave → Team lead/)
  assert.deepEqual(why.permissions.find((p) => p.permission === 'rbac.manage')!.grants, [])
  await call(alice, 'DELETE', `/rbac/bindings/${created.id}`)
})

// ---- scoped approval ---------------------------------------------------------

test('a team lead decides access requests for their scope, and nothing else', async () => {
  await call(alice, 'POST', '/rbac/bindings', {
    subjectType: 'user', subject: 'dave', role: 'team-lead', scopeType: 'project', scope: 'LeadProject', reason: 'leads it',
  })
  const inScope = await fileRequest('grant_access', 'LeadProject')
  const otherProject = await fileRequest('grant_access', 'SomeoneElses')
  const creation = await fileRequest('create_repository', 'LeadProject')

  // The queue holds only what dave may decide.
  const pool = await json<{ open: { id: string }[] }>(await call(dave, 'GET', '/requests/pool'))
  const seen = pool.open.map((r) => r.id)
  assert.ok(seen.includes(inScope))
  assert.ok(!seen.includes(otherProject))
  assert.ok(!seen.includes(creation), 'creating a repository stays with DevOps')

  // Opening one says whether dave may decide it; others are not dave's to see.
  assert.equal((await json<{ canDecide: boolean }>(await call(dave, 'GET', `/requests/${inScope}`))).canDecide, true)
  assert.equal((await call(dave, 'GET', `/requests/${otherProject}`)).status, 404)

  assert.equal((await call(dave, 'POST', `/requests/${otherProject}/reject`, { note: 'no' })).status, 403)
  assert.equal((await call(dave, 'POST', `/requests/${creation}/reject`, { note: 'no' })).status, 403)
  const rejected = await call(dave, 'POST', `/requests/${inScope}/reject`, { note: 'Ask your manager first.' })
  assert.equal(rejected.status, 200)
  assert.equal((await json<{ decidedBy: string }>(rejected)).decidedBy, 'dave')

  // The history holds the same scope: dave's decided request, not the others.
  const history = (await json<{ id: string }[]>(await call(dave, 'GET', '/requests/history'))).map((r) => r.id)
  assert.ok(history.includes(inScope))
  assert.ok(!history.includes(otherProject) && !history.includes(creation))

  // DevOps still decide everything.
  assert.equal((await call(alice, 'POST', `/requests/${otherProject}/reject`, { note: 'no' })).status, 200)
  await clearDave()
})

test('a team scope matches any team that owns the project in the catalog', () => {
  const binding: Binding = {
    id: 'x', subjectType: 'user', subject: 'dave', role: 'team-lead', scopeType: 'team', scope: 'DEVJAVA',
    reason: 'r', expiresAt: null, createdBy: 'alice', createdAt: '', builtIn: false,
  }
  const access: Access = { uid: 'dave', groups: [], bindings: [binding], grants: grantsOf([binding]) }
  assert.ok(can(access, 'requests.decide_access', { project: 'Loans', teams: ['devjava', 'QC'] }))
  assert.ok(!can(access, 'requests.decide_access', { project: 'Loans', teams: ['QC'] }))
  assert.ok(!can(access, 'requests.decide_access'), 'a scoped grant is never global')
  assert.ok(!can(access, 'requests.decide', { project: 'Loans', teams: ['DEVJAVA'] }))
})

// ---- importing the previous portal's map ------------------------------------

test('the old portal’s map imports what e-IDP can act on and says why it left the rest', () => {
  const plan = planImport(
    parseOldMap(`
VALID_GROUPS = {
 ### Admin
 "DEVOPS": ["admin"],
 "PLATFORM": ["admin"],
 "DT-Tech": ["login"],
 "QC": ["quality-control","doc_chat"],
 }

VALID_USERS = {
 "someone_lead": ["DEVJAVA-Lead","doc_chat"],
 "other_lead": ["Business-Integ-Lead"],
 }
`),
    'DEVOPS',
  )
  assert.deepEqual(
    plan.add.map((b) => `${b.subject}:${b.role}:${b.scope ?? ''}`),
    ['PLATFORM:devops-admin:', 'someone_lead:team-lead:DEVJAVA', 'other_lead:team-lead:Business-Integration'],
  )
  const why = Object.fromEntries(plan.skip.map((s) => [`${s.subject}:${s.role}`, s.why]))
  assert.match(why['DEVOPS:admin']!, /built in/)
  assert.match(why['DT-Tech:login']!, /everyone/)
  assert.match(why['QC:doc_chat']!, /no e-IDP feature/)
  assert.ok(plan.add.filter((b) => b.subjectType === 'user').every((b) => b.reason))
})

// ---- viewing as someone else -------------------------------------------------

async function assume(token: string, uid: string) {
  return call(token, 'POST', '/auth/assume', { uid })
}

test('an admin views the portal as someone else, and sees what they see', async () => {
  const res = await assume(alice, 'bob')
  assert.equal(res.status, 200)
  const asBob = (await json<{ token: string }>(res)).token

  const profile = await json<{ uid: string; isApprover: boolean }>(await call(asBob, 'GET', '/auth/profile'))
  assert.equal(profile.uid, 'bob')
  assert.equal(profile.isApprover, false)
  // bob cannot open the queue, so neither can alice while she looks as bob.
  assert.equal((await call(asBob, 'GET', '/requests/pool')).status, 403)
  assert.equal((await call(asBob, 'GET', '/requests/mine')).status, 200)

  const audit = await json<{ action: string; actor: string; target: string | null }[]>(await call(alice, 'GET', '/rbac/audit'))
  assert.ok(audit.some((e) => e.action === 'assume' && e.actor === 'alice' && e.target === 'bob'))
})

test('viewing as someone is read-only, and cannot nest', async () => {
  const asBob = (await json<{ token: string }>(await assume(alice, 'bob'))).token
  for (const [method, path, body] of [
    ['POST', '/requests', { kind: 'grant_access', collection: 'DefaultCollection', project: 'X', grantees: ['bob'], justification: 'x' }],
    ['POST', '/requests/00000000-0000-0000-0000-000000000000/cancel', {}],
    ['POST', '/auth/assume', { uid: 'carol' }],
    ['DELETE', '/rbac/bindings/00000000-0000-0000-0000-000000000000', undefined],
  ] as const) {
    const res = await call(asBob, method, path, body)
    assert.equal(res.status, 403, `${method} ${path}`)
    assert.equal((await json<{ error: { code: string } }>(res)).error.code, 'viewing_as')
  }
})

test('only someone with view-as may assume, and never as themselves or nobody', async () => {
  assert.equal((await assume(bob, 'carol')).status, 403)
  assert.equal((await assume(alice, 'ALICE')).status, 400)
  assert.equal((await assume(alice, 'nobody-here')).status, 404)
})

test('a view already handed out ends when the admin loses the permission', async () => {
  const binding = await json<{ id: string }>(
    await call(alice, 'POST', '/rbac/bindings', {
      subjectType: 'user', subject: 'dave', role: 'devops-admin', scopeType: 'global', reason: 'testing view-as',
    }),
  )
  const asBob = (await json<{ token: string }>(await assume(dave, 'bob'))).token
  assert.equal((await call(asBob, 'GET', '/requests/mine')).status, 200)

  await call(alice, 'DELETE', `/rbac/bindings/${binding.id}`)
  const res = await call(asBob, 'GET', '/requests/mine')
  assert.equal(res.status, 401)
  assert.equal((await json<{ error: { code: string } }>(res)).error.code, 'view_as_revoked')
  await clearDave()
})
