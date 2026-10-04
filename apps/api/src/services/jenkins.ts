import * as jenkins from '../integrations/jenkins/index.ts'
import type { Agent, BuildDetail, Parameter, QueueItem, Result } from '../integrations/jenkins/index.ts'
import { ollamaConfig } from '../integrations/ollama/index.ts'
import { query, transaction } from '../lib/db.ts'
import { PROMPT_VERSION } from './build-explainer.ts'
import { ApiError } from '../lib/errors.ts'
import { syncJenkins, syncState, type SyncState } from './jenkins-sync.ts'
import type { Actor } from './requests.ts'

/**
 * Jenkins as DevOps need to see it: what is broken now, how the last day or
 * week went, every build searchable by what it was given — and the few
 * things worth doing about it from here (run again, stop, dequeue).
 *
 * History comes from `jenkins_builds`, which `jenkins-sync.ts` keeps current;
 * the queue and agents are asked of Jenkins live, since only "now" matters
 * for them. Every action goes to Jenkins as the service account, so
 * `jenkins_audit` records who actually asked, refusals included.
 */

/** A build as history holds it. */
export type Run = {
  job: string
  number: number
  result: Result
  startedAt: string
  durationMs: number
  url: string
  builtOn: string | null
  causes: string[]
  parameters: Parameter[]
}

/** A job whose latest finished build did not pass. */
export type Failure = {
  job: string
  url: string
  last: Run
  /** Finished builds in a row that did not pass, counting back from `last`. */
  streak: number
  /** No pass is in the stored history, so the streak may be longer. */
  streakAtLeast: boolean
  since: string
  lastSuccess: string | null
  running: boolean
  inQueue: boolean
  /** The model's one-line account of the latest failure, when there is one and the reader may see it. */
  explanation: { summary: string; category: string } | null
  /** Set aside on purpose: who, why, and until when. Ignored failures are not "failing now". */
  ignored: Ignore | null
}

export type Ignore = { reason: string; by: string; byName: string; at: string; untilPass: boolean; expiresAt: string | null }

/**
 * Whether the ignore row `i` still holds: until the job passes after the build
 * it was ignored at, or until it expires. SQL, so every reader agrees.
 */
export const IGNORE_HOLDS = `((i.until_pass and not exists (
    select 1 from jenkins_builds p where p.server = i.server and p.job = i.job and p.number > i.from_number and p.result = 'success'))
  or (not i.until_pass and (i.expires_at is null or i.expires_at > now())))`

export type Overview = {
  url: string
  sync: SyncState
  counts: { jobs: number; failing: number; ignored: number; running: number; queued: number; agentsOffline: number }
  /** Failing and not ignored — what needs someone. */
  failures: Failure[]
  /** Failing, but set aside on purpose. */
  ignored: Failure[]
  queue: QueueItem[]
  agents: Agent[]
}

export const WINDOWS = { '24h': { hours: 24, bucket: 1 }, '7d': { hours: 168, bucket: 6 } } as const
export type Window = keyof typeof WINDOWS

/** The figures for one window. `successRate` is over builds that finished passing or broken — an abort is neither. */
export type Totals = {
  builds: number
  success: number
  failure: number
  unstable: number
  aborted: number
  successRate: number | null
  p50Ms: number | null
  p95Ms: number | null
  jobs: number
}

export type Stats = {
  window: Window
  from: string
  to: string
  current: Totals
  /** The window before, the same length — what the deltas compare against. */
  previous: Totals
  running: number
  /**
   * Builds per bucket by result, oldest first: hourly over 24h, six-hourly
   * over 7 days — with the typical and slow-tail time of those that finished.
   */
  timeline: {
    at: string
    success: number
    failure: number
    unstable: number
    aborted: number
    successRate: number | null
    p50Ms: number | null
    p95Ms: number | null
  }[]
  /** Jobs with the most broken builds in the window, and whether each is being ignored now. */
  topFailing: { job: string; builds: number; broken: number; rate: number; lastBroken: string; ignored: boolean }[]
  /** From a job breaking to its next pass, for fixes made in the window and in the one before. */
  recovery: { current: Recovery; previous: Recovery }
  /** Builds per agent, busiest first — top eight, the rest as one "Other". */
  agents: { agent: string; builds: number; broken: number; busyMs: number }[]
  /** What started builds, by who or what — top eight, the rest as "Other". */
  triggers: { trigger: string; builds: number }[]
  /** Why failed builds failed, by the model's category — its reading, not a fact. Empty without explanations. */
  categories: { category: string; builds: number }[]
  /** Jobs whose typical build takes longest in the window. */
  slowest: { job: string; builds: number; p50Ms: number; p95Ms: number }[]
}

