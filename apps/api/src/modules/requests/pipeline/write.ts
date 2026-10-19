import type { PipelinePreview, RequestRecord, TemplateImport } from '@eidp/contracts/requests'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { commitAndPush, findCommit, freshCopy, inventoriesRemote, ocpTemplatesRemote, webUrlFor, type Remote } from '../../../integrations/ado/index.ts'
import { config } from '../../../lib/config.ts'
import { inTurn } from '../../../lib/locks.ts'
import { planFiles, planManifests, type Plan } from './files.ts'
import { readReference, slotOf } from './templates.ts'
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

/**
 * Writes the request's files and returns the inventories commit that holds
 * them — an earlier one, when it already landed.
 *
 * Two repositories: the manifests to ocp-templates, then the application to
 * inventories, so the application never appears without its deployment. Both
 * are planned before either is pushed, so a conflict in one writes nothing to
 * the other. Each push carries the marker and is looked for first, so a retry
 * after only the first landed finishes the second instead of repeating it —
 * the old portal pushed the two separately and could leave one without the other.
 */
export async function writePipeline(request: RequestRecord): Promise<{ commit: string; manifestsCommit: string | null; files: Plan['files'] }> {
  const inventories = side(inventoriesRemote(), config.INVENTORIES_WRITE_CHECKOUT)
  const template = await technology(request.pipeline!.technology)
  const needsManifests = Boolean(template?.manifests?.needed(request.pipeline!))
  const templates = needsManifests ? side(ocpTemplatesRemote(), config.OCP_TEMPLATES_WRITE_CHECKOUT) : null
  const committer = { name: config.INVENTORIES_COMMITTER_NAME, email: config.INVENTORIES_COMMITTER_EMAIL }
  return inTurn(LOCK, async () => {
    for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
      const branch = await freshCopy(inventories.remote, inventories.checkout).then((c) => c.branch)
      const templatesBranch = templates && (await freshCopy(templates.remote, templates.checkout)).branch
      const landed = await findCommit(inventories.checkout, marker(request.id))
      let manifestsCommit = templates && (await findCommit(templates.checkout, marker(request.id)))
      if (landed) return { commit: landed, manifestsCommit, files: [] }

      const ctx = await contextFor(request, inventories.checkout, templates?.checkout ?? null)
      const plan = await planFiles(ctx, readerAt(inventories.checkout))
      const manifests = templates && !manifestsCommit ? await planManifests(ctx, readerAt(templates.checkout)) : { files: [], errors: [] }
      const errors = [...plan.errors, ...manifests.errors]
      if (errors.length) throw new Error(errors.join(' '))

      if (templates && !manifestsCommit) {
        const pushed = await commitAndPush(templates.remote, templates.checkout, templatesBranch!, manifests.files, message(request, 'manifests', template?.label), committer)
        if (!pushed.pushed) continue
        manifestsCommit = pushed.commit
      }
      const pushed = await commitAndPush(inventories.remote, inventories.checkout, branch, plan.files, message(request, 'inventories', template?.label), committer)
      if (pushed.pushed) return { commit: pushed.commit, manifestsCommit, files: [...manifests.files, ...plan.files] }
    }
    throw new Error(`The repositories kept moving: ${PUSH_ATTEMPTS} pushes in a row were overtaken by someone else's. Retry.`)
  })
}

/**
 * What approving would write, against the repositories as they are now — for
 * the approver, who reads the files before deciding. Never written; `commit`
 * is set when the request's push already landed.
 */
