import { randomUUID } from 'node:crypto'
import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { db } from './db.ts'
import { ApiError } from './errors.ts'
import { instance } from './instance.ts'
import { log } from './log.ts'
import { locks } from './schema.ts'

/**
 * Locks that hold across every API process, kept in Postgres (`locks`).
 *
 * A promise in a module variable makes work happen once per process; with
 * several replicas that is once per replica — two git fetches into one
 * checkout, the same build explained twice on the shared GPU, one person's
 * two chatbot answers on two pods. A row here makes it once per cluster.
 *
 * A lease, not an advisory lock, for the reason `jobs.ts` gives: a session
 * lock pins a pool connection for as long as the work runs. The holder renews
 * the lease every `RENEW_MS`; a process that dies lets go within `LEASE_MS`,
 * and any process may then take the row over.
 */

const LEASE_MS = 30_000
const RENEW_MS = 10_000

const leaseEnd = () => sql`now() + make_interval(secs => ${LEASE_MS / 1000})`

/** Takes the lock if nobody holds it, or the holder's lease ran out. Returns the token that holds it. */
async function acquire(name: string): Promise<string | null> {
  const token = `${instance}:${randomUUID()}`
  const taken = await db
    .insert(locks)
    .values({ name, owner: token, expiresAt: leaseEnd() })
    .onConflictDoUpdate({
      target: locks.name,
      set: { owner: token, acquiredAt: sql`now()`, expiresAt: leaseEnd() },
      // Only a lease that ran out is taken over.
      setWhere: lt(locks.expiresAt, sql`now()`),
    })
    .returning({ name: locks.name })
  return taken.length ? token : null
}

/** Runs `fn` holding `name`, renewing it while `fn` runs; `held: false` when another process has it. */
export async function tryWithLock<T>(name: string, fn: () => Promise<T>): Promise<{ held: true; value: T } | { held: false }> {
  const token = await acquire(name)
  if (!token) return { held: false }
  const renew = setInterval(() => {
    db.update(locks).set({ expiresAt: leaseEnd() }).where(and(eq(locks.name, name), eq(locks.owner, token))).catch(
      (err: unknown) => log.warn('lock renewal failed', { lock: name, error: err instanceof Error ? err.message : String(err) }),
    )
  }, RENEW_MS)
  renew.unref()
  try {
    return { held: true, value: await fn() }
  } finally {
    clearInterval(renew)
    // Only our own row: if the lease ran out and someone took over, theirs stands.
    await db.delete(locks).where(and(eq(locks.name, name), eq(locks.owner, token))).catch(() => {})
  }
}

/** On shutdown, whatever this process still holds goes, so nobody waits out a lease for a process that is gone. */
export async function releaseLocks(): Promise<void> {
  await db.delete(locks).where(sql`starts_with(${locks.owner}, ${`${instance}:`})`).catch(() => {})
}

/** Whether some process holds `name` now. */
export async function isLocked(name: string): Promise<boolean> {
  const held = await db.select({ name: locks.name }).from(locks).where(and(eq(locks.name, name), gte(locks.expiresAt, sql`now()`)))
  return held.length > 0
}

/** Waits until nobody holds `name`, looking less often the longer it takes. */
export async function waitUntilFree(name: string, maxMs: number): Promise<void> {
  const until = Date.now() + maxMs
  let pause = 250
  while (await isLocked(name)) {
    if (Date.now() >= until) throw new ApiError(503, 'busy', 'Another part of the portal is still doing this. Try again in a moment.')
    await new Promise((resolve) => setTimeout(resolve, pause))
    pause = Math.min(pause * 2, 2000)
  }
}

/**
 * Work done by one process at a time across the cluster. When another process
 * is already doing it, waits for that to finish and returns `joined()` — what
 * it wrote — rather than doing it again; `joined` answering null (nothing
 * kept, or that run failed) means try to do it here.
 */
export async function exclusive<T>(name: string, fn: () => Promise<T>, joined: () => Promise<T | null>, { waitMs = 10 * 60_000 } = {}): Promise<T> {
  for (;;) {
    const run = await tryWithLock(name, fn)
    if (run.held) return run.value
    await waitUntilFree(name, waitMs)
    const theirs = await joined()
    if (theirs !== null) return theirs
  }
}