export type Recovery = { fixes: number; medianMs: number | null; longestMs: number | null }

export type AuditEntry = {
  id: number
  at: string
  actor: string
  actorName: string
  action: 'rebuild' | 'stop' | 'cancel' | 'ignore' | 'unignore'
  /** The reason given, for an ignore. */
  note: string | null
  job: string
  build: number | null
  queueId: number | null
  ok: boolean
  error: string | null
}

const server = () => jenkins.jenkinsConfig().url

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
  const { rows } = await query<RunRow & { streak: string; since: Date; last_success: Date | null; job_url: string; in_queue: boolean; running: boolean; explanation: { summary: string; category: string } | null; ignored: Ignore | null }>(
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

// ---- over a window -------------------------------------------------------------

/** How the last 24 hours or 7 days went, against the same length before. */
export async function stats(window: Window): Promise<Stats> {
  const url = server()
  const { hours, bucket } = WINDOWS[window]
  // Buckets end at the next whole hour, so the chart's last bar is the current one.
  const to = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000)
  const from = new Date(to.getTime() - hours * 3_600_000)
  const before = new Date(from.getTime() - hours * 3_600_000)

  const [current, previous, running, timeline, topFailing, slowest, recoveryNow, recoveryBefore, agents, triggers, categories] = await Promise.all([
    totals(url, from, to),
    totals(url, before, from),
    query<{ n: string }>(`select count(*) as n from jenkins_builds where server = $1 and result = 'running'`, [url]),
    query<{ at: Date; success: string; failure: string; unstable: string; aborted: string; p50: number | null; p95: number | null }>(
      `with buckets as (
         select generate_series($2::timestamptz, $3::timestamptz - make_interval(hours => $4), make_interval(hours => $4)) as at
       )
       select k.at,
              count(*) filter (where b.result = 'success') as success,
              count(*) filter (where b.result = 'failure') as failure,
              count(*) filter (where b.result = 'unstable') as unstable,
              count(*) filter (where b.result = 'aborted') as aborted,
              percentile_cont(0.5) within group (order by b.duration_ms) filter (where b.result not in ('running', 'not_built')) as p50,
              percentile_cont(0.95) within group (order by b.duration_ms) filter (where b.result not in ('running', 'not_built')) as p95
         from buckets k
         left join jenkins_builds b
           on b.server = $1 and b.started_at >= k.at and b.started_at < k.at + make_interval(hours => $4)
        group by k.at order by k.at`,
      [url, from, to, bucket],
    ),
    query<{ job: string; builds: string; broken: string; last_broken: Date; ignored: boolean }>(
      `select job, count(*) as builds,
              count(*) filter (where result in ('failure', 'unstable')) as broken,
              max(started_at) filter (where result in ('failure', 'unstable')) as last_broken,
              exists (select 1 from jenkins_ignored i where i.server = $1 and i.job = b.job and ${IGNORE_HOLDS}) as ignored
         from jenkins_builds b
        where server = $1 and started_at >= $2 and started_at < $3 and result not in ('running', 'not_built')
        group by job
       having count(*) filter (where result in ('failure', 'unstable')) > 0
        order by broken desc, last_broken desc limit 8`,
      [url, from, to],
    ),
    query<{ job: string; builds: string; p50: number; p95: number }>(
      `select job, count(*) as builds,
              percentile_cont(0.5) within group (order by duration_ms) as p50,
              percentile_cont(0.95) within group (order by duration_ms) as p95
         from jenkins_builds
        where server = $1 and started_at >= $2 and started_at < $3 and result not in ('running', 'not_built')
        group by job order by p50 desc limit 8`,
      [url, from, to],
    ),
    recovery(url, from, to),
    recovery(url, before, from),
    query<{ agent: string; builds: string; broken: string; busy: string }>(
      // A run that moved between agents counts for each; built_on lists them "a, b".
      `with per as (
         select trim(a) as agent, b.result, b.duration_ms
           from jenkins_builds b, unnest(string_to_array(b.built_on, ',')) a
          where b.server = $1 and b.started_at >= $2 and b.started_at < $3 and b.built_on is not null
       )
       select agent, count(*) as builds, count(*) filter (where result in ('failure', 'unstable')) as broken,
              coalesce(sum(duration_ms), 0) as busy
         from per group by agent order by count(*) desc, agent`,
      [url, from, to],
    ),
    query<{ trigger: string; builds: string }>(
      `select coalesce(
                substring(causes[1] from '^Started by user (.+)$'),
                case when causes[1] ilike '%SCM change%' or causes[1] ilike '%push%' then 'SCM change'
                     when causes[1] ilike '%timer%' then 'Timer'
                     when causes[1] ilike '%upstream%' then 'Upstream job'
                     when causes[1] ilike '%remote%' then 'Remote call'
                     when causes[1] is null then 'Unknown'
                     else causes[1] end) as trigger,
              count(*) as builds
         from jenkins_builds
        where server = $1 and started_at >= $2 and started_at < $3
        group by 1 order by count(*) desc, 1`,
      [url, from, to],
    ),
    query<{ category: string; builds: string }>(
      `select e.category, count(*) as builds
         from (select distinct on (x.job, x.number) x.job, x.number, x.explanation->>'category' as category
                 from build_explanations x where x.server = $1
                order by x.job, x.number, x.created_at desc) e
         join jenkins_builds b on b.server = $1 and b.job = e.job and b.number = e.number
        where b.started_at >= $2 and b.started_at < $3 and b.result in ('failure', 'unstable')
        group by e.category order by count(*) desc, e.category`,
      [url, from, to],
    ),
  ])

  return {
    window,
    from: from.toISOString(),
    to: to.toISOString(),
    current,
    previous,
    running: Number(running.rows[0]!.n),
    timeline: timeline.rows.map((row) => {
      const [success, failure, unstable, aborted] = [row.success, row.failure, row.unstable, row.aborted].map(Number) as [number, number, number, number]
      const decided = success + failure + unstable
      return {
        at: row.at.toISOString(),
        success,
        failure,
        unstable,
        aborted,
        successRate: decided ? success / decided : null,
        p50Ms: row.p50 === null ? null : Math.round(row.p50),
        p95Ms: row.p95 === null ? null : Math.round(row.p95),
      }
    }),
    topFailing: topFailing.rows.map((row) => ({
      job: row.job,
      builds: Number(row.builds),
      broken: Number(row.broken),
      rate: Number(row.broken) / Number(row.builds),
      lastBroken: row.last_broken.toISOString(),
      ignored: row.ignored,
    })),
    slowest: slowest.rows.map((row) => ({ job: row.job, builds: Number(row.builds), p50Ms: Math.round(row.p50), p95Ms: Math.round(row.p95) })),
    recovery: { current: recoveryNow, previous: recoveryBefore },
    agents: topAndOther(
      agents.rows.map((row) => ({ agent: row.agent, builds: Number(row.builds), broken: Number(row.broken), busyMs: Number(row.busy) })),
      (rest) => ({ agent: 'Other', builds: sum(rest, 'builds'), broken: sum(rest, 'broken'), busyMs: sum(rest, 'busyMs') }),
    ),
    triggers: topAndOther(
      triggers.rows.map((row) => ({ trigger: row.trigger, builds: Number(row.builds) })),
      (rest) => ({ trigger: 'Other', builds: sum(rest, 'builds') }),
    ),
    categories: categories.rows.map((row) => ({ category: row.category, builds: Number(row.builds) })),
  }
}

