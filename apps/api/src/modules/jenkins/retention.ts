import { config } from '../../lib/config.ts'
import { query } from '../../lib/db.ts'

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

  // Released ignores first — see above.
  const ignores = await count(
    `delete from jenkins_ignored i
      where (not i.until_pass and i.expires_at is not null and i.expires_at <= now())
         or (i.until_pass and exists (
              select 1 from jenkins_builds p
               where p.server = i.server and p.job = i.job and p.number > i.from_number and p.result = 'success'))`,
  )

  // Per server, so each delete walks (server, started_at desc).
  let builds = 0
  const { rows: servers } = await query<{ server: string }>('select distinct server from jenkins_builds')
  for (const { server } of servers) {
    for (;;) {
      const n = await count(
        `delete from jenkins_builds where ctid in (
           select ctid from jenkins_builds
            where server = $1 and started_at < now() - make_interval(days => $2)
            limit ${BATCH})`,
        [server, days],
      )
      builds += n
      if (n < BATCH) break
    }
  }

  const orphan = (table: string, stamp: string) =>
    count(
      `delete from ${table} e
        where e.${stamp} < now() - make_interval(days => $1)
          and not exists (select 1 from jenkins_builds b where b.server = e.server and b.job = e.job and b.number = e.number)`,
      [days],
    )
  const explanations = await orphan('build_explanations', 'created_at')
  const attempts = await orphan('build_explain_attempts', 'last_attempt_at')

  const audit = await count(`delete from jenkins_audit where at < now() - make_interval(days => $1)`, [config.JENKINS_AUDIT_RETENTION_DAYS])

  // A server nobody has read within the window, and not the one configured now.
  const { rows: gone } = await query<{ server: string }>(
    `select server from jenkins_sync
      where ($1::text is null or server <> $1) and coalesce(finished_at, started_at) < now() - make_interval(days => $2)`,
    [current, days],
  )
  for (const { server } of gone) {
    for (const table of ['jenkins_jobs', 'jenkins_job_access', 'jenkins_access_sync', 'jenkins_ignored', 'jenkins_sync']) {
      await query(`delete from ${table} where server = $1`, [server])
    }
  }

  return { builds, explanations, attempts, audit, ignores, servers: gone.length }
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return (await query(sql, params)).rowCount ?? 0
}
