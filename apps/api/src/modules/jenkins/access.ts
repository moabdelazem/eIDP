import type { AccessState } from '@eidp/contracts/pipelines'
export type { AccessState }
import * as jenkins from '../../integrations/jenkins/index.ts'
import { EVERYONE_SID, type SidType } from '../../integrations/jenkins/index.ts'
import { query, transaction } from '../../lib/db.ts'
import { exclusive } from '../../lib/locks.ts'

let inFlight: Promise<AccessState> | null = null

/** Reads the rules now. A call while one runs joins it, in this process or any other. */
export function syncJenkinsAccess(): Promise<AccessState> {
  inFlight ??= (async () => exclusive(`jenkins-access:${jenkins.jenkinsConfig().url}`, run, accessState))().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function run(): Promise<AccessState> {
  const server = jenkins.jenkinsConfig().url
  try {
    const rules = await jenkins.readAccess()
    await transaction(async (client) => {
      await client.query('delete from jenkins_job_access where server = $1', [server])
      // One insert per thousand rows: unnest keeps it to a handful of statements.
      for (let i = 0; i < rules.grants.length; i += 1000) {
        const chunk = rules.grants.slice(i, i + 1000)
        await client.query(
          `insert into jenkins_job_access (server, job, sid, sid_type, via)
           select $1, * from unnest($2::text[], $3::text[], $4::text[], $5::text[])
           on conflict do nothing`,
          [server, chunk.map((g) => g.job), chunk.map((g) => g.sid), chunk.map((g) => g.sidType), chunk.map((g) => g.via)],
        )
      }
      await client.query(
        `insert into jenkins_access_sync (server, read_at, source, grants, ok, error, warnings)
         values ($1, now(), $2, $3, true, null, $4)
         on conflict (server) do update set read_at = now(), source = excluded.source, grants = excluded.grants,
           ok = true, error = null, warnings = excluded.warnings`,
        [server, rules.source, rules.grants.length, rules.warnings],
      )
    })
  } catch (err) {
    await query(
      `insert into jenkins_access_sync (server, ok, error) values ($1, false, $2)
       on conflict (server) do update set ok = false, error = excluded.error`,
      [server, err instanceof Error ? err.message : String(err)],
    )
  }
  return accessState()
}

export async function accessState(): Promise<AccessState> {
  const { rows } = await query<{ read_at: Date | null; source: AccessState['source']; grants: number; ok: boolean; error: string | null; warnings: string[] }>(
    'select * from jenkins_access_sync where server = $1',
    [jenkins.jenkinsConfig().url],
  )
  const row = rows[0]
  if (!row) return { readAt: null, source: null, grants: 0, ok: false, error: null, warnings: [] }
  return { readAt: row.read_at?.toISOString() ?? null, source: row.source, grants: row.grants, ok: row.ok, error: row.error, warnings: row.warnings }
}

/** A grant that reaches one person: theirs by name, or one of their groups'. */
export type Reach = { job: string; sid: string; sidType: SidType; via: string }

/** Every job grant naming `uid`, one of `groups`, or everyone — optionally only for `jobs`. */
export async function grantsReaching(uid: string, groups: string[], jobs?: string[]): Promise<Reach[]> {
  const { rows } = await query<{ job: string; sid: string; sid_type: SidType; via: string }>(
    `select job, sid, sid_type, via from jenkins_job_access
      where server = $1 and ($4::text[] is null or job = any($4))
        and ((sid_type <> 'user' and lower(sid) = any($2)) or (sid_type <> 'group' and lower(sid) = lower($3)))
      order by job, sid`,
    [jenkins.jenkinsConfig().url, [...groups.map((g) => g.toLowerCase()), EVERYONE_SID], uid, jobs ?? null],
  )
  return rows.map((row) => ({ job: row.job, sid: row.sid, sidType: row.sid_type, via: row.via }))
}
