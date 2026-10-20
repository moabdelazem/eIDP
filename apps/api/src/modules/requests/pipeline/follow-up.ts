import type { RequestRecord, RequestStep, StepName } from '@eidp/contracts/requests'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { adoConfig, ensureBranches } from '../../../integrations/ado/index.ts'
import { buildFromQueue, buildState, jenkinsConfig, queueItem, triggerBuild, webUrl } from '../../../integrations/jenkins/index.ts'
import { config } from '../../../lib/config.ts'
import { db } from '../../../lib/db.ts'
import { ApiError } from '../../../lib/errors.ts'
import { errorFields, log } from '../../../lib/log.ts'
import { find, STEP_ORDER, toStep } from '../rows.ts'
import { requestSteps } from '../schema.ts'
import { pipelineProject } from './check.ts'

/**
 * What follows an approved pipeline's push, in order — what the old portal's
 * approval did after it, with createBranchs_hooks_initApp.sh:
 *
 *   branches  the repository's develop, release, hotfixes and stress
 *             (PIPELINE_BRANCHES), made from its default branch by the
 *             portal itself through Azure DevOps — createBranch.sh without
 *             a clone
 *   hooks     the repository's service hooks; not made by the portal yet
 *             (they are an Ansible playbook, Servicehook.yml), so skipped
 *             with the command that makes them
 *   test      a first build in Jenkins (PIPELINE_TEST_JOB)
 *
 * Each is a row in `request_steps`, moved along by the `pipeline-steps` job
 * (one process at a time, lib/jobs.ts). A step the portal runs goes pending →
 * running → succeeded or failed in one round; a Jenkins build goes pending →
 * queued → running → succeeded or failed over several. Nothing waits in
 * memory, so a restart or a second replica picks up where the last left off.
 * A step that succeeds lets the next one go; one skipped because it is not
 * set up does not hold the next back. The request is already complete when
 * they start — its files are in inventories whatever happens next — and a
 * failed step is run again on its own (`retryStep`), never by pushing again.
 *
 * A new project needs nothing more: createBranchs_hooks_initProject.sh ran
 * the application's steps for each of the project's applications, and a new
 * project's one application is this one.
 */

/** How a build that did not pass ended, in words. */
const ENDED: Record<string, string> = {
  failure: 'The build failed.',
  unstable: 'The build was unstable: it ran, but its tests or checks did not all pass.',
  aborted: 'The build was aborted.',
  not_built: 'The build was not built.',
}

/** A queue item Jenkins has let go of, or a step the portal was running when its process died, is given this long. */
const LOST_AFTER_MS = 10 * 60_000

/** The request's values, as the job and parameter templates name them. */
export function valuesOf(request: RequestRecord, system: string): Record<string, string> {
  const spec = request.pipeline!
  return {
    collection: request.collection ?? '',
    project: request.project,
    system,
    application: spec.application,
    repository: request.repository ?? '',
    newProject: String(Boolean(spec.newProject)),
    deployTarget: spec.deployTarget,
    technology: spec.technology,
  }
}

/** A template with its `{names}` filled in; a name it does not know is left as written, so the mistake shows. */
export const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)

function testJob(values: Record<string, string>): { job: string; parameters: Record<string, string> | null } | null {
  if (!config.PIPELINE_TEST_JOB) return null
  const parameters = config.PIPELINE_TEST_PARAMETERS
  return { job: fill(config.PIPELINE_TEST_JOB, values), parameters: parameters ? Object.fromEntries(new URLSearchParams(fill(parameters, values))) : null }
}

