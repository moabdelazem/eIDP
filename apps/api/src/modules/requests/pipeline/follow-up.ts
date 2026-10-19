import type { RequestRecord, RequestStep, StepName } from '@eidp/contracts/requests'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { buildFromQueue, buildState, jenkinsConfig, queueItem, triggerBuild, webUrl } from '../../../integrations/jenkins/index.ts'
import { config } from '../../../lib/config.ts'
import { db } from '../../../lib/db.ts'
import { ApiError } from '../../../lib/errors.ts'
import { errorFields, log } from '../../../lib/log.ts'
import { find, toStep } from '../rows.ts'
import { requestSteps } from '../schema.ts'
import { pipelineProject } from './check.ts'

/**
 * What runs in Jenkins after an approved pipeline is pushed: provisioning
 * (the application's branches and hooks; for a new project, the project's),
 * then a first test build — what the old portal's approval did right after
 * the push.
 *
 * Each is a row in `request_steps`, moved along by the `pipeline-steps` job
 * (one process at a time, lib/jobs.ts): pending → queued in Jenkins → running
 * → succeeded or failed. Nothing waits in memory, so a restart or a second
 * replica picks up where the last left off. The request is already complete
 * when they start: its files are in inventories whatever Jenkins does next,
 * and a failed step is retried on its own (`retryStep`), never by pushing again.
 *
 * Job names and parameters come from settings (PIPELINE_PROVISION_JOB,
 * PIPELINE_TEST_JOB and their _PARAMETERS) as templates over the request's
 * values. A step whose job is not set is skipped, with what to do by hand.
 */

/** How a build that did not pass ended, in words. */
const ENDED: Record<string, string> = {
  failure: 'The build failed.',
  unstable: 'The build was unstable: it ran, but its tests or checks did not all pass.',
  aborted: 'The build was aborted.',
  not_built: 'The build was not built.',
}

/** A queue item Jenkins has let go of, with no build found for it, is given this long before it is called lost. */
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

function jobFor(step: StepName, values: Record<string, string>): { job: string; parameters: Record<string, string> | null } | null {
  const job = step === 'provision' ? config.PIPELINE_PROVISION_JOB : config.PIPELINE_TEST_JOB
  if (!job) return null
  const parameters = step === 'provision' ? config.PIPELINE_PROVISION_PARAMETERS : config.PIPELINE_TEST_PARAMETERS
  return { job: fill(job, values), parameters: parameters ? Object.fromEntries(new URLSearchParams(fill(parameters, values))) : null }
}

