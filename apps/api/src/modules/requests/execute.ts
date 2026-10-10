import type { RequestRecord } from '@eidp/contracts/requests'
import { addToProjectGroup, createProject, createRepository, findIdentity, grantRepository, webUrlFor, type Principal } from '../../integrations/ado/index.ts'
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../../lib/db.ts'
import { executeGrant } from './grant.ts'
import { executeJiraProject } from './jira-project.ts'
import { existingRepository, recordCompleted, recordCreated, withContext } from './steps.ts'
import { requests } from './schema.ts'
import { log } from '../../lib/log.ts'

/**
 * A request left `approved` whose heartbeat stopped was interrupted — its
 * process died or restarted mid-way. Mark it failed so DevOps sees it and can
 * retry, rather than it waiting forever. Only those: another process's live
 * creation keeps beating and is left alone. Run at boot and as a job, so a
 * crash is noticed without waiting for a restart.
 */
export async function recoverInterrupted(): Promise<number> {
  const failed = await db
    .update(requests)
    .set({ status: 'failed', error: 'The portal restarted before this finished. Retry to try again.' })
    .where(
      and(
        eq(requests.status, 'approved'),
        or(isNull(requests.heartbeatAt), lt(requests.heartbeatAt, sql`now() - make_interval(secs => ${HEARTBEAT_STALE_MS / 1000})`)),
      ),
    )
    .returning({ id: requests.id })
  return failed.length
}

/** How often a creation in progress says so, and how long before silence means it stopped. */
const HEARTBEAT_MS = 30_000
const HEARTBEAT_STALE_MS = 3 * HEARTBEAT_MS

/** Does the work while saying so, so recovery can tell live work from work a dead process left. */
export async function execute(request: RequestRecord): Promise<void> {
  const heartbeat = (at: ReturnType<typeof sql> | null) => db.update(requests).set({ heartbeatAt: at }).where(eq(requests.id, request.id))
  const beat = () => heartbeat(sql`now()`)
  await beat().catch(() => {})
  const timer = setInterval(() => void beat().catch(() => {}), HEARTBEAT_MS)
  timer.unref()
  try {
    await perform(request)
  } finally {
    clearInterval(timer)
    await heartbeat(null).catch(() => {})
  }
}

/**
 * Creates the thing, then gives the requester and their team Contributor
 * access to it. Nobody asks for a repository they cannot push to.
 *
 * Identities are resolved before anything is created, so a team ADO cannot
 * find fails the request with nothing made. `result_url` is written the moment
 * creation succeeds: if granting then fails, a retry sees it and only grants,
 * rather than trying to create something that now exists.
 */
async function perform(request: RequestRecord): Promise<void> {
  try {
    if (request.kind === 'create_jira_project') return await executeJiraProject(request)
    if (request.kind === 'grant_access') return await executeGrant(request)
    const collection = request.collection!
    const principals: Principal[] = []
    for (const name of [request.requestedBy, request.teamGroup]) {
      if (name) principals.push(await findIdentity(collection, name))
    }
    const created = request.resultUrl !== null

    let resultUrl: string
    if (request.kind === 'create_repository') {
      const repo = created
        ? await existingRepository(request)
        : await createRepository(collection, request.project, request.repository!)
      resultUrl = repo.webUrl ?? webUrlFor(collection, request.project, repo.name)
      if (!created) await recordCreated(request.id, resultUrl)
      await withContext(`Created ${repo.name}, but could not grant access`, () =>
        grantRepository(collection, repo.project.id, repo.id, principals),
      )
    } else {
      const project = created
        ? { name: request.project }
        : await createProject(collection, request.project, request.description ?? '')
      resultUrl = webUrlFor(collection, project.name)
      if (!created) await recordCreated(request.id, resultUrl)
      await withContext(`Created ${project.name}, but could not grant access`, () =>
        addToProjectGroup(collection, project.name, 'Contributors', principals),
      )
    }
    await recordCompleted(request.id, resultUrl)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('request failed', { request: request.id, error: message })
    await db.update(requests).set({ status: 'failed', error: message }).where(eq(requests.id, request.id))
  }
}
