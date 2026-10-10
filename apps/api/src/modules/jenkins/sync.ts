import type { SyncState } from '@eidp/contracts/jenkins'
export type { SyncState }
import * as jenkins from '../../integrations/jenkins/index.ts'
import type { HistoryBuild, JobHead } from '../../integrations/jenkins/index.ts'
import { config } from '../../lib/config.ts'
import { and, desc, eq, isNull, not, sql } from 'drizzle-orm'
import { db } from '../../lib/db.ts'
import { ApiError } from '../../lib/errors.ts'
import { exclusive } from '../../lib/locks.ts'
import { log } from '../../lib/log.ts'
import { jenkinsBuilds, jenkinsJobs, jenkinsSync } from './schema.ts'

/** Builds read from a job Jenkins has never been synced for. */
export const BACKFILL = 100
/** At most this many new builds are read from one job in one sync. */
const MAX_PER_JOB = 100
/** Jobs read in parallel — enough to finish a first sync promptly, few enough not to load Jenkins. */
const CONCURRENCY = 6

let inFlight: Promise<SyncState> | null = null

/**
 * Pulls what is new. A call while one runs joins it, in this process or any
 * other (`lib/locks.ts`): the timer, a Refresh click and a rebuild can overlap.
 */
export function syncJenkins(): Promise<SyncState> {
  // Per server: a sync of one Jenkins says nothing about another's. Inside the
  // promise, so Jenkins not being configured is a rejection, not a throw.
  inFlight ??= (async () => exclusive(`jenkins-sync:${jenkins.jenkinsConfig().url}`, run, finished))().finally(() => {
    inFlight = null
  })
  return inFlight
}

/** Another process's sync, once it is done. */
async function finished(): Promise<SyncState> {
  const state = await syncState()
  if (!state.ok) throw new ApiError(502, 'jenkins_sync_failed', state.error ?? 'The Jenkins sync failed.')
  return state
}

async function run(): Promise<SyncState> {
  const server = jenkins.jenkinsConfig().url
  await db
    .insert(jenkinsSync)
    .values({ server, startedAt: sql`now()` })
    .onConflictDoUpdate({ target: jenkinsSync.server, set: { startedAt: sql`now()` } })
  try {
    const heads = await jenkins.listJobs()
    const { plans, seen } = await plan(server, heads)

    const builds: HistoryBuild[] = []
    const unreadable: string[] = []
    await pool(plans, CONCURRENCY, async ({ job, count }) => {
      try {
        builds.push(...(await jenkins.jobBuilds(job, count)))
      } catch (err) {
        // A job deleted between the list and the read, or one Jenkins cannot
        // serialise: skip it and say so, rather than losing everything else.
        unreadable.push(job)
        log.warn('jenkins sync could not read a job', { job, error: err instanceof Error ? err.message : String(err) })
      }
    })

    const cutoff = Date.now() - config.JENKINS_RETENTION_DAYS * 86_400_000
    const kept = builds.filter((b) => Date.parse(b.startedAt) >= cutoff)
    // A job that could not be read keeps its old high-water mark, so its new
    // builds are read next time rather than skipped for good.
    const marked = heads.map((h) => (unreadable.includes(h.fullName) ? { ...h, lastNumber: seen.get(h.fullName) ?? null } : h))
    await store(server, marked, kept)
    await resolveAgents(server)

    const error = unreadable.length ? `Could not read ${unreadable.length} job(s): ${unreadable.slice(0, 5).join(', ')}` : null
    return await finish(server, true, error, kept.length, plans.length)
  } catch (err) {
    await finish(server, false, err instanceof Error ? err.message : String(err), 0, 0)
    throw err
  }
}

/**
 * Which jobs to read and how far back: from the oldest build still stored as
 * running, or else the first build after the newest one seen. "Seen" is the
 * newest build stored or the last number the previous sync recorded for the
 * job, whichever is higher — without the second, a job whose builds are all
 * older than the retention window would be backfilled on every sync. A job
 * never seen gets its last `BACKFILL` builds.
 */
async function plan(server: string, heads: JobHead[]) {
  const [builds, jobs] = await Promise.all([
    db
      .select({
        job: jenkinsBuilds.job,
        newest: sql<number>`max(${jenkinsBuilds.number})`,
        oldestRunning: sql<number | null>`min(${jenkinsBuilds.number}) filter (where ${jenkinsBuilds.result} = 'running')`,
      })
      .from(jenkinsBuilds)
      .where(eq(jenkinsBuilds.server, server))
      .groupBy(jenkinsBuilds.job),
    db.select({ fullName: jenkinsJobs.fullName, lastNumber: jenkinsJobs.lastNumber }).from(jenkinsJobs).where(eq(jenkinsJobs.server, server)),
  ])
  const stored = new Map(builds.map((row) => [row.job, row]))
  const seen = new Map<string, number>()
  for (const row of jobs) if (row.lastNumber !== null) seen.set(row.fullName, row.lastNumber)
  for (const row of builds) seen.set(row.job, Math.max(seen.get(row.job) ?? 0, row.newest))

  const plans: { job: string; count: number }[] = []
  for (const head of heads) {
    if (head.lastNumber === null) continue
    const newest = seen.get(head.fullName)
    const running = stored.get(head.fullName)?.oldestRunning ?? Infinity
    const from = newest === undefined ? head.lastNumber - BACKFILL + 1 : Math.min(running, newest + 1)
    const count = Math.min(head.lastNumber - from + 1, newest === undefined ? BACKFILL : MAX_PER_JOB)
    if (count > 0) plans.push({ job: head.fullName, count })
  }
  return { plans, seen }
}

