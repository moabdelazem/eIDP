import type { Category, Failure, Ignore, Overview } from '@eidp/contracts/jenkins'
import * as jenkins from '../../integrations/jenkins/index.ts'
import type { Agent, QueueItem } from '../../integrations/jenkins/index.ts'
import { ollamaConfig } from '../../integrations/ollama/index.ts'
import { query } from '../../lib/db.ts'
import { PROMPT_VERSION } from './explainer.ts'
import { syncJenkins, syncState } from './sync.ts'
import { IGNORE_HOLDS, type RunRow, server, toRun } from './shared.ts'

// ---- now ---------------------------------------------------------------------

/**
 * The queue and agents are live, and asked for at most every 15 seconds
 * however many people have the page open.
 *
 * ponytail: per process, like the group cache.
 */
const LIVE_MS = 15_000
let live: { at: number; value: { queue: QueueItem[]; agents: Agent[] } } | null = null
let liveInFlight: Promise<{ queue: QueueItem[]; agents: Agent[] }> | null = null

/** After an action: the next look asks Jenkins again rather than the cache. */
export function forgetLive(): void {
  live = null
}

function liveState({ fresh = false } = {}) {
  if (!fresh && live && Date.now() - live.at < LIVE_MS) return Promise.resolve(live.value)
  liveInFlight ??= Promise.all([jenkins.listQueue(), jenkins.listAgents()])
    .then(([queue, agents]) => {
      live = { at: Date.now(), value: { queue, agents } }
      return live.value
    })
    .finally(() => {
      liveInFlight = null
    })
  return liveInFlight
}

/** What is waiting in Jenkins' queue now, from the same 15-second cache as the page. */
export async function queueNow({ fresh = false } = {}): Promise<QueueItem[]> {
  return (await liveState({ fresh })).queue
}

/** What needs attention now: jobs failing, what is running and waiting, agents down. */
export async function overview({ fresh = false, withExplanations = false } = {}): Promise<Overview> {
  const url = server()
  const [sync, { queue, agents }, failing, counts] = await Promise.all([
    syncState(),
    liveState({ fresh }),
    failingNow(url, withExplanations),
    query<{ jobs: string; running: string }>(
      `select (select count(*) from jenkins_jobs where server = $1) as jobs,
              (select count(distinct b.job) from jenkins_builds b
                 join jenkins_jobs j on j.server = b.server and j.full_name = b.job and j.last_number = b.number
                where b.server = $1 and b.result = 'running') as running`,
      [url],
    ),
  ])
  if (!sync.finishedAt && !sync.startedAt) {
    // Never synced: start one now, so the page is not empty until the timer fires.
    void syncJenkins().catch(() => {})
  }
  const failures = failing.filter((f) => !f.ignored)
  const ignored = failing.filter((f) => f.ignored)
  return {
    url,
    sync,
    counts: {
      jobs: Number(counts.rows[0]!.jobs),
      failing: failures.length,
      ignored: ignored.length,
      running: Number(counts.rows[0]!.running),
      queued: queue.length,
      agentsOffline: agents.filter((agent) => agent.offline).length,
    },
    failures,
    ignored,
    queue,
    agents,
  }
}

/**
 * Jobs Jenkins still has whose latest finished build failed or was unstable,
 * with the streak since their last pass. Newest failure first.
 */
async function failingNow(url: string, withExplanations: boolean): Promise<Failure[]> {
  // Explanations for the current prompt and model only — a stale one is not served as current.
  const ai = withExplanations ? ollamaConfig() : null
  const { rows } = await query<RunRow & { streak: string; since: Date; last_success: Date | null; job_url: string; in_queue: boolean; running: boolean; explanation: { summary: string; category: Category } | null; ignored: Ignore | null }>(
    `with latest as (
       select distinct on (b.job) b.*
         from jenkins_builds b
         join jenkins_jobs j on j.server = b.server and j.full_name = b.job
        where b.server = $1 and b.result not in ('running', 'not_built')
        order by b.job, b.number desc
     ),
     passed as (
       select job, max(number) as number, max(started_at) as at
         from jenkins_builds where server = $1 and result = 'success' group by job
     )
     select l.*, j.url as job_url, j.in_queue,
            p.at as last_success,
            exists (select 1 from jenkins_builds r where r.server = $1 and r.job = l.job and r.result = 'running') as running,
            (select count(*) from jenkins_builds s
              where s.server = $1 and s.job = l.job and s.number > coalesce(p.number, 0)
                and s.result in ('failure', 'unstable')) as streak,
            (select min(started_at) from jenkins_builds s
              where s.server = $1 and s.job = l.job and s.number > coalesce(p.number, 0)
                and s.result in ('failure', 'unstable')) as since,
            (select json_build_object('summary', e.explanation->>'summary', 'category', e.explanation->>'category')
               from build_explanations e
              where $2::text is not null and e.server = $1 and e.job = l.job and e.number = l.number
                and e.prompt_version = $3 and e.model = $2) as explanation,
            (select json_build_object('reason', i.reason, 'by', i.ignored_by, 'byName', i.ignored_by_name, 'at', i.created_at,
                                      'untilPass', i.until_pass, 'expiresAt', i.expires_at)
               from jenkins_ignored i where i.server = $1 and i.job = l.job and ${IGNORE_HOLDS}) as ignored
       from latest l
       join jenkins_jobs j on j.server = l.server and j.full_name = l.job
       left join passed p on p.job = l.job
      where l.result in ('failure', 'unstable')
      order by l.started_at desc`,
    [url, ai?.model ?? null, PROMPT_VERSION],
  )
  return rows.map((row) => ({
    job: row.job,
    url: row.job_url,
    last: toRun(row),
    streak: Number(row.streak),
    streakAtLeast: row.last_success === null,
    since: row.since.toISOString(),
    lastSuccess: row.last_success?.toISOString() ?? null,
    running: row.running,
    inQueue: row.in_queue,
    explanation: row.explanation,
    ignored: row.ignored,
  }))
}