/** Why Jenkins cannot be asked at all, or null when it can. */
function jenkinsMissing(): string | null {
  try {
    jenkinsConfig()
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** The old portal's printed provisioning command, for when no job runs it. */
export function manualProvisioning(values: Record<string, string>): string {
  const script =
    values.newProject === 'true'
      ? `createBranchs_hooks_initProject.sh ${values.collection} ${values.project}`
      : `createBranchs_hooks_initApp.sh ${values.collection} ${values.project} ${values.application}`
  return `podman exec podit-FH bash -lc "bash ~/scripts/CICD/Provisioning/${script}"`
}

/**
 * The steps of a request whose push just landed, as settings say now. Once
 * per request: a retried push that finds its commit already landed finds
 * its steps already there too, and leaves them be.
 */
export async function startSteps(request: RequestRecord, system: string): Promise<void> {
  const values = valuesOf(request, system)
  const missing = jenkinsMissing()
  const provision = jobFor('provision', values)
  const test = jobFor('test', values)
  const rows = [
    {
      requestId: request.id,
      step: 'provision' as const,
      job: provision?.job ?? null,
      parameters: provision?.parameters ?? null,
      ...(missing
        ? { status: 'skipped' as const, note: `${missing} Provision it by hand: ${manualProvisioning(values)}` }
        : provision
          ? { status: 'pending' as const, note: null }
          : { status: 'skipped' as const, note: `PIPELINE_PROVISION_JOB is not set. Provision it by hand: ${manualProvisioning(values)}` }),
    },
    {
      requestId: request.id,
      step: 'test' as const,
      job: test?.job ?? null,
      parameters: test?.parameters ?? null,
      ...(missing
        ? { status: 'skipped' as const, note: missing }
        : test
          ? { status: 'waiting' as const, note: null }
          : { status: 'skipped' as const, note: 'PIPELINE_TEST_JOB is not set, so no first build is started from here.' }),
    },
  ]
  await db.insert(requestSteps).values(rows).onConflictDoNothing()
}

/** Moves every open step along once; returns how many changed. */
export async function advanceSteps(): Promise<number> {
  const open = await db.select().from(requestSteps).where(inArray(requestSteps.status, ['pending', 'queued', 'running']))
  let changed = 0
  for (const step of open) {
    try {
      if (await advance(step)) changed++
    } catch (err) {
      // Jenkins unreachable for a moment is not the build failing: the next round asks again.
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
const age = (since: Date | null) => (since ? Date.now() - since.getTime() : 0)

async function advance(row: Row): Promise<boolean> {
  if (row.status === 'pending') {
    // The claim is the lock: of two rounds at once, only one sends the build.
    const [claimed] = await update(row, { status: 'queued', attempts: sql`${requestSteps.attempts} + 1`, startedAt: sql`now()`, finishedAt: null, queueId: null, number: null, url: null, note: null })
    if (!claimed) return false
    try {
      const { queueId } = await triggerBuild(row.job!, row.parameters ? new URLSearchParams(row.parameters) : null)
      await update(claimed, { queueId, url: webUrl(row.job!) })
    } catch (err) {
      await fail(claimed, `Jenkins would not start ${row.job}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return true
  }

  if (age(row.startedAt) > config.PIPELINE_STEP_TIMEOUT_MINUTES * 60_000) {
    await fail(row, `No result after ${config.PIPELINE_STEP_TIMEOUT_MINUTES} minutes. Look at it in Jenkins, then retry.`)
    return true
  }

  if (row.status === 'queued') {
    if (row.queueId === null) {
      // Claimed, but the process died before Jenkins answered: whether it queued is unknown.
      if (age(row.updatedAt) < LOST_AFTER_MS) return false
      await fail(row, 'Never known to reach Jenkins’ queue. Check Jenkins for a build, then retry.')
      return true
    }
    const item = await queueItem(row.queueId)
    if (item?.cancelled) {
      await fail(row, 'Cancelled in Jenkins’ queue.')
      return true
    }
    const number = item ? item.number : await buildFromQueue(row.job!, row.queueId)
    if (number !== null) {
      await update(row, { status: 'running', number, url: webUrl(row.job!, number) })
      return true
    }
    if (!item && age(row.updatedAt) > LOST_AFTER_MS) {
      await fail(row, 'Jenkins let the queued build go, and no build of the job came from it.')
      return true
    }
    return false
  }

  // running
  const state = await buildState(row.job!, row.number!)
  if (state.result === 'running') return false
  if (state.result !== 'success') {
    await fail(row, ENDED[state.result] ?? `The build ended ${state.result}.`)
    return true
  }
  const [done] = await update(row, { status: 'succeeded', note: null, finishedAt: sql`now()` })
  // Provisioned: the first test build is due.
  if (done && row.step === 'provision') {
    await db
      .update(requestSteps)
      .set({ status: 'pending', updatedAt: sql`now()` })
      .where(and(eq(requestSteps.requestId, row.requestId), eq(requestSteps.step, 'test'), eq(requestSteps.status, 'waiting')))
  }
  return true
}

/**
 * Runs a step again — a failed one, one skipped while its job was not set
 * (settings are read again), or the test build while it waits on a
 * provisioning done by hand. Running provisioning again puts the test build
 * back to waiting on it.
 */
export async function retryStep(requestId: string, step: StepName): Promise<RequestStep[]> {
  const request = await find(requestId)
  if (request.kind !== 'create_pipeline' || request.status !== 'completed') {
    throw new ApiError(409, 'no_steps', 'Only a pipeline whose files are pushed has steps to run.')
  }
  const [row] = await db.select().from(requestSteps).where(at({ requestId, step }))
  if (!row) throw new ApiError(404, 'step_not_found', 'That request has no such step.')
  const again = row.status === 'failed' || row.status === 'skipped' || (step === 'test' && row.status === 'waiting')
  if (!again) throw new ApiError(409, 'step_not_retryable', `The ${step === 'provision' ? 'provisioning' : 'test build'} is ${row.status}; only a failed or skipped one runs again.`)

  const missing = jenkinsMissing()
  if (missing) throw new ApiError(503, 'jenkins_not_configured', missing)
  // A step that ran keeps its job; one skipped for want of a setting reads the settings again.
  const job = row.job ? { job: row.job, parameters: row.parameters } : jobFor(step, valuesOf(request, (await pipelineProject(request.project)).system ?? request.project))
  if (!job) {
    throw new ApiError(409, 'step_not_configured', `${step === 'provision' ? 'PIPELINE_PROVISION_JOB' : 'PIPELINE_TEST_JOB'} is not set, so there is no job to run.`)
  }
  const [reset] = await update(row, { status: 'pending', job: job.job, parameters: job.parameters, note: null, queueId: null, number: null, url: null, finishedAt: null })
  if (!reset) throw new ApiError(409, 'step_changed', 'Someone else started it a moment ago.')
  if (step === 'provision') {
    await db
      .update(requestSteps)
      .set({ status: 'waiting', note: null, updatedAt: sql`now()` })
      .where(and(eq(requestSteps.requestId, requestId), eq(requestSteps.step, 'test'), inArray(requestSteps.status, ['failed', 'skipped', 'pending'])))
  }
  const rows = await db.select().from(requestSteps).where(eq(requestSteps.requestId, requestId))
  return rows.map(toStep).sort((a, b) => (a.step === 'provision' ? -1 : b.step === 'provision' ? 1 : 0))
}
