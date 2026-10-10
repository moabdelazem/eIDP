import type { AuditEntry, IgnoreFor } from '@eidp/contracts/jenkins'
import * as jenkins from '../../integrations/jenkins/index.ts'
import type { QueueItem } from '../../integrations/jenkins/index.ts'
import { query, transaction } from '../../lib/db.ts'
import { ApiError } from '../../lib/errors.ts'
import { syncJenkins } from './sync.ts'
import type { Actor } from '../../lib/actor.ts'
import { forgetLive } from './now.ts'
import { parameters, run } from './search.ts'
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
    query(
      `insert into jenkins_audit (actor, actor_name, action, job, build, queue_id, ok, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [actor.uid, actor.name, action, job, build, queueId, ok, error],
    )
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
  const { rows } = await query<{ number: number | null }>(
    `select (select max(number) from jenkins_builds b where b.server = $1 and b.job = $2 and b.result not in ('running', 'not_built')) as number
       from jenkins_jobs where server = $1 and full_name = $2`,
    [url, job],
  )
  if (!rows[0]) throw new ApiError(404, 'jenkins_not_found', 'Jenkins has no such job.')
  const days = IGNORE_FOR[until]
  await transaction(async (db) => {
    await db.query(
      `insert into jenkins_ignored (server, job, from_number, until_pass, expires_at, reason, ignored_by, ignored_by_name)
       values ($1, $2, $3, $4, case when $5::int is null then null else now() + make_interval(days => $5::int) end, $6, $7, $8)
       on conflict (server, job) do update set
         from_number = excluded.from_number, until_pass = excluded.until_pass, expires_at = excluded.expires_at,
         reason = excluded.reason, ignored_by = excluded.ignored_by, ignored_by_name = excluded.ignored_by_name, created_at = now()`,
      [url, job, rows[0]!.number ?? 0, until === 'pass', days, reason, actor.uid, actor.name],
    )
    await db.query(
      `insert into jenkins_audit (actor, actor_name, action, job, build, ok, note) values ($1, $2, 'ignore', $3, $4, true, $5)`,
      [actor.uid, actor.name, job, rows[0]!.number, `${reason} (${IGNORE_LABEL[until]})`],
    )
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
  await transaction(async (db) => {
    const { rowCount } = await db.query('delete from jenkins_ignored where server = $1 and job = $2', [url, job])
    if (!rowCount) throw new ApiError(404, 'jenkins_not_ignored', 'That job is not being ignored.')
    await db.query(`insert into jenkins_audit (actor, actor_name, action, job, ok) values ($1, $2, 'unignore', $3, true)`, [actor.uid, actor.name, job])
  })
}

export async function listAudit(limit = 50): Promise<AuditEntry[]> {
  const { rows } = await query<{
    id: string
    at: Date
    actor: string
    actor_name: string
    action: AuditEntry['action']
    job: string
    build: number | null
    queue_id: string | null
    ok: boolean
    error: string | null
    note: string | null
  }>('select * from jenkins_audit order by at desc, id desc limit $1', [limit])
  return rows.map((row) => ({
    id: Number(row.id),
    at: row.at.toISOString(),
    actor: row.actor,
    actorName: row.actor_name,
    action: row.action,
    job: row.job,
    build: row.build,
    queueId: row.queue_id === null ? null : Number(row.queue_id),
    ok: row.ok,
    error: row.error,
    note: row.note,
  }))
}
