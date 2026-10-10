import type { Activity, Feed, FeedQuery, Group, Overview, Person, Window } from '@eidp/contracts/activity'
export type { Activity, Group, Overview, Person, Window }
import { config } from '../lib/config.ts'
import { query } from '../lib/db.ts'
import { errorFields, log } from '../lib/log.ts'

/**
 * Platform activity: who uses the portal and what they do in it.
 *
 * Most of it is already recorded where it happens, and is read from there —
 * requests filed and decided (`requests`), access granted, changed, removed
 * and viewed-as (`rbac_audit`), Jenkins actions (`jenkins_audit`), failures
 * someone asked the AI to explain (`build_explanations`). What nothing else
 * recorded lives in `activity_events`: sign-ins, refused sign-ins (the name
 * typed and why, never the password), pages opened (the path, never its
 * query), and chatbot questions (that one was asked, never its words).
 *
 * Page visits feed the counts and the pages chart, never the feed: one line
 * per click would bury everything that matters.
 */

export const WINDOWS = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 } as const satisfies Record<Window, number>

export type EventKind = 'sign_in' | 'sign_in_failed' | 'visit' | 'chat'

/** What the feed can be narrowed to. */
export const GROUPS = ['sign-in', 'requests', 'access', 'jenkins', 'ai'] as const satisfies readonly Group[]

// ---- recording ------------------------------------------------------------------------

/**
 * Records one event. Never throws: losing a line of activity must not fail
 * the sign-in or the question it describes.
 */
export async function record(event: { uid: string; name: string; kind: EventKind; path?: string | null; reason?: string | null }): Promise<void> {
  try {
    const path = event.path ? cleanPath(event.path) : null
    await query(`insert into activity_events (uid, name, kind, path, section, reason) values ($1, $2, $3, $4, $5, $6)`, [
      event.uid.slice(0, 256),
      event.name.slice(0, 256),
      event.kind,
      path,
      path ? sectionOf(path) : null,
      event.reason?.slice(0, 120) ?? null,
    ])
  } catch (err) {
    log.error('activity could not be recorded', { kind: event.kind, ...errorFields(err) })
  }
}

/**
 * A page opened. The same person on the same path within half a minute is one
 * visit — a reload, or back and forth, is not interest.
 */
export async function recordVisit(uid: string, name: string, rawPath: string): Promise<void> {
  const path = cleanPath(rawPath)
  await query(
    `insert into activity_events (uid, name, kind, path, section)
     select $1, $2, 'visit', $3, $4
      where not exists (select 1 from activity_events
                         where kind = 'visit' and lower(uid) = lower($1) and path = $3 and at > now() - interval '30 seconds')`,
    [uid, name, path, sectionOf(path)],
  )
}

/** Drops what is older than ACTIVITY_RETENTION_DAYS. */
export async function prune(): Promise<number> {
  const { rowCount } = await query(`delete from activity_events where at < now() - make_interval(days => $1)`, [config.ACTIVITY_RETENTION_DAYS])
  return rowCount ?? 0
}