export async function previewPipeline(request: RequestRecord): Promise<PipelinePreview> {
  const inventories = side(inventoriesRemote(), config.INVENTORIES_WRITE_CHECKOUT)
  const template = await technology(request.pipeline!.technology)
  const needsManifests = Boolean(template?.manifests?.needed(request.pipeline!))
  const templates = needsManifests ? side(ocpTemplatesRemote(), config.OCP_TEMPLATES_WRITE_CHECKOUT) : null
  return inTurn(LOCK, async () => {
    await freshCopy(inventories.remote, inventories.checkout)
    const landed = await findCommit(inventories.checkout, marker(request.id))
    if (landed) return { files: [], manifests: [], errors: [], commit: landed }
    if (templates) await freshCopy(templates.remote, templates.checkout)
    const ctx = await contextFor(request, inventories.checkout, templates?.checkout ?? null)
    const plan = await planFiles(ctx, readerAt(inventories.checkout))
    const manifests = templates ? await planManifests(ctx, readerAt(templates.checkout)) : { files: [], errors: [] }
    return { files: plan.files, manifests: manifests.files, errors: [...new Set([...plan.errors, ...manifests.errors])], commit: null }
  })
}

/**
 * A template's reference, read from its repository as it is now — for the
 * Pipeline templates page's "Import from the reference". In the writer's own
 * copy, in turn with the writes, so it never reads a half-reset copy.
 */
export async function importReference(dir: string): Promise<TemplateImport> {
  const slot = slotOf(dir)
  const repository =
    slot.repository === 'inventories' ? side(inventoriesRemote(), config.INVENTORIES_WRITE_CHECKOUT) : side(ocpTemplatesRemote(), config.OCP_TEMPLATES_WRITE_CHECKOUT)
  return inTurn(LOCK, async () => {
    await freshCopy(repository.remote, repository.checkout)
    return readReference(dir, repository.checkout)
  })
}

const side = (remote: Remote, checkout: string) => ({ remote, checkout })

/** Where people see the commit: ADO's page for it, or the override remote's URL with the commit. */
export function commitUrl(commit: string): string {
  if (config.INVENTORIES_GIT_URL) return `${config.INVENTORIES_GIT_URL}#${commit}`
  return `${webUrlFor(adoCollection(), config.INVENTORIES_PROJECT!, config.INVENTORIES_REPO)}/commit/${commit}`
}

/** The collection ADO_BASE_URL points at — the one inventories lives in. */
function adoCollection(): string {
  return decodeURIComponent(new URL(config.ADO_BASE_URL!).pathname.split('/').filter(Boolean).at(-1)!)
}

async function contextFor(request: RequestRecord, checkout: string, templatesCheckout: string | null): Promise<PipelineContext> {
  const spec = request.pipeline!
  return {
    spec,
    system: await systemDir(checkout, request.project),
    manifestsDir: templatesCheckout ? await systemDir(templatesCheckout, request.project) : request.project,
    collection: request.collection!,
    project: request.project,
    repository: request.repository!,
    repositoryUrl: config.ADO_BASE_URL ? webUrlFor(request.collection!, request.project, request.repository!) : `${request.collection}/${request.project}/${request.repository}`,
    requestedBy: { uid: request.requestedBy, name: request.requestedByName },
  }
}

/**
 * The project's directory in a repository: the existing one whatever its
 * case, or the project's name for a new one.
 */
export async function systemDir(checkout: string, project: string): Promise<string> {
  const dirs = await readdir(checkout, { withFileTypes: true }).catch(() => [])
  return dirs.find((d) => d.isDirectory() && d.name.toLowerCase() === project.toLowerCase())?.name ?? project
}

/** The working copy, read-only, as the templates see it. */
function readerAt(checkout: string): Inventories {
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

function message(request: RequestRecord, part: 'inventories' | 'manifests', technologyLabel: string | undefined): string {
  const spec = request.pipeline!
  const label = technologyLabel ?? spec.technology
  return [
    part === 'manifests' ? `Add the ${spec.application} manifests (${label} on ${spec.deployTarget})` : `Add the ${spec.application} pipeline (${label} on ${spec.deployTarget})`,
    '',
    `For ${request.collection}/${request.project}/${request.repository}${spec.newProject ? ', a new project' : ''}.`,
    `Requested by ${request.requestedByName} (${request.requestedBy}); approved by ${request.decidedByName ?? request.decidedBy} (${request.decidedBy}).`,
    '',
    marker(request.id),
    '',
  ].join('\n')
}
