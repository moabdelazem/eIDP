import type { Category, Recovery, Stats, Totals, Window } from '@eidp/contracts/jenkins'
import { sql } from 'drizzle-orm'
import { sqlRows } from '../../lib/db.ts'
import { buildExplanations, jenkinsBuilds, jenkinsIgnored } from './schema.ts'
import { run } from './search.ts'
import { IGNORE_HOLDS, WINDOWS, server } from './shared.ts'

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
    sqlRows<{ n: string }>(sql`select count(*) as n from ${jenkinsBuilds} where server = ${url} and result = 'running'`),
    sqlRows<{ at: Date; success: string; failure: string; unstable: string; aborted: string; p50: number | null; p95: number | null }>(sql`with buckets as (
         select generate_series(${from}::timestamptz, ${to}::timestamptz - make_interval(hours => ${bucket}), make_interval(hours => ${bucket})) as at
       )
       select k.at,
              count(*) filter (where b.result = 'success') as success,
              count(*) filter (where b.result = 'failure') as failure,
              count(*) filter (where b.result = 'unstable') as unstable,
              count(*) filter (where b.result = 'aborted') as aborted,
              percentile_cont(0.5) within group (order by b.duration_ms) filter (where b.result not in ('running', 'not_built')) as p50,
              percentile_cont(0.95) within group (order by b.duration_ms) filter (where b.result not in ('running', 'not_built')) as p95
         from buckets k
         left join ${jenkinsBuilds} b
           on b.server = ${url} and b.started_at >= k.at and b.started_at < k.at + make_interval(hours => ${bucket})
        group by k.at order by k.at`),
    sqlRows<{ job: string; builds: string; broken: string; last_broken: Date; ignored: boolean }>(sql`select job, count(*) as builds,
              count(*) filter (where result in ('failure', 'unstable')) as broken,
              max(started_at) filter (where result in ('failure', 'unstable')) as last_broken,
              exists (select 1 from ${jenkinsIgnored} i where i.server = ${url} and i.job = b.job and ${IGNORE_HOLDS}) as ignored
         from ${jenkinsBuilds} b
        where server = ${url} and started_at >= ${from} and started_at < ${to} and result not in ('running', 'not_built')
        group by job
       having count(*) filter (where result in ('failure', 'unstable')) > 0
        order by broken desc, last_broken desc limit 8`),
    sqlRows<{ job: string; builds: string; p50: number; p95: number }>(sql`select job, count(*) as builds,
              percentile_cont(0.5) within group (order by duration_ms) as p50,
              percentile_cont(0.95) within group (order by duration_ms) as p95
         from ${jenkinsBuilds}
        where server = ${url} and started_at >= ${from} and started_at < ${to} and result not in ('running', 'not_built')
        group by job order by p50 desc limit 8`),
    recovery(url, from, to),
    recovery(url, before, from),
    // A run that moved between agents counts for each; built_on lists them "a, b".
    sqlRows<{ agent: string; builds: string; broken: string; busy: string }>(sql`with per as (
         select trim(a) as agent, b.result, b.duration_ms
           from ${jenkinsBuilds} b, unnest(string_to_array(b.built_on, ',')) a
          where b.server = ${url} and b.started_at >= ${from} and b.started_at < ${to} and b.built_on is not null
       )
       select agent, count(*) as builds, count(*) filter (where result in ('failure', 'unstable')) as broken,
              coalesce(sum(duration_ms), 0) as busy
         from per group by agent order by count(*) desc, agent`),
    sqlRows<{ trigger: string; builds: string }>(sql`select coalesce(
                substring(causes[1] from '^Started by user (.+)$'),
                case when causes[1] ilike '%SCM change%' or causes[1] ilike '%push%' then 'SCM change'
                     when causes[1] ilike '%timer%' then 'Timer'
                     when causes[1] ilike '%upstream%' then 'Upstream job'
                     when causes[1] ilike '%remote%' then 'Remote call'
                     when causes[1] is null then 'Unknown'
                     else causes[1] end) as trigger,
              count(*) as builds
         from ${jenkinsBuilds}
        where server = ${url} and started_at >= ${from} and started_at < ${to}
        group by 1 order by count(*) desc, 1`),
    sqlRows<{ category: Category; builds: string }>(sql`select e.category, count(*) as builds
         from (select distinct on (x.job, x.number) x.job, x.number, x.explanation->>'category' as category
                 from ${buildExplanations} x where x.server = ${url}
                order by x.job, x.number, x.created_at desc) e
         join ${jenkinsBuilds} b on b.server = ${url} and b.job = e.job and b.number = e.number
        where b.started_at >= ${from} and b.started_at < ${to} and b.result in ('failure', 'unstable')
        group by e.category order by count(*) desc, e.category`),
  ])

  return {
    window,
    from: from.toISOString(),
    to: to.toISOString(),
    current,
    previous,
    running: Number(running[0]!.n),
    timeline: timeline.map((row) => {
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
    topFailing: topFailing.map((row) => ({
      job: row.job,
      builds: Number(row.builds),
      broken: Number(row.broken),
      rate: Number(row.broken) / Number(row.builds),
      lastBroken: row.last_broken.toISOString(),
      ignored: row.ignored,
    })),
    slowest: slowest.map((row) => ({ job: row.job, builds: Number(row.builds), p50Ms: Math.round(row.p50), p95Ms: Math.round(row.p95) })),
    recovery: { current: recoveryNow, previous: recoveryBefore },
    agents: topAndOther(
      agents.map((row) => ({ agent: row.agent, builds: Number(row.builds), broken: Number(row.broken), busyMs: Number(row.busy) })),
      (rest) => ({ agent: 'Other', builds: sum(rest, 'builds'), broken: sum(rest, 'broken'), busyMs: sum(rest, 'busyMs') }),
    ),
    triggers: topAndOther(
      triggers.map((row) => ({ trigger: row.trigger, builds: Number(row.builds) })),
      (rest) => ({ trigger: 'Other', builds: sum(rest, 'builds') }),
    ),
    categories: categories.map((row) => ({ category: row.category, builds: Number(row.builds) })),
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
  const rows = await sqlRows<{ fixes: string; median: number | null; longest: number | null }>(sql`with finished as (
       select job, number, result, started_at,
              lag(result) over w as before,
              max(number) filter (where result = 'success') over (w rows between unbounded preceding and 1 preceding) as last_pass
         from ${jenkinsBuilds}
        where server = ${url} and result in ('success', 'failure', 'unstable')
       window w as (partition by job order by number)
     ),
     fixes as (
       select p.started_at - (select min(b.started_at) from ${jenkinsBuilds} b
                               where b.server = ${url} and b.job = p.job and b.result in ('failure', 'unstable')
                                 and b.number > coalesce(p.last_pass, 0) and b.number < p.number) as took
         from finished p
        where p.result = 'success' and p.before in ('failure', 'unstable') and p.started_at >= ${from} and p.started_at < ${to}
     )
     select count(*) as fixes,
            percentile_cont(0.5) within group (order by extract(epoch from took) * 1000) as median,
            max(extract(epoch from took) * 1000) as longest
       from fixes where took is not null`)
  const row = rows[0]!
  return { fixes: Number(row.fixes), medianMs: row.median === null ? null : Math.round(row.median), longestMs: row.longest === null ? null : Math.round(Number(row.longest)) }
}

async function totals(url: string, from: Date, to: Date): Promise<Totals> {
  const rows = await sqlRows<{
    builds: string
    success: string
    failure: string
    unstable: string
    aborted: string
    p50: number | null
    p95: number | null
    jobs: string
  }>(sql`select count(*) as builds,
            count(*) filter (where result = 'success') as success,
            count(*) filter (where result = 'failure') as failure,
            count(*) filter (where result = 'unstable') as unstable,
            count(*) filter (where result = 'aborted') as aborted,
            percentile_cont(0.5) within group (order by duration_ms) as p50,
            percentile_cont(0.95) within group (order by duration_ms) as p95,
            count(distinct job) as jobs
       from ${jenkinsBuilds}
      where server = ${url} and started_at >= ${from} and started_at < ${to} and result not in ('running', 'not_built')`)
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
