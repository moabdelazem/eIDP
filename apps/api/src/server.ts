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
import * as activity from './modules/activity/index.ts'
import * as catalog from './modules/catalog/index.ts'
import * as digest from './modules/digest/index.ts'
import * as jenkins from './modules/jenkins/index.ts'
import * as requests from './modules/requests/index.ts'

const applied = await migrate()
if (applied.length) log.info('database migrated', { applied })

const interrupted = await requests.recoverInterrupted()
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
 * failed for retry by recovery (modules/requests/service.ts), as after a crash.
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
 * Background work, through lib/jobs.ts: each module names its jobs (its
 * `jobs.ts`); each job runs in one process per interval however many API
 * processes are up, a failure is logged and recorded but never stops the API,
 * and /health/jobs says how each last went. Work also started by people (a
 * sync, an explanation) is held once across processes by lib/locks.ts.
 */
for (const job of [...catalog.jobs, ...jenkins.jobs, ...activity.jobs, ...digest.jobs, ...requests.jobs]) schedule(job)
catalog.atBoot()
