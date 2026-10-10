// Locks across processes (lib/locks.ts) against real Postgres: the replicas are
// concurrent callers, each acquisition its own owner. Lock names are this
// run's own, and their rows are deleted after. Needs the postgres container.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { closeDb, migrate, query } from './db.ts'
import { exclusive, isLocked, tryWithLock } from './locks.ts'

const prefix = `locks-test-${process.pid}-${Date.now()}`
const name = (what: string) => `${prefix}-${what}`
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

before(async () => {
  await migrate()
})

after(async () => {
  await query('delete from locks where name like $1', [`${prefix}%`])
  await closeDb()
})

test('two holders at once: one runs, the other is told it is held', async () => {
  const lock = name('race')
  let runs = 0
  const work = async () => {
    runs++
    await pause(100)
    return 'done'
  }
  const [a, b] = await Promise.all([tryWithLock(lock, work), tryWithLock(lock, work)])
  assert.equal(runs, 1)
  assert.deepEqual([a.held, b.held].sort(), [false, true])
  assert.equal(await isLocked(lock), false, 'let go once the work is done')
})

test('let go when the work throws', async () => {
  const lock = name('throws')
  await assert.rejects(
    tryWithLock(lock, async () => {
      throw new Error('Jenkins said no')
    }),
    /Jenkins said no/,
  )
  assert.equal(await isLocked(lock), false)
})

test('a lock left by a process that died is taken once its lease ran out, and not before', async () => {
  const lock = name('stale')
  await query(`insert into locks (name, owner, expires_at) values ($1, 'dead:1:x', now() + interval '20 seconds')`, [lock])
  assert.equal((await tryWithLock(lock, async () => 1)).held, false)
  await query(`update locks set expires_at = now() - interval '1 second' where name = $1`, [lock])
  assert.deepEqual(await tryWithLock(lock, async () => 1), { held: true, value: 1 })
})

test('exclusive: the second caller waits for the first and reads what it kept, rather than doing it again', async () => {
  const lock = name('join')
  let kept: string | null = null
  let runs = 0
  const work = async () => {
    runs++
    await pause(300)
    kept = 'the answer'
    return kept
  }
  const [a, b] = await Promise.all([exclusive(lock, work, async () => kept), pause(50).then(() => exclusive(lock, work, async () => kept))])
  assert.equal(runs, 1)
  assert.equal(a, 'the answer')
  assert.equal(b, 'the answer')
})

test('exclusive: when the first kept nothing, the second does the work itself', async () => {
  const lock = name('retry')
  let runs = 0
  const first = exclusive(
    lock,
    async () => {
      runs++
      await pause(200)
      return 'first'
    },
    async () => null,
  )
  await pause(50)
  const second = await exclusive(
    lock,
    async () => {
      runs++
      return 'second'
    },
    async () => null,
  )
  assert.equal(await first, 'first')
  assert.equal(second, 'second')
  assert.equal(runs, 2)
})
