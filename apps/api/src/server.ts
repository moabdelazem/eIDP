import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createApp } from './app.ts'
import { config } from './lib/config.ts'
import { closeDb, migrate } from './lib/db.ts'
import { instance, isDraining, startDraining } from './lib/instance.ts'
import { schedule, stopJobs } from './lib/jobs.ts'
import { releaseLocks } from './lib/locks.ts'
import { errorFields, log } from './lib/log.ts'
import { renderMetrics } from './lib/metrics.ts'
import { syncCatalog } from './services/catalog.ts'
import { syncJenkins } from './services/jenkins-sync.ts'
import { syncJenkinsAccess } from './services/jenkins-access.ts'
import { prune as pruneActivity } from './services/activity.ts'
import { pruneJenkins } from './services/jenkins-retention.ts'
import { generateDue } from './services/digest.ts'
import { explainNewFailures } from './services/auto-explain.ts'
import { recoverInterrupted } from './services/requests.ts'

const applied = await migrate()
if (applied.length) log.info('database migrated', { applied })

const interrupted = await recoverInterrupted()
if (interrupted > 0) log.warn('requests interrupted by a restart were marked failed for retry', { count: interrupted })

const server = serve({ fetch: createApp().fetch, port: config.PORT })
log.info('api listening', { port: config.PORT, instance })

/** Metrics on a port of their own, which the Gateway never routes to (lib/metrics.ts). */
const metrics = config.METRICS_PORT
  ? serve({ fetch: new Hono().get('/metrics', (c) => c.text(renderMetrics(), 200, { 'content-type': 'text/plain; version=0.0.4' })).fetch, port: config.METRICS_PORT })
  : null

/**
 * Stopping without dropping anyone, for a rolling update or a node drain:
 *
 * 1. Not ready at once (`/health/ready`), but still serving for
 *    SHUTDOWN_DELAY_SECONDS — the Gateway learns of it a moment later, and
 *    requests sent meanwhile must not find the door shut.
 * 2. No new connections, no new job runs; leases and locks this process holds
 *    are let go, so another replica picks the work up at once.
 * 3. Requests in flight get SHUTDOWN_GRACE_SECONDS to finish, then are cut.
 *
 * A request being created that is cut half-way stops heartbeating and is
 * failed for retry by recovery (services/requests.ts), as after a crash.
 */
async function shutdown(signal: string): Promise<void> {
  if (isDraining()) return
  startDraining()
  log.info('shutting down', { signal, delaySeconds: config.SHUTDOWN_DELAY_SECONDS, graceSeconds: config.SHUTDOWN_GRACE_SECONDS })
  await new Promise((resolve) => setTimeout(resolve, config.SHUTDOWN_DELAY_SECONDS * 1000))
  await stopJobs()
  await new Promise<void>((resolve) => {
    const cut = setTimeout(() => {
      log.warn('requests still open after the grace period were cut')
      if ('closeAllConnections' in server) server.closeAllConnections()
      resolve()
    }, config.SHUTDOWN_GRACE_SECONDS * 1000)
    server.close(() => {
      clearTimeout(cut)
      resolve()
    })
    if ('closeIdleConnections' in server) server.closeIdleConnections()
  })
  metrics?.close()
  await releaseLocks()
  await closeDb().catch(() => {})
  log.info('stopped')
  process.exit(0)
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => void shutdown(signal).catch((err) => {
    log.error('shutdown failed', errorFields(err, { stack: true }))
    process.exit(1)
  }))
}

/*
 * Background work, through lib/jobs.ts: each job runs in one process per
 * interval however many API processes are up, a failure is logged and
 * recorded but never stops the API, and /health/jobs says how each last went.
 * Work also started by people (a sync, an explanation) is held once across
 * processes by lib/locks.ts.
 */

const MINUTE = 60_000
const jenkinsOn = Boolean(config.JENKINS_URL && config.JENKINS_USER && config.JENKINS_TOKEN)

/** The catalog. A stale or empty map is reported through /catalog, not by refusing to start. */
schedule({
  name: 'catalog-sync',
  everyMs: config.SYNC_INTERVAL_MINUTES * MINUTE,
  enabled: Boolean(config.INVENTORIES_PROJECT),
  run: async () => `ok at ${(await syncCatalog()).commit?.slice(0, 8)}`,
})
// With the timer off (0) the map is still built once at boot, as it always was —
// once however many replicas boot together: the others join that sync.
if (config.INVENTORIES_PROJECT && config.SYNC_INTERVAL_MINUTES <= 0) {
  syncCatalog().catch((err) => log.error('catalog sync at boot failed', errorFields(err)))
}

/**
 * Jenkins build history, then the failures it found explained (auto-explain.ts),
 * one at a time. Reported on the page (`jenkins_sync`) when it fails.
 */
schedule({
  name: 'jenkins-sync',
  everyMs: config.JENKINS_SYNC_SECONDS * 1000,
  enabled: jenkinsOn,
  run: async () => {
    await syncJenkins()
    const { explained, failed } = await explainNewFailures()
    return explained + failed > 0 ? `auto-explain: ${explained} explained, ${failed} could not be` : null
  },
})

/** Who Jenkins lets see which job. A failed read keeps the previous rules and says why. */
schedule({
  name: 'jenkins-access',
  everyMs: config.JENKINS_ACCESS_SYNC_MINUTES * MINUTE,
  enabled: jenkinsOn,
  run: async () => {
    const state = await syncJenkinsAccess()
    if (!state.ok) throw new Error(state.error ?? 'the read failed')
    return null
  },
})

/** Jenkins history past JENKINS_RETENTION_DAYS — whether or not Jenkins is still configured. */
schedule({
  name: 'jenkins-retention',
  everyMs: 60 * MINUTE,
  run: async () => {
    const gone = Object.entries(await pruneJenkins()).filter(([, n]) => n > 0)
    return gone.length ? `deleted ${gone.map(([what, n]) => `${n} ${what}`).join(', ')}` : null
  },
})

/** Platform activity older than ACTIVITY_RETENTION_DAYS. */
schedule({
  name: 'activity-retention',
  everyMs: 60 * MINUTE,
  run: async () => {
    const n = await pruneActivity()
    return n ? `deleted ${n} old event(s)` : null
  },
})

/** Last week's digest for every team, once the week is over; a restart over the weekend still writes Monday's. */
schedule({
  name: 'weekly-digests',
  everyMs: config.DIGEST_CHECK_MINUTES * MINUTE,
  run: async () => {
    const { made, failed } = await generateDue()
    return made + failed > 0 ? `${made} written, ${failed} could not be` : null
  },
})

/** Requests whose creation stopped heartbeating — a process that died mid-way, noticed without a restart. */
schedule({
  name: 'request-recovery',
  everyMs: MINUTE,
  run: async () => {
    const n = await recoverInterrupted()
    return n ? `${n} interrupted request(s) marked failed for retry` : null
  },
})