/** The first eight, and the rest folded into one row — a ninth bar is never its own. */
function topAndOther<T>(rows: T[], fold: (rest: T[]) => T): T[] {
  return rows.length <= 9 ? rows : [...rows.slice(0, 8), fold(rows.slice(8))]
}

function sum<T>(rows: T[], key: keyof T): number {
  return rows.reduce((n, row) => n + Number(row[key]), 0)
}

/**
 * Time to fix: for every pass in [from, to) that followed a failure, how long
 * since the first failure of that streak. The median, so one job broken for a
 * month does not stand for every quick fix; the longest beside it.
 */
async function recovery(url: string, from: Date, to: Date): Promise<Recovery> {
  const { rows } = await query<{ fixes: string; median: number | null; longest: number | null }>(
    `with finished as (
       select job, number, result, started_at,
              lag(result) over w as before,
              max(number) filter (where result = 'success') over (w rows between unbounded preceding and 1 preceding) as last_pass
         from jenkins_builds
        where server = $1 and result in ('success', 'failure', 'unstable')
       window w as (partition by job order by number)
     ),
     fixes as (
       select p.started_at - (select min(b.started_at) from jenkins_builds b
                               where b.server = $1 and b.job = p.job and b.result in ('failure', 'unstable')
                                 and b.number > coalesce(p.last_pass, 0) and b.number < p.number) as took
         from finished p
        where p.result = 'success' and p.before in ('failure', 'unstable') and p.started_at >= $2 and p.started_at < $3
     )
     select count(*) as fixes,
            percentile_cont(0.5) within group (order by extract(epoch from took) * 1000) as median,
            max(extract(epoch from took) * 1000) as longest
       from fixes where took is not null`,
    [url, from, to],
  )
  const row = rows[0]!
  return { fixes: Number(row.fixes), medianMs: row.median === null ? null : Math.round(row.median), longestMs: row.longest === null ? null : Math.round(Number(row.longest)) }
}