/** Why an outside system cannot be asked at all, or null when it can. */
function missing(check: () => unknown): string | null {
  try {
    check()
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** What makes the service hooks until the portal does: the old script, as DevOps ran it. */
export const manualHooks = (values: Record<string, string>) => `$MAIKAA_HOME/scripts/CICD/Bulk/Recreate_app_servicehooks.sh ${values.project} ${values.application}`

/**
 * The steps of a request whose push just landed, as settings say now. Once
 * per request: a retried push that finds its commit already landed finds
 * its steps already there too, and leaves them be.
 */
export async function startSteps(request: RequestRecord, system: string): Promise<void> {
  const values = valuesOf(request, system)
  const noAdo = missing(adoConfig)
  const noJenkins = missing(jenkinsConfig)
  const test = testJob(values)
  const base = { requestId: request.id, job: null, parameters: null }
  const rows = [
    { ...base, step: 'branches' as const, ...(noAdo ? { status: 'skipped' as const, note: noAdo } : { status: 'pending' as const, note: null }) },
    { ...base, step: 'hooks' as const, status: 'skipped' as const, note: `Not made by the portal yet. Make them by hand: ${manualHooks(values)}` },
    {
      ...base,
      step: 'test' as const,
      job: test?.job ?? null,
      parameters: test?.parameters ?? null,
      ...(noJenkins
        ? { status: 'skipped' as const, note: noJenkins }
        : test
          ? { status: 'waiting' as const, note: null }
          : { status: 'skipped' as const, note: 'PIPELINE_TEST_JOB is not set, so no first build is started from here.' }),
    },
  ]
  await db.insert(requestSteps).values(rows).onConflictDoNothing()
  // Nothing before the test build to wait for — Azure DevOps not set up — lets it go at once.
  await release(request.id)
}

/** Moves every open step along once; returns how many changed. */
export async function advanceSteps(): Promise<number> {
  const open = await db.select().from(requestSteps).where(inArray(requestSteps.status, ['pending', 'queued', 'running']))
  let changed = 0
  for (const step of open) {
    try {
      if (await advance(step)) changed++
    } catch (err) {
      // Jenkins or Azure DevOps unreachable for a moment is not the step failing: the next round asks again.
      log.warn('pipeline step not advanced', { request: step.requestId, step: step.step, ...errorFields(err) })
    }
  }
  return changed
}

type Row = typeof requestSteps.$inferSelect

const at = (row: Pick<Row, 'requestId' | 'step'>) => and(eq(requestSteps.requestId, row.requestId), eq(requestSteps.step, row.step))

function update(row: Row, set: PgUpdateSetSource<typeof requestSteps>, from: Row['status'] = row.status) {
  return db
    .update(requestSteps)
    .set({ ...set, updatedAt: sql`now()` })
    .where(and(at(row), eq(requestSteps.status, from)))
    .returning()
}

const fail = (row: Row, note: string) => update(row, { status: 'failed', note, finishedAt: sql`now()` })
const succeed = async (row: Row, note: string | null) => {
  const [done] = await update(row, { status: 'succeeded', note, finishedAt: sql`now()` })
  if (done) await release(row.requestId)
}
const age = (since: Date | null) => (since ? Date.now() - since.getTime() : 0)
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Lets the next step go: the first one still waiting, once every step before
 * it has succeeded or was skipped as not set up. A failed one holds what
 * follows until it is run again.
 */
async function release(requestId: string): Promise<void> {
  const rows = await db.select().from(requestSteps).where(eq(requestSteps.requestId, requestId))
  const ordered = rows.sort((a, b) => STEP_ORDER.indexOf(a.step) - STEP_ORDER.indexOf(b.step))
  for (const row of ordered) {
    if (row.status === 'succeeded' || row.status === 'skipped') continue
    if (row.status === 'waiting') await update(row, { status: 'pending' })
    return
  }
}

/** The steps the portal runs itself, rather than as a Jenkins build. */
const PORTAL: Partial<Record<string, (row: Row) => Promise<string>>> = {
  branches: async (row) => {
    const request = await find(row.requestId)
    const { from, created, existing } = await ensureBranches(request.collection!, request.project, request.repository!, config.PIPELINE_BRANCHES)
    const made = created.length ? `Made ${created.join(', ')} from ${from}.` : ''
    const there = existing.length ? ` ${existing.join(', ')} ${existing.length === 1 ? 'was' : 'were'} there already.` : ''
    return `${made}${there}`.trim()
  },
}

async function advance(row: Row): Promise<boolean> {
  const portal = PORTAL[row.step]
  if (portal) {
    if (row.status === 'running') {
      // Its process died mid-way: whether it finished is unknown, and running it again is safe.
      if (age(row.updatedAt) < LOST_AFTER_MS) return false
      await fail(row, 'Interrupted before it finished. Run it again: what is already done is left as it is.')
      return true
    }
    // The claim is the lock: of two rounds at once, only one runs it.
    const [claimed] = await update(row, { status: 'running', attempts: sql`${requestSteps.attempts} + 1`, startedAt: sql`now()`, finishedAt: null, note: null })
    if (!claimed) return false
    try {
      await succeed(claimed, await portal(claimed))
    } catch (err) {
      await fail(claimed, message(err))
    }
    return true
  }

  if (!row.job) {
    await fail(row, 'There is nothing to run for this step.')
    return true
  }

  if (row.status === 'pending') {
    // The claim is the lock: of two rounds at once, only one sends the build.
    const [claimed] = await update(row, { status: 'queued', attempts: sql`${requestSteps.attempts} + 1`, startedAt: sql`now()`, finishedAt: null, queueId: null, number: null, url: null, note: null })
    if (!claimed) return false
    try {
      const { queueId } = await triggerBuild(row.job, row.parameters ? new URLSearchParams(row.parameters) : null)
      await update(claimed, { queueId, url: webUrl(row.job) })
    } catch (err) {
      await fail(claimed, `Jenkins would not start ${row.job}: ${message(err)}`)
    }
    return true
  }

  if (age(row.startedAt) > config.PIPELINE_STEP_TIMEOUT_MINUTES * 60_000) {
    await fail(row, `No result after ${config.PIPELINE_STEP_TIMEOUT_MINUTES} minutes. Look at it in Jenkins, then run it again.`)
    return true
  }

  if (row.status === 'queued') {
    if (row.queueId === null) {
      // Claimed, but the process died before Jenkins answered: whether it queued is unknown.
      if (age(row.updatedAt) < LOST_AFTER_MS) return false
      await fail(row, 'Never known to reach Jenkins’ queue. Check Jenkins for a build, then run it again.')
      return true
    }
    const item = await queueItem(row.queueId)
    if (item?.cancelled) {
      await fail(row, 'Cancelled in Jenkins’ queue.')
      return true
    }
    const number = item ? item.number : await buildFromQueue(row.job, row.queueId)
    if (number !== null) {
      await update(row, { status: 'running', number, url: webUrl(row.job, number) })
      return true
    }
    if (!item && age(row.updatedAt) > LOST_AFTER_MS) {
      await fail(row, 'Jenkins let the queued build go, and no build of the job came from it.')
      return true
    }
    return false
  }

  // running
  const state = await buildState(row.job, row.number!)
  if (state.result === 'running') return false
  if (state.result !== 'success') {
    await fail(row, ENDED[state.result] ?? `The build ended ${state.result}.`)
    return true
  }
  await succeed(row, null)
  return true
}

const NAME: Record<string, string> = { branches: 'branches', hooks: 'service hooks', test: 'test build', provision: 'provisioning' }

/**
 * Runs a step again — a failed one, one skipped while it was not set up
 * (settings are read again), or one waiting on a step that failed or was
 * done by hand. Running a step again puts the failed or pending ones after
 * it back to waiting on it.
 */
export async function retryStep(requestId: string, step: StepName): Promise<RequestStep[]> {
  const request = await find(requestId)
  if (request.kind !== 'create_pipeline' || request.status !== 'completed') {
    throw new ApiError(409, 'no_steps', 'Only a pipeline whose files are pushed has steps to run.')
  }
  const rows = (await db.select().from(requestSteps).where(eq(requestSteps.requestId, requestId))).sort((a, b) => STEP_ORDER.indexOf(a.step) - STEP_ORDER.indexOf(b.step))
  const row = rows.find((r) => r.step === step)
  if (!row) throw new ApiError(404, 'step_not_found', 'That request has no such step.')
  const before = rows.slice(0, rows.indexOf(row))
  const unblocked = row.status === 'waiting' && before.some((r) => r.status === 'failed' || r.status === 'skipped')
  if (!(row.status === 'failed' || row.status === 'skipped' || unblocked)) {
    throw new ApiError(409, 'step_not_retryable', `The ${NAME[step] ?? step} ${row.status === 'succeeded' ? 'succeeded' : `is ${row.status}`}; only a failed or skipped one runs again.`)
  }

  let set: PgUpdateSetSource<typeof requestSteps> = { status: 'pending', note: null, finishedAt: null }
  if (step === 'hooks') {
    const values = valuesOf(request, (await pipelineProject(request.project)).system ?? request.project)
    throw new ApiError(409, 'not_in_portal_yet', `The portal does not make service hooks yet. Make them by hand: ${manualHooks(values)}`)
  } else if (step === 'branches') {
    const noAdo = missing(adoConfig)
    if (noAdo) throw new ApiError(503, 'ado_not_configured', noAdo)
  } else {
    const noJenkins = missing(jenkinsConfig)
    if (noJenkins) throw new ApiError(503, 'jenkins_not_configured', noJenkins)
    // A build that ran keeps its job; one skipped for want of a setting reads the settings again.
    const job = row.job ? { job: row.job, parameters: row.parameters } : testJob(valuesOf(request, (await pipelineProject(request.project)).system ?? request.project))
    if (!job) throw new ApiError(409, 'step_not_configured', 'PIPELINE_TEST_JOB is not set, so there is no job to run.')
    set = { ...set, job: job.job, parameters: job.parameters, queueId: null, number: null, url: null }
  }
  const [reset] = await update(row, set)
  if (!reset) throw new ApiError(409, 'step_changed', 'Someone else started it a moment ago.')
  for (const later of rows.slice(rows.indexOf(row) + 1)) {
    if (later.status === 'failed' || later.status === 'pending') await update(later, { status: 'waiting', note: null })
  }
  return (await db.select().from(requestSteps).where(eq(requestSteps.requestId, requestId))).map(toStep).sort((a, b) => STEP_ORDER.indexOf(a.step) - STEP_ORDER.indexOf(b.step))
}
