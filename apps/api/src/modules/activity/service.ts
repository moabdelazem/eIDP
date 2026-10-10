import type { Activity, Feed, FeedQuery, Group, Overview, Person, Window } from '@eidp/contracts/activity'
export type { Activity, Group, Overview, Person, Window }
import { config } from '../../lib/config.ts'
import { and, eq, gte, lt, sql, type SQL } from 'drizzle-orm'
import { db, sqlRows } from '../../lib/db.ts'
import { errorFields, log } from '../../lib/log.ts'
import { rbacAudit } from '../access/index.ts'
import { buildExplanations, jenkinsAudit } from '../jenkins/index.ts'
import { requests } from '../requests/index.ts'
import { activityEvents } from './schema.ts'

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
    await db.insert(activityEvents).values({
      uid: event.uid.slice(0, 256),
      name: event.name.slice(0, 256),
      kind: event.kind,
      path,
      section: path ? sectionOf(path) : null,
      reason: event.reason?.slice(0, 120) ?? null,
    })
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
  const e = activityEvents
  await db.execute(sql`
    insert into ${e} (uid, name, kind, path, section)
    select ${uid}, ${name}, 'visit', ${path}, ${sectionOf(path)}
     where not exists (select 1 from ${e}
                        where kind = 'visit' and lower(uid) = lower(${uid}) and path = ${path} and at > now() - interval '30 seconds')`)
}

