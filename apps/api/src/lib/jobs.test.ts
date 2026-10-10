// Background jobs (lib/jobs.ts) against real Postgres: two "processes" are two
// owners racing for the same lease. Job names are this run's own, and their
// rows are deleted after. Needs the postgres container.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { closeDb, migrate, query } from './db.ts'
import { runDue, type Job } from './jobs.ts'

const prefix = `jobs-test-${process.pid}-${Date.now()}`
const name = (what: string) => `${prefix}-${what}`

before(async () => {
  await migrate()
})

after(async () => {
  await query('delete from job_runs where name like $1', [`${prefix}%`])
  await closeDb()
})

const row = async (job: string) =>
  (await query<{ running_since: Date | null; owner: string | null; ok: boolean | null; error: string | null; summary: string | null }>('select * from job_runs where name = $1', [job])).rows[0]!

test('two processes due at once: one runs, the other does not', async () => {
  let runs = 0
  const job: Job = {
    name: name('race'),
    everyMs: 60_000,
    run: async () => {
      runs++
      await new Promise((r) => setTimeout(r, 50))
      return 'did it'
    },
  }
  const [a, b] = await Promise.all([runDue(job, 'host-a:1'), runDue(job, 'host-b:2')])
  assert.equal(runs, 1)
  assert.deepEqual([a, b].sort(), [false, true])
  const r = await row(job.name)
  assert.equal(r.running_since, null, 'the lease is given back')
  assert.equal(r.ok, true)
  assert.equal(r.summary, 'did it')
})

test('once it ran, nobody runs it again within the interval', async () => {
  const job: Job = { name: name('interval'), everyMs: 60_000, run: async () => null }
  assert.equal(await runDue(job, 'host-a:1'), true)
  assert.equal(await runDue(job, 'host-a:1'), false)
  assert.equal(await runDue(job, 'host-b:2'), false)
  // An interval later it is due again.
  await query(`update job_runs set last_started = now() - interval '61 seconds' where name = $1`, [job.name])
  assert.equal(await runDue(job, 'host-b:2'), true)
})

test('a run that throws is recorded and does not keep the lease', async () => {
  const job: Job = { name: name('fails'), everyMs: 60_000, run: async () => { throw new Error('Jenkins said no') } }
  assert.equal(await runDue(job, 'host-a:1'), true)
  const r = await row(job.name)
  assert.equal(r.ok, false)
  assert.equal(r.error, 'Jenkins said no')
  assert.equal(r.running_since, null)
})

test('a lease left by a process that died is taken over once stale, and not before', async () => {
  const job: Job = { name: name('stale'), everyMs: 60_000, staleMs: 10 * 60_000, run: async () => null }
  await query(
    `insert into job_runs (name, running_since, owner, last_started) values ($1, now() - interval '5 minutes', 'dead:1', now() - interval '5 minutes')`,
    [job.name],
  )
  assert.equal(await runDue(job, 'host-a:1'), false, 'five minutes is not stale yet')
  await query(`update job_runs set running_since = now() - interval '11 minutes', last_started = now() - interval '11 minutes' where name = $1`, [job.name])
  assert.equal(await runDue(job, 'host-a:1'), true)
  assert.equal((await row(job.name)).owner, 'host-a:1')
})
