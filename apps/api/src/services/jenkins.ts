import * as jenkins from '../integrations/jenkins/index.ts'
import type { Agent, Build, BuildDetail, QueueItem } from '../integrations/jenkins/index.ts'
import { query } from '../lib/db.ts'
import { ApiError } from '../lib/errors.ts'
import type { Actor } from './requests.ts'

/**
 * Jenkins as DevOps need to see it: what is broken, what just ran, what is
 * waiting and which agents are down — and the few things worth doing about
 * it from here (run again, stop, take out of the queue).
 *
 * Every action goes to Jenkins as the service account, so Jenkins alone would
 * record the portal as having done it. `jenkins_audit` records who actually
 * asked, including attempts Jenkins refused.
 */

/** A job whose latest finished build did not pass. */
export type Failure = {
  job: string
  url: string
  /** The latest finished build. */
  last: Build
  /** Finished builds in a row that did not pass, counting back from `last`. */
  streak: number
  /** The streak reached the oldest build read, so it may be longer. */
  streakAtLeast: boolean
  /** When the streak began: the oldest failing build in it. */
  since: string
  /** The last build that passed, if one is among those read. */
  lastSuccess: string | null
  running: boolean
  inQueue: boolean
}

export type Overview = {
  url: string
  fetchedAt: string
  counts: { jobs: number; failing: number; running: number; queued: number; agentsOffline: number }
  failures: Failure[]
  /** The most recent builds across every job, newest first. */
  runs: Build[]
  queue: QueueItem[]
  agents: Agent[]
}

export type AuditEntry = {
  id: number
  at: string
  actor: string
  actorName: string
  action: 'rebuild' | 'stop' | 'cancel'
  job: string
  build: number | null
  queueId: number | null
  ok: boolean
  error: string | null
}

export const RECENT_RUNS = 100

/**
 * How long one overview serves everyone. The page polls, several DevOps may
 * have it open, and each overview is a sweep of every job in Jenkins.
 *
 * ponytail: per process, like the group cache. Fine for one API process.
 */
const CACHE_MS = 15_000
let cached: { overview: Overview; at: number } | null = null
let inFlight: Promise<Overview> | null = null

/** The overview, from cache when fresh. Concurrent callers share one sweep. */
export function overview({ fresh = false } = {}): Promise<Overview> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.overview)
  inFlight ??= build().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function build(): Promise<Overview> {
  const [jobs, queue, agents] = await Promise.all([jenkins.listJobs(), jenkins.listQueue(), jenkins.listAgents()])

  const failures: Failure[] = []
  for (const job of jobs) {
    const finished = job.builds.filter((b) => b.result !== 'running')
    const last = finished[0]
    if (!last || !broken(last)) continue
    let streak = 0
    while (streak < finished.length && broken(finished[streak]!)) streak++
    failures.push({
      job: job.fullName,
      url: job.url,
      last,
      streak,
      streakAtLeast: streak === finished.length && job.builds.length >= jenkins.BUILDS_PER_JOB,
      since: finished[streak - 1]!.startedAt,
      lastSuccess: finished.find((b) => b.result === 'success')?.startedAt ?? null,
      running: job.builds[0]?.result === 'running',
      inQueue: job.inQueue,
    })
  }
  failures.sort((a, b) => b.last.startedAt.localeCompare(a.last.startedAt))

  const runs = jobs
    .flatMap((job) => job.builds)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, RECENT_RUNS)

  const result: Overview = {
    url: jenkins.webUrl(),
    fetchedAt: new Date().toISOString(),
    counts: {
      jobs: jobs.length,
      failing: failures.length,
      running: jobs.filter((job) => job.builds[0]?.result === 'running').length,
      queued: queue.length,
      agentsOffline: agents.filter((agent) => agent.offline).length,
    },
    failures,
    runs,
    queue,
    agents,
  }
  cached = { overview: result, at: Date.now() }
  return result
}

function broken(build: Build): boolean {
  return build.result === 'failure' || build.result === 'unstable'
}

/** A build with what started it, its parameters (secrets hidden) and the end of its log. */
export async function run(job: string, number: number): Promise<BuildDetail & { log: string; logTruncated: boolean }> {
  const [detail, log] = await Promise.all([jenkins.buildDetail(job, number), jenkins.logTail(job, number)])
  return { ...detail, log: log.text, logTruncated: log.truncated }
}

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

/** Takes an item out of the queue. It must still be there — the job's name for the audit comes from it. */
export async function cancel(id: number, actor: Actor): Promise<void> {
  const item = (await jenkins.listQueue()).find((q) => q.id === id)
  if (!item) throw new ApiError(404, 'jenkins_not_queued', 'That build is no longer waiting — it has started or been removed.')
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
    // What was just done should show on the next look, not 15 seconds later.
    cached = null
    return result
  } catch (err) {
    await record(false, null, err instanceof Error ? err.message : String(err))
    throw err
  }
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
  }))
}