async function totals(url: string, from: Date, to: Date): Promise<Totals> {
  const { rows } = await query<{
    builds: string
    success: string
    failure: string
    unstable: string
    aborted: string
    p50: number | null
    p95: number | null
    jobs: string
  }>(
    `select count(*) as builds,
            count(*) filter (where result = 'success') as success,
            count(*) filter (where result = 'failure') as failure,
            count(*) filter (where result = 'unstable') as unstable,
            count(*) filter (where result = 'aborted') as aborted,
            percentile_cont(0.5) within group (order by duration_ms) as p50,
            percentile_cont(0.95) within group (order by duration_ms) as p95,
            count(distinct job) as jobs
       from jenkins_builds
      where server = $1 and started_at >= $2 and started_at < $3 and result not in ('running', 'not_built')`,
    [url, from, to],
  )
  const row = rows[0]!
  const [success, failure, unstable] = [row.success, row.failure, row.unstable].map(Number) as [number, number, number]
  const decided = success + failure + unstable
  return {
    builds: Number(row.builds),
    success,
    failure,
    unstable,
    aborted: Number(row.aborted),
    successRate: decided ? success / decided : null,
    p50Ms: row.p50 === null ? null : Math.round(row.p50),
    p95Ms: row.p95 === null ? null : Math.round(row.p95),
    jobs: Number(row.jobs),
  }
}

// ---- search ------------------------------------------------------------------

export type RunFilter = {
  window: Window
  /**
   * Words, all of which must match. `NAME=value` matches a parameter (either
   * side may be partial: `BRANCH=release`); anything else matches the job,
   * a parameter value, what started it, the agent, or `#123`.
   */
  q?: string
  result?: Result
  job?: string
  limit: number
  offset: number
}

export const PAGE_LIMIT = 100

