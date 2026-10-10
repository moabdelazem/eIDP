import type { ParameterFacet, RunDetail, Run, Window } from '@eidp/contracts/jenkins'
import * as jenkins from '../../integrations/jenkins/index.ts'
import type { Result } from '../../integrations/jenkins/index.ts'
import { query } from '../../lib/db.ts'
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
export async function parameters(window: Window): Promise<ParameterFacet[]> {
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
export async function run(job: string, number: number): Promise<Omit<RunDetail, 'canOperate'>> {
  const [detail, log] = await Promise.all([jenkins.buildDetail(job, number), jenkins.logTail(job, number)])
  // Without Stage View, the log says where it ran — or history already found it.
  const builtOn =
    detail.builtOn ??
    (jenkins.agentsInLog(log.text).join(', ') ||
      (await query<{ built_on: string | null }>('select built_on from jenkins_builds where server = $1 and job = $2 and number = $3', [server(), job, number])).rows[0]?.built_on ||
      null)
  return { ...detail, builtOn, log: log.text, logTruncated: log.truncated, logUrl: `${detail.url}consoleText` }
}
