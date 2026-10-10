import type { ParameterFacet, RunDetail, Run, Window } from '@eidp/contracts/jenkins'
import * as jenkins from '../../integrations/jenkins/index.ts'
import type { Result } from '../../integrations/jenkins/index.ts'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import { db, sqlRows } from '../../lib/db.ts'
import { jenkinsBuilds } from './schema.ts'
import { type RunRow, WINDOWS, server, toRun } from './shared.ts'

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
  const where: SQL[] = [sql`server = ${server()}`, sql`started_at >= now() - make_interval(hours => ${WINDOWS[filter.window].hours})`]

  for (const term of (filter.q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
    const at = term.indexOf('=')
    if (at > 0) {
      const name = `%${escapeLike(term.slice(0, at))}%`
      const value = `%${escapeLike(term.slice(at + 1))}%`
      where.push(
        sql`exists (select 1 from jsonb_array_elements(parameters) p
                     where p->>'name' ilike ${name} and coalesce(p->>'value', '') ilike ${value} and not (p->>'hidden')::boolean)`,
      )
    } else {
      const like = `%${escapeLike(term.replace(/^#(?=\d+$)/, ''))}%`
      const number = /^#?\d+$/.test(term) ? sql`or number = ${Number(term.replace('#', ''))}` : sql``
      where.push(
        sql`(job ilike ${like} or coalesce(built_on, '') ilike ${like}
             or exists (select 1 from unnest(causes) c where c ilike ${like})
             or exists (select 1 from jsonb_array_elements(parameters) p
                         where not (p->>'hidden')::boolean and (p->>'value' ilike ${like} or p->>'name' ilike ${like}))
             ${number})`,
      )
    }
  }
  if (filter.result) where.push(sql`result = ${filter.result}`)
  if (filter.job) where.push(sql`job = ${filter.job}`)

  const clause = sql.join(where, sql` and `)
  const [page, count] = await Promise.all([
    sqlRows<RunRow>(
      sql`select * from ${jenkinsBuilds} where ${clause} order by started_at desc, job, number desc
           limit ${Math.min(filter.limit, PAGE_LIMIT)} offset ${filter.offset}`,
    ),
    sqlRows<{ n: string }>(sql`select count(*) as n from ${jenkinsBuilds} where ${clause}`),
  ])
  return { total: Number(count[0]!.n), runs: page.map(toRun) }
}

/** The page's parameter filter: the most used parameter names in the window, each with its commonest values. */
export async function parameters(window: Window): Promise<ParameterFacet[]> {
  const rows = await sqlRows<{ name: string; builds: string; values: { value: string; builds: number }[] }>(
    sql`with p as (
       select e->>'name' as name, e->>'value' as value
         from ${jenkinsBuilds}, jsonb_array_elements(parameters) e
        where server = ${server()} and started_at >= now() - make_interval(hours => ${WINDOWS[window].hours})
          and not (e->>'hidden')::boolean and e->>'value' is not null and e->>'value' <> ''
     ),
     v as (select name, value, count(*) as builds from p group by name, value),
     ranked as (select *, row_number() over (partition by name order by builds desc, value) as rank from v)
     select name, sum(builds) as builds,
            json_agg(json_build_object('value', value, 'builds', builds) order by builds desc, value)
              filter (where rank <= 10) as values
       from ranked group by name order by sum(builds) desc, name limit 30`,
  )
  return rows.map((row) => ({ name: row.name, builds: Number(row.builds), values: row.values }))
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

// ---- one build ---------------------------------------------------------------

/** A build in full, live from Jenkins, with the end of its log. */
export async function run(job: string, number: number): Promise<Omit<RunDetail, 'canOperate'>> {
  const [detail, log] = await Promise.all([jenkins.buildDetail(job, number), jenkins.logTail(job, number)])
  // Without Stage View, the log says where it ran — or history already found it.
  const builtOn =
    detail.builtOn ??
    (jenkins.agentsInLog(log.text).join(', ') ||
      (await stored(job, number)) ||
      null)
  return { ...detail, builtOn, log: log.text, logTruncated: log.truncated, logUrl: `${detail.url}consoleText` }
}

/** The agent history found for a build, if any. */
async function stored(job: string, number: number): Promise<string | null> {
  const b = jenkinsBuilds
  const [row] = await db.select({ builtOn: b.builtOn }).from(b).where(and(eq(b.server, server()), eq(b.job, job), eq(b.number, number)))
  return row?.builtOn ?? null
}