/** A portal path only: no query or fragment (they can carry searches), no doubled slashes, bounded. */
export function cleanPath(raw: string): string {
  const path = raw.split(/[?#]/)[0]!.replace(/\/{2,}/g, '/').slice(0, 300)
  return path.startsWith('/') ? path : `/${path}`
}

const SECTIONS: [RegExp, string][] = [
  [/^\/$/, 'Overview'],
  [/^\/(map|projects)(\/|$)/, 'Projects map'],
  [/^\/pipelines(\/|$)/, 'My pipelines'],
  [/^\/digest(\/|$)/, 'Weekly digest'],
  [/^\/(chatbot|assistant)(\/|$)/, 'Chatbot'],
  [/^\/requests\/new(\/|$)/, 'New request'],
  [/^\/requests(\/|$)/, 'My requests'],
  [/^\/approvals(\/|$)/, 'Approvals'],
  [/^\/jenkins(\/|$)/, 'Jenkins'],
  [/^\/access(\/|$)/, 'Access'],
  [/^\/activity(\/|$)/, 'Platform activity'],
  [/^\/me(\/|$)/, 'Your profile'],
]

/** The part of the portal a path is in, as the sidebar names it. */
export function sectionOf(path: string): string {
  return SECTIONS.find(([pattern]) => pattern.test(path))?.[1] ?? 'Other'
}

// ---- reading --------------------------------------------------------------------------

/**
 * Everything people did between $1 and $2, one row each, from every table
 * that records it. `grp` is what the feed filters by; a..c carry what the
 * line says, by kind. $3 is the Jenkins server whose explanations count.
 */
const EVERYTHING = `
  select 'e' || id as id, at, uid, name, kind,
         case kind when 'chat' then 'ai' when 'visit' then 'visit' else 'sign-in' end as grp,
         path as a, section as b, reason as c, kind <> 'sign_in_failed' as ok
    from activity_events where at >= $1 and at < $2
  union all
  select 'rf' || id, requested_at, requested_by, requested_by_name, 'request_filed', 'requests',
         kind, coalesce(repository, project_key, project), id::text, true
    from requests where requested_at >= $1 and requested_at < $2
  union all
  select 'rd' || id, decided_at, decided_by, coalesce(decided_by_name, decided_by),
         case status when 'rejected' then 'request_rejected' when 'cancelled' then 'request_cancelled' else 'request_approved' end,
         'requests', kind, coalesce(repository, project_key, project), id::text, true
    from requests where decided_at >= $1 and decided_at < $2 and decided_by is not null
  union all
  select 'ra' || id, at, actor, actor, case action when 'assume' then 'view_as' else 'access_' || action end, 'access',
         binding->>'role', coalesce(target, binding->>'subject'), binding->>'scope', true
    from rbac_audit where at >= $1 and at < $2
  union all
  select 'ja' || id, at, actor, actor_name, 'jenkins_' || action, 'jenkins', job, build::text, coalesce(error, note), ok
    from jenkins_audit where at >= $1 and at < $2
  union all
  select 'bx' || md5(job || '#' || number || model || prompt_version), created_at, created_by, created_by_name, 'explain', 'ai',
         job, number::text, null, true
    from build_explanations where created_at >= $1 and created_at < $2 and server = $3 and created_by <> 'e-idp'`

type Row = { id: string; at: Date; uid: string; name: string; kind: string; grp: string; a: string | null; b: string | null; c: string | null; ok: boolean }


const REQUEST_KIND: Record<string, string> = {
  create_repository: 'a repository',
  create_project: 'an Azure DevOps project',
  grant_access: 'access to a project',
  create_jira_project: 'a Jira project',
}

const SIGN_IN_REASON: Record<string, string> = {
  invalid_credentials: 'wrong name or password',
  account_locked: 'account locked',
  account_disabled: 'account disabled',
  account_expired: 'account expired',
  password_expired: 'password expired',
  password_must_change: 'must change password',
  logon_time_restricted: 'not allowed to sign in at this hour',
  logon_workstation_restricted: 'not allowed from that machine',
}

const buildLink = (job: string | null, number: string | null) =>
  job && number ? `/jenkins/build?job=${encodeURIComponent(job)}&number=${number}` : job ? `/jenkins?tab=builds&q=${encodeURIComponent(job)}` : null

function toActivity(r: Row): Activity {
  const base = { id: r.id, at: r.at.toISOString(), uid: r.uid, name: r.name, kind: r.kind, group: r.grp as Group, ok: r.ok }
  const request = { target: r.b, link: r.c ? `/requests/${r.c}` : null, note: null }
  switch (r.kind) {
    case 'sign_in':
      return { ...base, verb: 'signed in', target: null, link: null, note: null }
    case 'sign_in_failed':
      return { ...base, verb: 'could not sign in', target: null, link: null, note: r.c ? (SIGN_IN_REASON[r.c] ?? r.c.replaceAll('_', ' ')) : null }
    case 'chat':
      return { ...base, verb: 'asked the chatbot', target: null, link: null, note: r.b && r.b !== 'Chatbot' ? `from ${r.b}` : null }
    case 'request_filed':
      return { ...base, verb: `asked for ${REQUEST_KIND[r.a ?? ''] ?? 'something'}`, ...request }
    case 'request_approved':
      return { ...base, verb: `approved a request for ${REQUEST_KIND[r.a ?? ''] ?? 'something'}`, ...request }
    case 'request_rejected':
      return { ...base, verb: `rejected a request for ${REQUEST_KIND[r.a ?? ''] ?? 'something'}`, ...request }
    case 'request_cancelled':
      return { ...base, verb: 'withdrew their request for', ...request, target: r.b }
    case 'access_grant':
    case 'access_revoke':
    case 'access_update':
      return {
        ...base,
        verb: `${r.kind === 'access_grant' ? 'granted' : r.kind === 'access_revoke' ? 'removed' : 'changed'} ${r.a ?? 'a role'} ${r.kind === 'access_revoke' ? 'from' : r.kind === 'access_grant' ? 'to' : 'for'}`,
        target: r.b,
        link: r.b ? `/access?q=${encodeURIComponent(r.b)}` : '/access',
        note: r.c ? `in ${r.c}` : null,
      }
    case 'view_as':
      return { ...base, verb: 'viewed the portal as', target: r.b, link: '/access?tab=audit', note: null }
    case 'jenkins_rebuild':
    case 'jenkins_stop':
    case 'jenkins_cancel':
    case 'jenkins_ignore':
    case 'jenkins_unignore': {
      // What they did, and what they tried to do when Jenkins (or their scope) refused.
      const [done, tried] = {
        jenkins_rebuild: ['ran again', 'run again'],
        jenkins_stop: ['stopped', 'stop'],
        jenkins_cancel: ['took out of the queue', 'take out of the queue'],
        jenkins_ignore: ['set aside the failures of', 'set aside the failures of'],
        jenkins_unignore: ['stopped ignoring', 'stop ignoring'],
      }[r.kind]
      return {
        ...base,
        verb: r.ok ? done : `tried to ${tried}`,
        target: r.b ? `${r.a} #${r.b}` : r.a,
        link: buildLink(r.a, r.b),
        note: r.c,
      }
    }
    case 'explain':
      return { ...base, verb: 'asked the AI why a build failed', target: `${r.a} #${r.b}`, link: buildLink(r.a, r.b), note: null }
    default:
      return { ...base, verb: r.kind.replaceAll('_', ' '), target: r.b, link: null, note: null }
  }
}

function span(window: Window, now = new Date()) {
  const hours = WINDOWS[window]
  const end = now
  const start = new Date(end.getTime() - hours * 3_600_000)
  const before = new Date(start.getTime() - hours * 3_600_000)
  return { start, end, before }
}

/** The Jenkins whose explanations count; none when Jenkins is not configured. */
const server = () => (config.JENKINS_URL ? config.JENKINS_URL.replace(/\/+$/, '') : '')

/**
 * The feed: newest first, at most `limit` lines before `before` (the cursor
 * the last page ended at). Narrowed by person, kind of thing and words.
 */
export async function feed({
  window = '7d',
  who,
  group,
  q,
  before,
  limit = 100,
}: Partial<FeedQuery> & { limit?: number }): Promise<Feed> {
  const { start, end } = span(window)
  const until = before ? new Date(Math.min(new Date(before).getTime(), end.getTime())) : end
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const params: unknown[] = [start, until, server(), limit + 1]
  const where = [`grp <> 'visit'`]
  if (who) {
    params.push(who.toLowerCase())
    where.push(`lower(uid) = $${params.length}`)
  }
  if (group) {
    params.push(group)
    where.push(`grp = $${params.length}`)
  }
  for (const word of words) {
    params.push(`%${word.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)
    where.push(`lower(concat_ws(' ', uid, name, a, b, c)) like $${params.length}`)
  }
  const { rows } = await query<Row>(`select * from (${EVERYTHING}) as e where ${where.join(' and ')} order by at desc, id desc limit $4`, params)
  const items = rows.slice(0, limit).map(toActivity)
  return { items, next: rows.length > limit ? items.at(-1)!.at : null }
}


/** The window at a glance: totals against the window before, activity over time, the pages and people. */
export async function overview(window: Window = '7d'): Promise<Overview> {
  const { start, end, before } = span(window)
  const bucket = window === '24h' ? 'hour' : 'day'
  const [totals, series, sections, people, refused] = await Promise.all([
    query<Record<string, number> & { now: boolean }>(
      `select at >= $4 as now,
              count(distinct lower(uid)) filter (where kind <> 'sign_in_failed')::int as people,
              count(*) filter (where kind = 'sign_in')::int as "signIns",
              count(*) filter (where kind = 'sign_in_failed')::int as "failedSignIns",
              count(*) filter (where kind = 'visit')::int as visits,
              count(*) filter (where kind = 'request_filed')::int as requests,
              count(*) filter (where kind in ('request_approved', 'request_rejected'))::int as decisions,
              count(*) filter (where grp in ('access', 'jenkins'))::int as actions,
              count(*) filter (where grp = 'ai')::int as ai
         from (${EVERYTHING}) as e group by 1`,
      [before, end, server(), start],
    ),
    query<{ at: Date; people: number; events: number }>(
      `select b.at, count(distinct lower(e.uid)) filter (where e.kind <> 'sign_in_failed')::int as people,
              count(e.id) filter (where e.grp <> 'visit')::int as events
         from generate_series(date_trunc('${bucket}', $1::timestamptz), $2::timestamptz, interval '1 ${bucket}') as b(at)
         left join (${EVERYTHING}) as e on date_trunc('${bucket}', e.at) = b.at
        group by b.at order by b.at`,
      [start, end, server()],
    ),
    query<{ label: string; value: number; people: number }>(
      `select section as label, count(*)::int as value, count(distinct lower(uid))::int as people
         from activity_events where kind = 'visit' and at >= $1 and at < $2
        group by section order by value desc, label`,
      [start, end],
    ),
    query<{ uid: string; name: string; value: number }>(
      `select min(uid) as uid, max(name) as name, count(*)::int as value
         from (${EVERYTHING}) as e where grp not in ('visit') and kind <> 'sign_in_failed'
        group by lower(uid) order by value desc, uid limit 8`,
      [start, end, server()],
    ),
    query<{ uid: string; count: number; reasons: string[]; last: Date }>(
      `select min(uid) as uid, count(*)::int as count, array_agg(distinct coalesce(reason, 'unknown')) as reasons, max(at) as last
         from activity_events where kind = 'sign_in_failed' and at >= $1 and at < $2
        group by lower(uid) having count(*) >= 5 order by count desc`,
      [start, end],
    ),
  ])

  const zero = { people: 0, signIns: 0, failedSignIns: 0, visits: 0, requests: 0, decisions: 0, actions: 0, ai: 0 }
  const nowRow = totals.rows.find((r) => r.now) ?? zero
  const beforeRow = totals.rows.find((r) => !r.now) ?? zero
  const keys = Object.keys(zero) as (keyof typeof zero)[]

  const top = sections.rows.slice(0, 8)
  const rest = sections.rows.slice(8)
  return {
    window,
    totals: Object.fromEntries(keys.map((k) => [k, { now: Number(nowRow[k] ?? 0), before: Number(beforeRow[k] ?? 0) }])) as Overview['totals'],
    series: series.rows.map((r) => ({ at: r.at.toISOString(), people: r.people, events: r.events })),
    sections: rest.length
      ? [...top, { label: 'Other', value: rest.reduce((n, r) => n + r.value, 0), people: Math.max(...rest.map((r) => r.people)) }]
      : top,
    people: people.rows,
    refused: refused.rows.map((r) => ({ uid: r.uid, count: r.count, reasons: r.reasons.map((x) => SIGN_IN_REASON[x] ?? x.replaceAll('_', ' ')), last: r.last.toISOString() })),
    retentionDays: config.ACTIVITY_RETENTION_DAYS,
  }
}


/** Everyone who did anything in the window, most recently seen first. */
export async function people(window: Window = '7d'): Promise<Person[]> {
  const { start, end } = span(window)
  const { rows } = await query<Person & { lastSeen: Date }>(
    `select min(uid) as uid, max(name) filter (where kind <> 'sign_in_failed') as name, max(at) as "lastSeen",
            count(*) filter (where kind = 'sign_in')::int as "signIns",
            count(*) filter (where kind = 'sign_in_failed')::int as "failedSignIns",
            count(*) filter (where kind = 'visit')::int as visits,
            count(*) filter (where kind = 'request_filed')::int as requests,
            count(*) filter (where kind in ('request_approved', 'request_rejected'))::int as decisions,
            count(*) filter (where grp in ('access', 'jenkins'))::int as actions,
            count(*) filter (where grp = 'ai')::int as ai,
            mode() within group (order by b) filter (where kind = 'visit') as "topSection"
       from (${EVERYTHING}) as e
      group by lower(uid) order by max(at) desc`,
    [start, end, server()],
  )
  return rows.map((r) => ({ ...r, name: r.name ?? r.uid, lastSeen: r.lastSeen.toISOString() }))
}