/** Builds in the window matching the filter, newest first, with how many match in all. */
export async function runs(filter: RunFilter): Promise<{ total: number; runs: Run[] }> {
  const values: unknown[] = [server(), WINDOWS[filter.window].hours]
  const where = [`server = $1`, `started_at >= now() - make_interval(hours => $2)`]
  const param = (value: unknown) => `$${values.push(value)}`

  for (const term of (filter.q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
    const eq = term.indexOf('=')
    if (eq > 0) {
      const name = param(`%${escapeLike(term.slice(0, eq))}%`)
      const value = param(`%${escapeLike(term.slice(eq + 1))}%`)
      where.push(
        `exists (select 1 from jsonb_array_elements(parameters) p
                  where p->>'name' ilike ${name} and coalesce(p->>'value', '') ilike ${value} and not (p->>'hidden')::boolean)`,
      )
    } else {
      const like = param(`%${escapeLike(term.replace(/^#(?=\d+$)/, ''))}%`)
      const number = /^#?\d+$/.test(term) ? `or number = ${param(Number(term.replace('#', '')))}` : ''
      where.push(
        `(job ilike ${like} or coalesce(built_on, '') ilike ${like}
          or exists (select 1 from unnest(causes) c where c ilike ${like})
          or exists (select 1 from jsonb_array_elements(parameters) p
                      where not (p->>'hidden')::boolean and (p->>'value' ilike ${like} or p->>'name' ilike ${like}))
          ${number})`,
      )
    }
  }
  if (filter.result) where.push(`result = ${param(filter.result)}`)
  if (filter.job) where.push(`job = ${param(filter.job)}`)

  const clause = where.join(' and ')
  // The count takes the filter's parameters only; limit and offset come after.
  const filterValues = [...values]
  const [page, count] = await Promise.all([
    query<RunRow>(
      `select * from jenkins_builds where ${clause} order by started_at desc, job, number desc
        limit ${param(Math.min(filter.limit, PAGE_LIMIT))} offset ${param(filter.offset)}`,
      values,
    ),
    query<{ n: string }>(`select count(*) as n from jenkins_builds where ${clause}`, filterValues),
  ])
  return { total: Number(count.rows[0]!.n), runs: page.rows.map(toRun) }
}

/** The page's parameter filter: the most used parameter names in the window, each with its commonest values. */
export async function parameters(window: Window): Promise<{ name: string; builds: number; values: { value: string; builds: number }[] }[]> {
  const { rows } = await query<{ name: string; builds: string; values: { value: string; builds: number }[] }>(
    `with p as (
       select e->>'name' as name, e->>'value' as value
         from jenkins_builds, jsonb_array_elements(parameters) e
        where server = $1 and started_at >= now() - make_interval(hours => $2)
          and not (e->>'hidden')::boolean and e->>'value' is not null and e->>'value' <> ''
     ),
     v as (select name, value, count(*) as builds from p group by name, value),
     ranked as (select *, row_number() over (partition by name order by builds desc, value) as rank from v)
     select name, sum(builds) as builds,
            json_agg(json_build_object('value', value, 'builds', builds) order by builds desc, value)
              filter (where rank <= 10) as values
       from ranked group by name order by sum(builds) desc, name limit 30`,
    [server(), WINDOWS[window].hours],
  )
  return rows.map((row) => ({ name: row.name, builds: Number(row.builds), values: row.values }))
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

// ---- one build ---------------------------------------------------------------

/** A build in full, live from Jenkins, with the end of its log. */
export async function run(job: string, number: number): Promise<BuildDetail & { log: string; logTruncated: boolean; logUrl: string }> {
  const [detail, log] = await Promise.all([jenkins.buildDetail(job, number), jenkins.logTail(job, number)])
  // Without Stage View, the log says where it ran — or history already found it.
  const builtOn =
    detail.builtOn ??
    (jenkins.agentsInLog(log.text).join(', ') ||
      (await query<{ built_on: string | null }>('select built_on from jenkins_builds where server = $1 and job = $2 and number = $3', [server(), job, number])).rows[0]?.built_on ||
      null)
  return { ...detail, builtOn, log: log.text, logTruncated: log.truncated, logUrl: `${detail.url}consoleText` }
}

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
    live = null
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
export type IgnoreFor = keyof typeof IGNORE_FOR

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

export type RunRow = {
  job: string
  number: number
  result: Result
  started_at: Date
  duration_ms: string
  url: string
  built_on: string | null
  parameters: Parameter[]
  causes: string[]
}

export function toRun(row: RunRow): Run {
  return {
    job: row.job,
    number: row.number,
    result: row.result,
    startedAt: row.started_at.toISOString(),
    durationMs: Number(row.duration_ms),
    url: row.url,
    builtOn: row.built_on,
    causes: row.causes,
    parameters: row.parameters,
  }
}
