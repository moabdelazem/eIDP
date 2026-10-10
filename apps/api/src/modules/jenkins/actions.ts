import type { AuditEntry, IgnoreFor } from '@eidp/contracts/jenkins'
import * as jenkins from '../../integrations/jenkins/index.ts'
import type { QueueItem } from '../../integrations/jenkins/index.ts'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../../lib/db.ts'
import { ApiError } from '../../lib/errors.ts'
import { syncJenkins } from './sync.ts'
import type { Actor } from '../../lib/actor.ts'
import { forgetLive } from './now.ts'
import { parameters, run } from './search.ts'
import { jenkinsAudit, jenkinsBuilds, jenkinsIgnored, jenkinsJobs } from './schema.ts'
import { server } from './shared.ts'

// ---- acting ------------------------------------------------------------------

/**
 * Runs the job again with the parameters this build had — "rebuild", not
 * "build now", because a failing deploy re-run with defaults would deploy
 * something else. Refused when a parameter cannot be sent back.
 */
export async function rebuild(job: string, number: number, actor: Actor): Promise<{ queueId: number | null }> {
  return audited(actor, 'rebuild', job, number, async () => {
    const parameters = await jenkins.replayParameters(job, number)
    const queued = await jenkins.triggerBuild(job, parameters)
    return { result: queued, queueId: queued.queueId }
  })
}

export async function stop(job: string, number: number, actor: Actor): Promise<void> {
  await audited(actor, 'stop', job, number, async () => {
    await jenkins.stopBuild(job, number)
    return { result: undefined, queueId: null }
  })
}

/**
 * Takes an item out of the queue. It must still be there — the job's name for
 * the audit comes from it, and so does the check of whether the caller may
 * (`authorize`), since a queue id says nothing about whose pipeline it is.
 */
export async function cancel(id: number, actor: Actor, authorize?: (job: string, item: QueueItem) => Promise<void>): Promise<void> {
  const item = (await jenkins.listQueue()).find((q) => q.id === id)
  if (!item) throw new ApiError(404, 'jenkins_not_queued', 'That build is no longer waiting — it has started or been removed.')
  await authorize?.(item.job ?? item.name, item)
  await audited(actor, 'cancel', item.job ?? item.name, null, async () => {
    await jenkins.cancelQueueItem(id)
    return { result: undefined, queueId: id }
  })
}

async function audited<T>(
  actor: Actor,
  action: AuditEntry['action'],
  job: string,
  build: number | null,
  act: () => Promise<{ result: T; queueId: number | null }>,
): Promise<T> {
  const record = (ok: boolean, queueId: number | null, error: string | null) =>
    db.insert(jenkinsAudit).values({ actor: actor.uid, actorName: actor.name, action, job, build, queueId, ok, error })
  try {
    const { result, queueId } = await act()
    await record(true, queueId, null)
    // What was just done should show on the next look: the queue at once,
    // history with the next sync, started now rather than on the timer.
    forgetLive()
    void syncJenkins().catch(() => {})
    return result
  } catch (err) {
    await record(false, null, err instanceof Error ? err.message : String(err))
    throw err
  }
}

// ---- ignoring a failure ------------------------------------------------------------

/** How long an ignore holds: until the job passes again, a number of days, or until someone stops it. */
export const IGNORE_FOR = { pass: null, '1d': 1, '7d': 7, '30d': 30, always: null } as const

/**
 * Sets a failing job aside: it leaves "failing now", its count and the
 * automatic explanations until it passes again or the time is up. Recorded
 * in the audit with the reason, because it changes what DevOps see as broken.
 */
export async function ignore(job: string, until: IgnoreFor, reason: string, actor: Actor): Promise<void> {
  const url = server()
  // The newest finished build is where the ignore starts; a job with none starts at 0.
  const [found] = await db
    .select({
      number: sql<number | null>`(select max(b.number) from ${jenkinsBuilds} b
                                   where b.server = ${url} and b.job = ${job} and b.result not in ('running', 'not_built'))`,
    })
    .from(jenkinsJobs)
    .where(and(eq(jenkinsJobs.server, url), eq(jenkinsJobs.fullName, job)))
  if (!found) throw new ApiError(404, 'jenkins_not_found', 'Jenkins has no such job.')
  const days = IGNORE_FOR[until]
  const ignored = {
    fromNumber: found.number ?? 0,
    untilPass: until === 'pass',
    expiresAt: days === null ? null : sql`now() + make_interval(days => ${days})`,
    reason,
    ignoredBy: actor.uid,
    ignoredByName: actor.name,
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(jenkinsIgnored)
      .values({ server: url, job, ...ignored })
      .onConflictDoUpdate({ target: [jenkinsIgnored.server, jenkinsIgnored.job], set: { ...ignored, createdAt: sql`now()` } })
    await tx
      .insert(jenkinsAudit)
      .values({ actor: actor.uid, actorName: actor.name, action: 'ignore', job, build: found.number, ok: true, note: `${reason} (${IGNORE_LABEL[until]})` })
  })
}

const IGNORE_LABEL: Record<IgnoreFor, string> = {
  pass: 'until it passes',
  '1d': 'for a day',
  '7d': 'for a week',
  '30d': 'for 30 days',
  always: 'until someone stops ignoring it',
}

export async function unignore(job: string, actor: Actor): Promise<void> {
  const url = server()
  await db.transaction(async (tx) => {
    const gone = await tx
      .delete(jenkinsIgnored)
      .where(and(eq(jenkinsIgnored.server, url), eq(jenkinsIgnored.job, job)))
      .returning({ job: jenkinsIgnored.job })
    if (gone.length === 0) throw new ApiError(404, 'jenkins_not_ignored', 'That job is not being ignored.')
    await tx.insert(jenkinsAudit).values({ actor: actor.uid, actorName: actor.name, action: 'unignore', job, ok: true })
  })
}

export async function listAudit(limit = 50): Promise<AuditEntry[]> {
  const rows = await db.select().from(jenkinsAudit).orderBy(desc(jenkinsAudit.at), desc(jenkinsAudit.id)).limit(limit)
  return rows.map((row) => ({ ...row, at: row.at.toISOString() }))
}