/** Drops what is older than ACTIVITY_RETENTION_DAYS. */
export async function prune(): Promise<number> {
  const gone = await db
    .delete(activityEvents)
    .where(lt(activityEvents.at, sql`now() - make_interval(days => ${config.ACTIVITY_RETENTION_DAYS})`))
    .returning({ id: activityEvents.id })
  return gone.length
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
 * Everything people did between `from` and `to`, one row each, from every
 * table that records it — the other modules' read through their indexes.
 * `grp` is what the feed filters by; a..c carry what the line says, by kind.
 * Only the configured Jenkins server's explanations count.
 */
const everything = (from: Date, to: Date): SQL => sql`
  select 'e' || id as id, at, uid, name, kind,
         case kind when 'chat' then 'ai' when 'visit' then 'visit' else 'sign-in' end as grp,
         path as a, section as b, reason as c, kind <> 'sign_in_failed' as ok
    from ${activityEvents} where at >= ${from} and at < ${to}
  union all
  select 'rf' || id, requested_at, requested_by, requested_by_name, 'request_filed', 'requests',
         kind, coalesce(repository, project_key, project), id::text, true
    from ${requests} where requested_at >= ${from} and requested_at < ${to}
  union all
  select 'rd' || id, decided_at, decided_by, coalesce(decided_by_name, decided_by),
         case status when 'rejected' then 'request_rejected' when 'cancelled' then 'request_cancelled' else 'request_approved' end,
         'requests', kind, coalesce(repository, project_key, project), id::text, true
    from ${requests} where decided_at >= ${from} and decided_at < ${to} and decided_by is not null
  union all
  select 'ra' || id, at, actor, actor, case action when 'assume' then 'view_as' else 'access_' || action end, 'access',
         binding->>'role', coalesce(target, binding->>'subject'), binding->>'scope', true
    from ${rbacAudit} where at >= ${from} and at < ${to}
  union all
  select 'ja' || id, at, actor, actor_name, 'jenkins_' || action, 'jenkins', job, build::text, coalesce(error, note), ok
    from ${jenkinsAudit} where at >= ${from} and at < ${to}
  union all
  select 'bx' || md5(job || '#' || number || model || prompt_version), created_at, created_by, created_by_name, 'explain', 'ai',
         job, number::text, null, true
    from ${buildExplanations} where created_at >= ${from} and created_at < ${to} and server = ${server()} and created_by <> 'e-idp'`

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
  const where = [sql`grp <> 'visit'`]
  if (who) where.push(sql`lower(uid) = ${who.toLowerCase()}`)
  if (group) where.push(sql`grp = ${group}`)
  for (const word of words) {
    where.push(sql`lower(concat_ws(' ', uid, name, a, b, c)) like ${`%${word.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}`)
  }
  const rows = await sqlRows<Row>(
    sql`select * from (${everything(start, until)}) as e where ${sql.join(where, sql` and `)} order by at desc, id desc limit ${limit + 1}`,
  )
  const items = rows.slice(0, limit).map(toActivity)
  return { items, next: rows.length > limit ? items.at(-1)!.at : null }
}


/** The window at a glance: totals against the window before, activity over time, the pages and people. */
export async function overview(window: Window = '7d'): Promise<Overview> {
  const { start, end, before } = span(window)
  const bucket = sql.raw(window === '24h' ? 'hour' : 'day')
  const e = activityEvents
  const [totals, series, sections, people, refused] = await Promise.all([
    sqlRows<Record<string, number> & { now: boolean }>(
      sql`select at >= ${start} as now,
              count(distinct lower(uid)) filter (where kind <> 'sign_in_failed')::int as people,
              count(*) filter (where kind = 'sign_in')::int as "signIns",
              count(*) filter (where kind = 'sign_in_failed')::int as "failedSignIns",
              count(*) filter (where kind = 'visit')::int as visits,
              count(*) filter (where kind = 'request_filed')::int as requests,
              count(*) filter (where kind in ('request_approved', 'request_rejected'))::int as decisions,
              count(*) filter (where grp in ('access', 'jenkins'))::int as actions,
              count(*) filter (where grp = 'ai')::int as ai
         from (${everything(before, end)}) as e group by 1`,
    ),
    sqlRows<{ at: Date; people: number; events: number }>(
      sql`select b.at, count(distinct lower(e.uid)) filter (where e.kind <> 'sign_in_failed')::int as people,
              count(e.id) filter (where e.grp <> 'visit')::int as events
         from generate_series(date_trunc('${bucket}', ${start}::timestamptz), ${end}::timestamptz, interval '1 ${bucket}') as b(at)
         left join (${everything(start, end)}) as e on date_trunc('${bucket}', e.at) = b.at
        group by b.at order by b.at`,
    ),
    db
      .select({ label: e.section, value: sql<number>`count(*)::int`, people: sql<number>`count(distinct lower(${e.uid}))::int` })
      .from(e)
      .where(and(eq(e.kind, 'visit'), gte(e.at, start), lt(e.at, end)))
      .groupBy(e.section)
      .orderBy(sql`2 desc`, e.section),
    sqlRows<{ uid: string; name: string; value: number }>(
      sql`select min(uid) as uid, max(name) as name, count(*)::int as value
         from (${everything(start, end)}) as e where grp not in ('visit') and kind <> 'sign_in_failed'
        group by lower(uid) order by value desc, uid limit 8`,
    ),
    sqlRows<{ uid: string; count: number; reasons: string[]; last: Date }>(
      sql`select min(uid) as uid, count(*)::int as count, array_agg(distinct coalesce(reason, 'unknown')) as reasons, max(at) as last
         from ${e} where kind = 'sign_in_failed' and at >= ${start} and at < ${end}
        group by lower(uid) having count(*) >= 5 order by count desc`,
    ),
  ])

  const zero = { people: 0, signIns: 0, failedSignIns: 0, visits: 0, requests: 0, decisions: 0, actions: 0, ai: 0 }
  const nowRow = totals.find((r) => r.now) ?? zero
  const beforeRow = totals.find((r) => !r.now) ?? zero
  const keys = Object.keys(zero) as (keyof typeof zero)[]

  const visited = sections.map((r) => ({ ...r, label: r.label ?? 'Other' }))
  const top = visited.slice(0, 8)
  const rest = visited.slice(8)
  return {
    window,
    totals: Object.fromEntries(keys.map((k) => [k, { now: Number(nowRow[k] ?? 0), before: Number(beforeRow[k] ?? 0) }])) as Overview['totals'],
    series: series.map((r) => ({ at: r.at.toISOString(), people: r.people, events: r.events })),
    sections: rest.length
      ? [...top, { label: 'Other', value: rest.reduce((n, r) => n + r.value, 0), people: Math.max(...rest.map((r) => r.people)) }]
      : top,
    people,
    refused: refused.map((r) => ({ uid: r.uid, count: r.count, reasons: r.reasons.map((x) => SIGN_IN_REASON[x] ?? x.replaceAll('_', ' ')), last: r.last.toISOString() })),
    retentionDays: config.ACTIVITY_RETENTION_DAYS,
  }
}


/** Everyone who did anything in the window, most recently seen first. */
export async function people(window: Window = '7d'): Promise<Person[]> {
  const { start, end } = span(window)
  const rows = await sqlRows<Person & { lastSeen: Date }>(
    sql`select min(uid) as uid, max(name) filter (where kind <> 'sign_in_failed') as name, max(at) as "lastSeen",
            count(*) filter (where kind = 'sign_in')::int as "signIns",
            count(*) filter (where kind = 'sign_in_failed')::int as "failedSignIns",
            count(*) filter (where kind = 'visit')::int as visits,
            count(*) filter (where kind = 'request_filed')::int as requests,
            count(*) filter (where kind in ('request_approved', 'request_rejected'))::int as decisions,
            count(*) filter (where grp in ('access', 'jenkins'))::int as actions,
            count(*) filter (where grp = 'ai')::int as ai,
            mode() within group (order by b) filter (where kind = 'visit') as "topSection"
       from (${everything(start, end)}) as e
      group by lower(uid) order by max(at) desc`,
  )
  return rows.map((r) => ({ ...r, name: r.name ?? r.uid, lastSeen: r.lastSeen.toISOString() }))
}
