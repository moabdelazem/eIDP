import { and, eq, lt, ne, sql, type SQL } from 'drizzle-orm'
import { config } from '../../lib/config.ts'
import { db } from '../../lib/db.ts'
import {
  buildExplainAttempts,
  buildExplanations,
  jenkinsAccessSync,
  jenkinsAudit,
  jenkinsBuilds,
  jenkinsIgnored,
  jenkinsJobAccess,
  jenkinsJobs,
  jenkinsSync,
} from './schema.ts'

/**
 * Jenkins history is derived data and the busiest thing the portal stores —
 * every build of every job, with its parameters — so it is kept for a
 * window and then let go. Once an hour (server.ts), and never inside a
 * request:
 *
 * - **Builds** older than `JENKINS_RETENTION_DAYS` (30), on every server —
 *   the sync only ever pruned the one configured now, so a changed
 *   `JENKINS_URL` left the old server's history behind for good.
 * - **AI explanations and their attempts** past the same window whose build
 *   is gone too. One whose build is still stored stays: asking again would
 *   cost the shared GPU for an answer already written.
 * - **The Jenkins audit** after `JENKINS_AUDIT_RETENTION_DAYS` (365) — who
 *   re-ran what is worth longer than the builds themselves.
 * - **Ignores that no longer hold** — expired, or released by a passing
 *   build. Before the builds go: "until it passes" is judged by looking for
 *   that passing build, so pruning it first would quietly ignore the job
 *   again.
 * - **Servers no longer configured** and not read within the window: their
 *   jobs, sync state and access rules.
 *
 * Builds go in batches, so a first prune over a large table never holds one
 * long lock against the sync. Postgres' autovacuum reclaims the space.
 */

const BATCH = 5000

export type Pruned = { builds: number; explanations: number; attempts: number; audit: number; ignores: number; servers: number }

let running: Promise<Pruned> | null = null

/** Single-flight: the timer and a test can overlap. */
export function pruneJenkins(): Promise<Pruned> {
  running ??= prune().finally(() => {
    running = null
  })
  return running
}

async function prune(): Promise<Pruned> {
  const days = config.JENKINS_RETENTION_DAYS
  // As the sync keys it (jenkinsConfig): the URL without its trailing slashes.
  const current = config.JENKINS_URL?.replace(/\/+$/, '') ?? null

  const ago = sql`now() - make_interval(days => ${days})`

  // Released ignores first — see above.
  const ignores = await count(sql`
    delete from ${jenkinsIgnored} i
     where (not i.until_pass and i.expires_at is not null and i.expires_at <= now())
        or (i.until_pass and exists (
             select 1 from ${jenkinsBuilds} p
              where p.server = i.server and p.job = i.job and p.number > i.from_number and p.result = 'success'))`)

  // Per server, so each delete walks (server, started_at desc).
  let builds = 0
  const servers = await db.selectDistinct({ server: jenkinsBuilds.server }).from(jenkinsBuilds)
  for (const { server } of servers) {
    for (;;) {
      const n = await count(sql`
        delete from ${jenkinsBuilds} where ctid in (
          select ctid from ${jenkinsBuilds} where server = ${server} and started_at < ${ago} limit ${BATCH})`)
      builds += n
      if (n < BATCH) break
    }
  }

  // An explanation, or a record of trying, older than the window whose build is gone too.
  const orphan = (table: typeof buildExplanations | typeof buildExplainAttempts, stamp: SQL) =>
    count(sql`
      delete from ${table} e
       where ${stamp} < ${ago}
         and not exists (select 1 from ${jenkinsBuilds} b where b.server = e.server and b.job = e.job and b.number = e.number)`)
  const explanations = await orphan(buildExplanations, sql`e.created_at`)
  const attempts = await orphan(buildExplainAttempts, sql`e.last_attempt_at`)

  const audit = await count(sql`delete from ${jenkinsAudit} where at < now() - make_interval(days => ${config.JENKINS_AUDIT_RETENTION_DAYS})`)

  // A server nobody has read within the window, and not the one configured now.
  const gone = await db
    .select({ server: jenkinsSync.server })
    .from(jenkinsSync)
    .where(and(current === null ? undefined : ne(jenkinsSync.server, current), lt(sql`coalesce(${jenkinsSync.finishedAt}, ${jenkinsSync.startedAt})`, ago)))
  for (const { server } of gone) {
    await db.transaction(async (tx) => {
      await tx.delete(jenkinsJobs).where(eq(jenkinsJobs.server, server))
      await tx.delete(jenkinsJobAccess).where(eq(jenkinsJobAccess.server, server))
      await tx.delete(jenkinsAccessSync).where(eq(jenkinsAccessSync.server, server))
      await tx.delete(jenkinsIgnored).where(eq(jenkinsIgnored.server, server))
      await tx.delete(jenkinsSync).where(eq(jenkinsSync.server, server))
    })
  }

  return { builds, explanations, attempts, audit, ignores, servers: gone.length }
}

/** Rows a statement touched. */
async function count(statement: SQL): Promise<number> {
  return (await db.execute(statement)).rowCount ?? 0
}
