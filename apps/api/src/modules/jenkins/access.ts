import type { AccessState } from '@eidp/contracts/pipelines'
export type { AccessState }
import * as jenkins from '../../integrations/jenkins/index.ts'
import { EVERYONE_SID, type SidType } from '../../integrations/jenkins/index.ts'
import { eq, sql } from 'drizzle-orm'
import { db, sqlRows } from '../../lib/db.ts'
import { exclusive } from '../../lib/locks.ts'
import { jenkinsAccessSync, jenkinsJobAccess } from './schema.ts'

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
    await db.transaction(async (tx) => {
      await tx.delete(jenkinsJobAccess).where(eq(jenkinsJobAccess.server, server))
      // A thousand rows a statement keeps a large Jenkins to a handful.
      for (let i = 0; i < rules.grants.length; i += 1000) {
        await tx
          .insert(jenkinsJobAccess)
          .values(rules.grants.slice(i, i + 1000).map((g) => ({ server, job: g.job, sid: g.sid, sidType: g.sidType, via: g.via })))
          .onConflictDoNothing()
      }
      const read = { readAt: sql`now()`, source: rules.source, grants: rules.grants.length, ok: true, error: null, warnings: rules.warnings }
      await tx.insert(jenkinsAccessSync).values({ server, ...read }).onConflictDoUpdate({ target: jenkinsAccessSync.server, set: read })
    })
  } catch (err) {
    const failed = { ok: false, error: err instanceof Error ? err.message : String(err) }
    await db.insert(jenkinsAccessSync).values({ server, ...failed }).onConflictDoUpdate({ target: jenkinsAccessSync.server, set: failed })
  }
  return accessState()
}

export async function accessState(): Promise<AccessState> {
  const [row] = await db.select().from(jenkinsAccessSync).where(eq(jenkinsAccessSync.server, jenkins.jenkinsConfig().url))
  if (!row) return { readAt: null, source: null, grants: 0, ok: false, error: null, warnings: [] }
  return { readAt: row.readAt?.toISOString() ?? null, source: row.source, grants: row.grants, ok: row.ok, error: row.error, warnings: row.warnings }
}

/** A grant that reaches one person: theirs by name, or one of their groups'. */
export type Reach = { job: string; sid: string; sidType: SidType; via: string }

/** Every job grant naming `uid`, one of `groups`, or everyone — optionally only for `jobs`. */
export async function grantsReaching(uid: string, groups: string[], jobs?: string[]): Promise<Reach[]> {
  const rows = await sqlRows<{ job: string; sid: string; sid_type: SidType; via: string }>(sql`select job, sid, sid_type, via from ${jenkinsJobAccess}
      where server = ${jenkins.jenkinsConfig().url} and (${sql.param(jobs ?? null)}::text[] is null or job = any(${sql.param(jobs ?? null)}))
        and ((sid_type <> 'user' and lower(sid) = any(${sql.param([...groups.map((g) => g.toLowerCase()), EVERYONE_SID])})) or (sid_type <> 'group' and lower(sid) = lower(${uid})))
      order by job, sid`)
  return rows.map((row) => ({ job: row.job, sid: row.sid, sidType: row.sid_type, via: row.via }))
}
