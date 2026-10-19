// Who sees which project: the map and an application's page, against real LDAP (alice and carol are in DEVOPS, the admin
// group; bob is in Payments; dave is in nothing) and four systems of our own.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import pg from 'pg'
import type { CatalogResponse } from '@eidp/contracts/catalog'

const { createApp } = await import('../../app.ts')
const { closeDb, migrate, query } = await import('../../lib/db.ts')
const { config } = await import('../../lib/config.ts')
const app = createApp()
const tokens: Record<string, string> = {}

/**
 * Ours alone, under the catalog lock: Payments is a team of one; ScopeMgr names
 * payments (in another case) only as its project manager; ScopeNB belongs to a
 * team nobody here is in; ScopeProj, to another. Scoped bindings are
 * access/service.test.ts's: dave's bindings belong to the RBAC tests.
 */
const SYSTEMS = [
  { dir: '__scope_pay', project: 'ScopePay', teams: { dev: 'Payments', prd: 'DEVOPS' }, managers: [] as string[] },
  { dir: '__scope_mgr', project: 'ScopeMgr', teams: { dev: 'ScopeOther' }, managers: ['payments'] },
  { dir: '__scope_nb', project: 'ScopeNB', teams: { dev: 'ScopeNBTeam' }, managers: [] },
  { dir: '__scope_proj', project: 'ScopeProj', teams: { dev: 'ScopeProjTeam' }, managers: [] },
]
const catalogLock = new pg.Client({ connectionString: config.DATABASE_URL })

before(async () => {
  await migrate()
  await catalogLock.connect()
  await catalogLock.query('select pg_advisory_lock(4202)')
  for (const s of SYSTEMS) {
    await query('delete from catalog_systems where dir = $1', [s.dir])
    await query('insert into catalog_systems (dir, project_name, teams, managers) values ($1, $2, $3, $4)', [s.dir, s.project, s.teams, s.managers])
    await query('insert into catalog_applications (id, system_dir, group_name, name, repository) values ($1, $2, $3, $3, $3)', [`${s.dir}/api`, s.dir, `${s.dir}-api`])
  }
  for (const who of ['alice', 'bob', 'dave']) {
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: who, password: `${who}pw` }),
    })
    tokens[who] = ((await res.json()) as { token: string }).token
  }
})

after(async () => {
  for (const s of SYSTEMS) await query('delete from catalog_systems where dir = $1', [s.dir])
  await catalogLock.query('select pg_advisory_unlock(4202)')
  await catalogLock.end()
  await closeDb()
})

const get = (who: string, path: string) => app.request(path, { headers: { authorization: `Bearer ${tokens[who]}` } })

/** Which of our systems `who` sees on the map, and whether the map says it is all of it. */
async function seen(who: string): Promise<{ dirs: string[]; all: boolean; total: number }> {
  const res = await get(who, '/catalog')
  assert.equal(res.status, 200)
  const body = (await res.json()) as CatalogResponse
  const ours = new Set(SYSTEMS.map((s) => s.dir))
  return { dirs: body.systems.map((s) => s.id).filter((id) => ours.has(id)).sort(), all: body.scope.all, total: body.scope.total }
}

test('DevOps see every project; the map says it is all of it', async () => {
  const alice = await seen('alice')
  assert.deepEqual(alice.dirs, SYSTEMS.map((s) => s.dir).sort())
  assert.equal(alice.all, true)
})

test('someone sees the projects a group of theirs owns — as a team or named in team.yml — and no others', async () => {
  const bob = await seen('bob')
  assert.deepEqual(bob.dirs, ['__scope_mgr', '__scope_pay'])
  assert.equal(bob.all, false)
  assert.ok(bob.total >= SYSTEMS.length, 'the total counts the whole catalog')
})

test('someone who owns nothing gets an empty map, not an error', async () => {
  const dave = await seen('dave')
  assert.deepEqual(dave.dirs, [])
  assert.equal(dave.all, false)
})

test('an application in a project not yours answers as one that does not exist', async () => {
  assert.equal((await get('bob', '/catalog/systems/__scope_pay/applications/__scope_pay-api')).status, 200)
  const other = await get('bob', '/catalog/systems/__scope_nb/applications/__scope_nb-api')
  assert.equal(other.status, 404)
  assert.equal((await get('alice', '/catalog/systems/__scope_nb/applications/__scope_nb-api')).status, 200)
})