/**
 * One transaction: the job list replaced (it is what "failing now" and
 * "running now" are read against), builds upserted, and history past the
 * retention window dropped. Builds of jobs deleted in Jenkins stay until they
 * age out — they still happened, and the week's numbers include them.
 */
async function store(server: string, heads: JobHead[], builds: HistoryBuild[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(jenkinsJobs).where(eq(jenkinsJobs.server, server))
    if (heads.length) {
      await tx
        .insert(jenkinsJobs)
        .values(heads.map((h) => ({ server, fullName: h.fullName, url: h.url, buildable: h.buildable, inQueue: h.inQueue, lastNumber: h.lastNumber })))
    }
    // Batched, so a first sync of thousands of builds is a few statements.
    for (let i = 0; i < builds.length; i += 500) {
      await tx
        .insert(jenkinsBuilds)
        .values(
          builds.slice(i, i + 500).map((b) => ({
            server,
            job: b.job,
            number: b.number,
            result: b.result,
            startedAt: new Date(b.startedAt),
            durationMs: b.durationMs,
            url: b.url,
            builtOn: b.builtOn,
            parameters: b.parameters,
            causes: b.causes,
            authors: b.authors,
          })),
        )
        .onConflictDoUpdate({
          target: [jenkinsBuilds.server, jenkinsBuilds.job, jenkinsBuilds.number],
          set: {
            result: sql`excluded.result`,
            startedAt: sql`excluded.started_at`,
            durationMs: sql`excluded.duration_ms`,
            url: sql`excluded.url`,
            // An agent found by an earlier sync is kept when Jenkins names none.
            builtOn: sql`coalesce(excluded.built_on, ${jenkinsBuilds.builtOn})`,
            parameters: sql`excluded.parameters`,
            causes: sql`excluded.causes`,
            authors: sql`excluded.authors`,
          },
        })
    }
  })
}

async function finish(server: string, ok: boolean, error: string | null, builds: number, jobsRead: number): Promise<SyncState> {
  const [row] = await db
    .update(jenkinsSync)
    .set({ finishedAt: sql`now()`, ok, error, builds, jobsRead })
    .where(eq(jenkinsSync.server, server))
    .returning()
  return toState(row!)
}

/** The last sync's outcome for the configured server, or a never-synced state. */
export async function syncState(): Promise<SyncState> {
  const [row] = await db.select().from(jenkinsSync).where(eq(jenkinsSync.server, jenkins.jenkinsConfig().url))
  return row ? toState(row) : { startedAt: null, finishedAt: null, ok: false, error: null, builds: 0, jobsRead: 0 }
}

function toState(row: typeof jenkinsSync.$inferSelect): SyncState {
  return {
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    ok: row.ok,
    error: row.error,
    builds: row.builds,
    jobsRead: row.jobsRead,
  }
}

/** Builds whose agent is looked up in one sync — newest first; the rest wait for the next. */
const AGENTS_PER_SYNC = 200

/**
 * Fills in the agent of builds Jenkins did not name one for — every Pipeline
 * run — from its stages or its log (`pipelineAgents`). A running build is
 * asked again until it ends, since its later stages may move; a finished one
 * once, found or not. A build that cannot be read is left to try next time.
 */
async function resolveAgents(server: string): Promise<void> {
  const b = jenkinsBuilds
  const rows = await db
    .select({ job: b.job, number: b.number, result: b.result })
    .from(b)
    .where(and(eq(b.server, server), isNull(b.builtOn), not(b.agentChecked)))
    .orderBy(desc(b.startedAt))
    .limit(AGENTS_PER_SYNC)
  await pool(rows, CONCURRENCY, async ({ job, number, result }) => {
    let agents: string[]
    try {
      agents = await jenkins.pipelineAgents(job, number)
    } catch {
      return
    }
    await db
      .update(b)
      .set({ builtOn: agents.length ? agents.join(', ') : null, agentChecked: result !== 'running' })
      .where(and(eq(b.server, server), eq(b.job, job), eq(b.number, number)))
  })
}

/** Runs `work` over `items`, `size` at a time. */
async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await work(items[next++]!)
    }),
  )
}
