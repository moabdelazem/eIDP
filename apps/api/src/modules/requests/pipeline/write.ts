import type { PipelinePreview, RequestRecord } from '@eidp/contracts/requests'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { commitAndPush, findCommit, freshCopy, inventoriesRemote, webUrlFor } from '../../../integrations/ado/index.ts'
import { config } from '../../../lib/config.ts'
import { inTurn } from '../../../lib/locks.ts'
import { planFiles, type Plan } from './files.ts'
import { technology, type Inventories, type PipelineContext } from './technologies.ts'

/**
 * Writing an approved pipeline request into the inventories repository: the
 * files committed and pushed straight to its default branch, as the old portal
 * did.
 *
 * In its own working copy (INVENTORIES_WRITE_CHECKOUT), one writer at a time
 * across every replica (`inTurn`), reset to the remote before each write —
 * whatever a failed attempt left is gone. The files are planned against that
 * fresh copy, so a file that appeared since the request was filed is a
 * conflict, never overwritten. A push refused because someone else pushed
 * first starts again from a fresh copy.
 *
 * Every commit carries `e-IDP-Request: <id>`. A retry looks for it first: a
 * push that landed but was never recorded — the process died a moment after —
 * is found, not pushed twice.
 */

const LOCK = 'inventories-write'
const PUSH_ATTEMPTS = 3

export const marker = (id: string) => `e-IDP-Request: ${id}`

/** Writes the request's files and returns the commit that holds them — an earlier one, when it already landed. */
export async function writePipeline(request: RequestRecord): Promise<{ commit: string; files: Plan['files'] }> {
  const remote = inventoriesRemote()
  const checkout = config.INVENTORIES_WRITE_CHECKOUT
  return inTurn(LOCK, async () => {
    for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
      const { branch } = await freshCopy(remote, checkout)
      const landed = await findCommit(checkout, marker(request.id))
      if (landed) return { commit: landed, files: [] }
      const plan = await planFiles(await contextFor(request, checkout), inventoriesAt(checkout))
      if (plan.errors.length) throw new Error(plan.errors.join(' '))
      const pushed = await commitAndPush(remote, checkout, branch, plan.files, message(request), {
        name: config.INVENTORIES_COMMITTER_NAME,
        email: config.INVENTORIES_COMMITTER_EMAIL,
      })
      if (pushed.pushed) return { commit: pushed.commit, files: plan.files }
    }
    throw new Error(`Inventories kept moving: ${PUSH_ATTEMPTS} pushes in a row were overtaken by someone else's. Retry.`)
  })
}

/**
 * What approving would write, against inventories as they are now — for the
 * approver, who reads the files before deciding. Never written; `commit` is
 * set when the request's push already landed.
 */
export async function previewPipeline(request: RequestRecord): Promise<PipelinePreview> {
  const checkout = config.INVENTORIES_WRITE_CHECKOUT
  return inTurn(LOCK, async () => {
    await freshCopy(inventoriesRemote(), checkout)
    const landed = await findCommit(checkout, marker(request.id))
    if (landed) return { files: [], errors: [], commit: landed }
    const plan = await planFiles(await contextFor(request, checkout), inventoriesAt(checkout))
    return { ...plan, commit: null }
  })
}

/** Where people see the commit: ADO's page for it, or the override remote's URL with the commit. */
export function commitUrl(commit: string): string {
  if (config.INVENTORIES_GIT_URL) return `${config.INVENTORIES_GIT_URL}#${commit}`
  return `${webUrlFor(adoCollection(), config.INVENTORIES_PROJECT!, config.INVENTORIES_REPO)}/commit/${commit}`
}

/** The collection ADO_BASE_URL points at — the one inventories lives in. */
function adoCollection(): string {
  return decodeURIComponent(new URL(config.ADO_BASE_URL!).pathname.split('/').filter(Boolean).at(-1)!)
}

async function contextFor(request: RequestRecord, checkout: string): Promise<PipelineContext> {
  const spec = request.pipeline!
  return {
    spec,
    system: await systemDir(checkout, request.project),
    collection: request.collection!,
    project: request.project,
    repository: request.repository!,
    repositoryUrl: config.ADO_BASE_URL ? webUrlFor(request.collection!, request.project, request.repository!) : `${request.collection}/${request.project}/${request.repository}`,
    requestedBy: { uid: request.requestedBy, name: request.requestedByName },
  }
}

/**
 * The project's directory in inventories: the existing one whatever its case,
 * or the project's name for a new one.
 */
export async function systemDir(checkout: string, project: string): Promise<string> {
  const dirs = await readdir(checkout, { withFileTypes: true }).catch(() => [])
  return dirs.find((d) => d.isDirectory() && d.name.toLowerCase() === project.toLowerCase())?.name ?? project
}

/** The working copy, read-only, as the templates see it. */
function inventoriesAt(checkout: string): Inventories {
  const inside = (path: string) => {
    const full = join(checkout, path)
    if (relative(checkout, full).startsWith('..')) throw new Error(`${path} is outside the repository`)
    return full
  }
  return {
    exists: (path) =>
      stat(inside(path)).then(
        () => true,
        () => false,
      ),
    read: (path) => readFile(inside(path), 'utf8').catch(() => null),
    list: async (dir) => {
      const entries = await readdir(inside(dir), { recursive: true, withFileTypes: true }).catch(() => [])
      return entries
        .filter((e) => e.isFile())
        .map((e) => relative(checkout, join(e.parentPath, e.name)))
        .sort()
    },
  }
}

function message(request: RequestRecord): string {
  const spec = request.pipeline!
  const label = technology(spec.technology)?.label ?? spec.technology
  return [
    `Add the ${spec.application} pipeline (${label} on ${spec.deployTarget})`,
    '',
    `For ${request.collection}/${request.project}/${request.repository}${spec.newProject ? ', a new project' : ''}.`,
    `Requested by ${request.requestedByName} (${request.requestedBy}); approved by ${request.decidedByName ?? request.decidedBy} (${request.decidedBy}).`,
    '',
    marker(request.id),
    '',
  ].join('\n')
}
