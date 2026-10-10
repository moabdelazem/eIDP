// Jenkins history retention (services/jenkins-retention.ts) against real
// Postgres. Its rows are on servers named for this run, so they are only ever
// the test's own; the prune itself is global by age, which is the point — it
// runs under the catalog lock (4202), because the digest tests write builds
// near the edge of the window and run in parallel with this file.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import pg from 'pg'

const run = randomUUID().slice(0, 8)
const current = `http://retention-${run}.test/jenkins`
const other = `http://retention-old-${run}.test/jenkins`

// Config is read on import: this run's server is the one configured.
process.env.JENKINS_URL = `${current}/`
process.env.JENKINS_USER = 'eidp'
process.env.JENKINS_TOKEN = 'fake'
process.env.JENKINS_RETENTION_DAYS = '30'
process.env.JENKINS_AUDIT_RETENTION_DAYS = '365'

const { config } = await import('../lib/config.ts')
const { closeDb, migrate, query } = await import('../lib/db.ts')
const { pruneJenkins } = await import('../services/jenkins-retention.ts')

const lock = new pg.Client({ connectionString: config.DATABASE_URL })
const servers = [current, other]

const forget = () =>
  Promise.all(
    ['jenkins_builds', 'jenkins_jobs', 'jenkins_sync', 'jenkins_ignored', 'jenkins_job_access', 'jenkins_access_sync', 'build_explanations', 'build_explain_attempts'].map(
      (table) => query(`delete from ${table} where server = any($1)`, [servers]),
    ),
  )

async function build(server: string, job: string, number: number, daysAgo: number, result = 'success') {
  await query(
    `insert into jenkins_builds (server, job, number, result, started_at, url)
     values ($1, $2, $3, $4, now() - make_interval(days => $5), 'http://x')`,
    [server, job, number, result, daysAgo],
  )
}

async function explanation(server: string, job: string, number: number, daysAgo: number) {
  await query(
    `insert into build_explanations (server, job, number, prompt_version, model, explanation, created_by, created_by_name, created_at)
     values ($1, $2, $3, 1, 'test', '{}', 'e-idp', 'e-IDP', now() - make_interval(days => $4))`,
    [server, job, number, daysAgo],
  )
}

const has = async (sql: string, params: unknown[]) => (await query(sql, params)).rowCount! > 0
const buildExists = (server: string, job: string, number: number) =>
  has('select 1 from jenkins_builds where server = $1 and job = $2 and number = $3', [server, job, number])

before(async () => {
  await migrate()
  await lock.connect()
  await lock.query('select pg_advisory_lock(4202)')
  await forget()
})

after(async () => {
  await forget()
  await lock.query('select pg_advisory_unlock(4202)')
  await lock.end()
  await closeDb()
})

test('builds older than the window go, on every server, and newer ones stay', async () => {
  await build(current, 'app', 1, 45)
  await build(current, 'app', 2, 29)
  await build(other, 'app', 1, 45)
  await build(other, 'app', 2, 1)

  const pruned = await pruneJenkins()
  assert.ok(pruned.builds >= 2)
  assert.equal(await buildExists(current, 'app', 1), false)
  assert.equal(await buildExists(current, 'app', 2), true)
  // The sync only ever pruned the configured server; this one is not.
  assert.equal(await buildExists(other, 'app', 1), false)
  assert.equal(await buildExists(other, 'app', 2), true)
})

test('an explanation goes with its build, but stays while the build is kept', async () => {
  await build(current, 'expl', 1, 40, 'failure') // pruned below
  await build(current, 'expl', 2, 10, 'failure') // kept
  await explanation(current, 'expl', 1, 40) // build gone, old: goes
  await explanation(current, 'expl', 2, 40) // old, but its build is kept: stays
  await explanation(current, 'expl', 3, 2) // no build, but recent: stays
  await query(
    `insert into build_explain_attempts (server, job, number, prompt_version, model, attempts, last_attempt_at)
     values ($1, 'expl', 1, 1, 'test', 2, now() - interval '40 days')`,
    [current],
  )

  await pruneJenkins()
  const kept = (await query<{ number: number }>('select number from build_explanations where server = $1 and job = $2 order by number', [current, 'expl'])).rows
  assert.deepEqual(kept.map((r) => r.number), [2, 3])
  assert.equal(await has('select 1 from build_explain_attempts where server = $1 and job = $2', [current, 'expl']), false)
})

test('an ignore released by a pass goes before the pass does, so the job is not ignored again', async () => {
  // Ignored from #5 until it passes; #6 passed 40 days ago — released — and
  // #7 failed yesterday. Pruning #6 first would make the ignore hold again.
  await build(current, 'flaky', 5, 50, 'failure')
  await build(current, 'flaky', 6, 40, 'success')
  await build(current, 'flaky', 7, 1, 'failure')
  const ignore = (job: string, untilPass: boolean, expires: string | null) =>
    query(
      `insert into jenkins_ignored (server, job, from_number, until_pass, expires_at, reason, ignored_by, ignored_by_name)
       values ($1, $2, 5, $3, $4::timestamptz, 'test', 'alice', 'Alice')`,
      [current, job, untilPass, expires],
    )
  await ignore('flaky', true, null)
  await ignore('still-broken', true, null) // no pass yet: holds
  await ignore('timed-out', false, new Date(Date.now() - 86_400_000).toISOString())
  await ignore('timed', false, new Date(Date.now() + 86_400_000).toISOString())

  await pruneJenkins()
  const left = (await query<{ job: string }>('select job from jenkins_ignored where server = $1 order by job', [current])).rows.map((r) => r.job)
  assert.deepEqual(left, ['still-broken', 'timed'])
  assert.equal(await buildExists(current, 'flaky', 6), false)
})

test('the Jenkins audit is kept for its own, longer window', async () => {
  const insert = (daysAgo: number) =>
    query<{ id: string }>(
      `insert into jenkins_audit (at, actor, actor_name, action, job, ok)
       values (now() - make_interval(days => $1), 'alice', 'Alice', 'rebuild', $2, true) returning id`,
      [daysAgo, `retention-${run}`],
    )
  const old = (await insert(400)).rows[0]!.id
  const recent = (await insert(100)).rows[0]!.id
  try {
    await pruneJenkins()
    assert.equal(await has('select 1 from jenkins_audit where id = $1', [old]), false)
    assert.equal(await has('select 1 from jenkins_audit where id = $1', [recent]), true)
  } finally {
    await query('delete from jenkins_audit where id = any($1)', [[old, recent]])
  }
})

test('a server no longer configured and not read within the window is forgotten; the configured one is not', async () => {
  for (const server of servers) {
    await query(`insert into jenkins_sync (server, started_at, finished_at, ok) values ($1, now() - interval '40 days', now() - interval '40 days', true)`, [server])
    await query(`insert into jenkins_jobs (server, full_name, url) values ($1, 'app', 'http://x')`, [server])
    await query(`insert into jenkins_access_sync (server, read_at, ok) values ($1, now() - interval '40 days', true)`, [server])
  }

  const pruned = await pruneJenkins()
  assert.ok(pruned.servers >= 1)
  for (const table of ['jenkins_sync', 'jenkins_jobs', 'jenkins_access_sync']) {
    assert.equal(await has(`select 1 from ${table} where server = $1`, [other]), false, `${table} of the old server`)
    // A configured server that has not synced lately is a health problem, not a cleanup.
    assert.equal(await has(`select 1 from ${table} where server = $1`, [current]), true, `${table} of the configured server`)
  }
})
