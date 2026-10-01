import * as jenkins from '../integrations/jenkins/index.ts'
import type { HistoryBuild, JobHead } from '../integrations/jenkins/index.ts'
import { config } from '../lib/config.ts'
import { query, transaction } from '../lib/db.ts'

/**
 * Keeps `jenkins_builds` in step with Jenkins, so the Jenkins page can answer
 * "what happened in the last day, or week" and search builds by parameter
 * from Postgres instead of sweeping Jenkins on every look.
 *
 * Each sync costs one light call for the job list (just each job's last build
 * number) plus one call per job that has built since the last sync or had a
 * build still running. Steady state is a handful of calls a minute; only the
 * first sync reads every job, up to `BACKFILL` builds each.
 *
 * Secrets never reach the table: parameter values under secret-like names and
 * password parameters are already `[hidden]` when the integration returns them.
 */

export type SyncState = {
  startedAt: string | null
  finishedAt: string | null
  ok: boolean
  error: string | null
  builds: number
  jobsRead: number
}

/** Builds read from a job Jenkins has never been synced for. */
export const BACKFILL = 100
/** At most this many new builds are read from one job in one sync. */
const MAX_PER_JOB = 100
/** Jobs read in parallel — enough to finish a first sync promptly, few enough not to load Jenkins. */
const CONCURRENCY = 6

let inFlight: Promise<SyncState> | null = null

/** Pulls what is new. A call while one runs joins it: the timer and a Refresh click can overlap. */
export function syncJenkins(): Promise<SyncState> {
  inFlight ??= run().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function run(): Promise<SyncState> {
  const server = jenkins.jenkinsConfig().url
  await query(
    `insert into jenkins_sync (server, started_at) values ($1, now())
     on conflict (server) do update set started_at = now()`,
    [server],
  )
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
        console.warn(`jenkins sync: could not read ${job}:`, err instanceof Error ? err.message : err)
      }
    })

    const cutoff = Date.now() - config.JENKINS_RETENTION_DAYS * 86_400_000
    const kept = builds.filter((b) => Date.parse(b.startedAt) >= cutoff)
    // A job that could not be read keeps its old high-water mark, so its new
    // builds are read next time rather than skipped for good.
    const marked = heads.map((h) => (unreadable.includes(h.fullName) ? { ...h, lastNumber: seen.get(h.fullName) ?? null } : h))
    await store(server, marked, kept)

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
    query<{ job: string; newest: number; oldest_running: number | null }>(
      `select job, max(number) as newest, min(number) filter (where result = 'running') as oldest_running
         from jenkins_builds where server = $1 group by job`,
      [server],
    ),
    query<{ full_name: string; last_number: number | null }>('select full_name, last_number from jenkins_jobs where server = $1', [server]),
  ])
  const stored = new Map(builds.rows.map((row) => [row.job, row]))
  const seen = new Map<string, number>()
  for (const row of jobs.rows) if (row.last_number !== null) seen.set(row.full_name, row.last_number)
  for (const row of builds.rows) seen.set(row.job, Math.max(seen.get(row.job) ?? 0, row.newest))

  const plans: { job: string; count: number }[] = []
  for (const head of heads) {
    if (head.lastNumber === null) continue
    const newest = seen.get(head.fullName)
    const running = stored.get(head.fullName)?.oldest_running ?? Infinity
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
  await transaction(async (db) => {
    await db.query('delete from jenkins_jobs where server = $1', [server])
    await db.query(
      `insert into jenkins_jobs (server, full_name, url, buildable, in_queue, last_number)
       select $1, j.full_name, j.url, j.buildable, j.in_queue, j.last_number
         from json_to_recordset($2::json)
           as j(full_name text, url text, buildable boolean, in_queue boolean, last_number integer)`,
      [
        server,
        JSON.stringify(
          heads.map((h) => ({ full_name: h.fullName, url: h.url, buildable: h.buildable, in_queue: h.inQueue, last_number: h.lastNumber })),
        ),
      ],
    )
    // Batched, so a first sync of thousands of builds is a few statements.
    for (let i = 0; i < builds.length; i += 500) {
      await db.query(
        `insert into jenkins_builds (server, job, number, result, started_at, duration_ms, url, built_on, parameters, causes, authors)
         select $1, b.job, b.number, b.result, b.started_at, b.duration_ms, b.url, b.built_on, b.parameters,
                array(select jsonb_array_elements_text(b.causes)), array(select jsonb_array_elements_text(b.authors))
           from json_to_recordset($2::json)
             as b(job text, number integer, result text, started_at timestamptz, duration_ms bigint,
                  url text, built_on text, parameters jsonb, causes jsonb, authors jsonb)
         on conflict (server, job, number) do update set
           result = excluded.result, started_at = excluded.started_at, duration_ms = excluded.duration_ms,
           url = excluded.url, built_on = excluded.built_on, parameters = excluded.parameters, causes = excluded.causes,
           authors = excluded.authors`,
        [
          server,
          JSON.stringify(
            builds.slice(i, i + 500).map((b) => ({
              job: b.job,
              number: b.number,
              result: b.result,
              started_at: b.startedAt,
              duration_ms: b.durationMs,
              url: b.url,
              built_on: b.builtOn,
              parameters: b.parameters,
              causes: b.causes,
              authors: b.authors,
            })),
          ),
        ],
      )
    }
    await db.query(`delete from jenkins_builds where server = $1 and started_at < now() - make_interval(days => $2)`, [
      server,
      config.JENKINS_RETENTION_DAYS,
    ])
  })
}

async function finish(server: string, ok: boolean, error: string | null, builds: number, jobsRead: number): Promise<SyncState> {
  const { rows } = await query<SyncRow>(
    `update jenkins_sync set finished_at = now(), ok = $2, error = $3, builds = $4, jobs_read = $5
      where server = $1 returning *`,
    [server, ok, error, builds, jobsRead],
  )
  return toState(rows[0]!)
}

/** The last sync's outcome for the configured server, or a never-synced state. */
export async function syncState(): Promise<SyncState> {
  const { rows } = await query<SyncRow>('select * from jenkins_sync where server = $1', [jenkins.jenkinsConfig().url])
  return rows[0] ? toState(rows[0]) : { startedAt: null, finishedAt: null, ok: false, error: null, builds: 0, jobsRead: 0 }
}

type SyncRow = { started_at: Date | null; finished_at: Date | null; ok: boolean; error: string | null; builds: number; jobs_read: number }

function toState(row: SyncRow): SyncState {
  return {
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    ok: row.ok,
    error: row.error,
    builds: row.builds,
    jobsRead: row.jobs_read,
  }
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
