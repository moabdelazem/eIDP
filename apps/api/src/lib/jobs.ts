import { and, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { db } from './db.ts'
import { instance } from './instance.ts'
import { errorFields, log, withLogContext } from './log.ts'
import { jobDuration, jobRuns as runsMetric } from './metrics.ts'
import { jobRuns } from './schema.ts'

/**
 * Background jobs, safe with any number of API processes.
 *
 * Every process keeps a timer per job, but a run first claims the job's row
 * in `job_runs` — one `update … where` that only succeeds when nobody is
 * running it and its last start is an interval old — so each job runs in one
 * process per interval, and two processes never sync Jenkins into each other.
 * A lease, not an advisory lock: a lock is held by a connection, and holding
 * one per running job would starve the pool the jobs themselves query.
 *
 * A lease older than `staleMs` (a process that died mid-run) can be taken
 * over. A run that throws is recorded (`ok`, `error`) and logged; it never
 * stops the timer, and never the API.
 */

export type Job = {
  name: string
  everyMs: number
  /** Whether it runs at all — an integration that is not configured. */
  enabled?: boolean
  /** A line for the log when something happened; nothing to say is null. */
  run: () => Promise<string | null | void>
  /** How long a lease holds before another process may take it. Defaults to three intervals, at least 30 minutes. */
  staleMs?: number
}

export type JobState = {
  name: string
  enabled: boolean
  everyMs: number
  runningSince: string | null
  lastStarted: string | null
  lastFinished: string | null
  ok: boolean | null
}

/** Who holds a lease, for the row and the log. */
export const me = instance

const registered = new Map<string, Job>()
const timers: NodeJS.Timeout[] = []

/** Registers the job and starts its timer; the first run is due now, if no other process ran it within the interval. */
export function schedule(job: Job): void {
  registered.set(job.name, job)
  if (job.enabled === false || job.everyMs <= 0) return
  const tick = () => void runDue(job).catch((err) => log.error('job could not be claimed', { job: job.name, ...errorFields(err) }))
  tick()
  timers.push(setInterval(tick, job.everyMs).unref())
}

/**
 * On shutdown: no new runs here, and the leases of runs this process is still
 * in let go, so another replica takes the job at its next tick instead of
 * waiting out the stale limit.
 */
export async function stopJobs(): Promise<void> {
  for (const timer of timers.splice(0)) clearInterval(timer)
  await db.update(jobRuns).set({ runningSince: null }).where(eq(jobRuns.owner, me)).catch(() => {})
}

/**
 * Runs the job if this process can claim it. Returns whether it ran. The
 * interval is checked with a little slack, so timers in step with each other
 * do not skip a beat over a few milliseconds of drift.
 */
export async function runDue(job: Job, owner = me): Promise<boolean> {
  const staleMs = job.staleMs ?? Math.max(3 * job.everyMs, 30 * 60_000)
  const ago = (ms: number) => sql`now() - make_interval(secs => ${ms / 1000})`
  await db.insert(jobRuns).values({ name: job.name }).onConflictDoNothing()
  const claimed = await db
    .update(jobRuns)
    .set({ runningSince: sql`now()`, owner, lastStarted: sql`now()` })
    .where(
      and(
        eq(jobRuns.name, job.name),
        or(isNull(jobRuns.runningSince), lt(jobRuns.runningSince, ago(staleMs))),
        or(isNull(jobRuns.lastStarted), lte(jobRuns.lastStarted, ago(job.everyMs * 0.9))),
      ),
    )
    .returning({ name: jobRuns.name })
  if (claimed.length === 0) return false

  const started = performance.now()
  let ok = true
  let error: string | null = null
  let summary: string | null = null
  try {
    summary = (await withLogContext({ job: job.name }, job.run)) ?? null
    if (summary) log.info(summary, { job: job.name })
  } catch (err) {
    ok = false
    error = err instanceof Error ? err.message : String(err)
    log.error('job failed', { job: job.name, error })
  }
  const seconds = (performance.now() - started) / 1000
  runsMetric.inc({ job: job.name, ok: String(ok) })
  jobDuration.observe({ job: job.name }, seconds)
  // Only our own lease: if it went stale and someone took over, theirs stands.
  await db
    .update(jobRuns)
    .set({ runningSince: null, lastFinished: sql`now()`, ok, error, summary, durationMs: Math.round(seconds * 1000) })
    .where(and(eq(jobRuns.name, job.name), eq(jobRuns.owner, owner)))
  return true
}

/**
 * Every registered job and how it last went — names and times only: an
 * error's text can carry a server's own words, so it stays in the log and
 * the row, not on a public probe.
 */
export async function jobStates(): Promise<JobState[]> {
  const rows = await db.select().from(jobRuns).where(inArray(jobRuns.name, [...registered.keys()]))
  const byName = new Map(rows.map((r) => [r.name, r]))
  const iso = (d: Date | null | undefined) => d?.toISOString() ?? null
  return [...registered.values()].map((job) => {
    const r = byName.get(job.name)
    const enabled = job.enabled !== false && job.everyMs > 0
    return { name: job.name, enabled, everyMs: job.everyMs, runningSince: iso(r?.runningSince), lastStarted: iso(r?.lastStarted), lastFinished: iso(r?.lastFinished), ok: r?.ok ?? null }
  })
}
