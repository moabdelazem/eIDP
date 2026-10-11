import type { DeployTarget, PipelineFile, PipelineTemplate, TemplateChange, TemplateImport, TemplateSlot } from '@eidp/contracts/requests'
import { desc, eq } from 'drizzle-orm'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Actor } from '../../../lib/actor.ts'
import { db } from '../../../lib/db.ts'
import { ApiError } from '../../../lib/errors.ts'
import { pipelineTemplateHistory, pipelineTemplates } from '../schema.ts'
import { credentialsIn } from './credentials.ts'
import { PROJECT_TEMPLATE, TECHNOLOGIES, type InventoryApp, type TechnologyDefinition } from './definitions.ts'
import { APPLICATION, PLACEHOLDER, PROJECT, type TemplateFile } from './generate.ts'

/**
 * The templates a pipeline's files are written from, kept in the database and
 * edited by DevOps on the Pipeline templates page — so a template changes
 * without a release, and every change is kept with who made it.
 *
 *   <Technology>/OCP            group_vars/<application>/ for OCP
 *   <Technology>/OCP/<app_path> Flutter on OCP: one per app_path
 *   <Technology>/K8s            group_vars/<application>/ for K8s
 *   manifests/<Technology>/<t>  the deployment manifests, to ocp-templates
 *   project                     a new project's group_vars/all/
 *
 * The old portal copied a live reference application at every request, so a
 * change to that application silently changed every pipeline after it. Here
 * "Import from the reference" reads it once into the editor — the name
 * replaced by `__APPLICATION__`, any credential by `changeme` — and nothing
 * is used until a person saves it. A technology is offered once every
 * template it needs for a target is saved, and only for those targets.
 */

export const PROJECT_TEMPLATE_DIR = 'project'

export type Variant = { dir: string; target: DeployTarget; appPath: string | null; reference: InventoryApp }
export type ManifestVariant = { dir: string; target: DeployTarget; reference: string }

/** The group_vars templates a technology needs, and the reference each is read from. */
export function variantsOf(key: string, definition: TechnologyDefinition): Variant[] {
  const out: Variant[] = []
  if (definition.appPathReferenceMap) {
    for (const [appPath, reference] of Object.entries(definition.appPathReferenceMap)) out.push({ dir: `${key}/OCP/${appPath}`, target: 'OCP', appPath, reference })
  } else {
    out.push({ dir: `${key}/OCP`, target: 'OCP', appPath: null, reference: definition.inventoryReference })
  }
  // K8s has one reference whatever the app_path: Flutter on K8s is the web kind.
  if (definition.k8sInventoryReference) out.push({ dir: `${key}/K8s`, target: 'K8s', appPath: null, reference: definition.k8sInventoryReference })
  return out
}

/** The deployment manifests for a technology on a target, from its reference_template in ocp-templates. */
export function manifestVariantsOf(key: string, definition: TechnologyDefinition): ManifestVariant[] {
  const out: ManifestVariant[] = []
  if (definition.referenceTemplate) out.push({ dir: `manifests/${key}/OCP`, target: 'OCP', reference: definition.referenceTemplate })
  if (definition.k8sReferenceTemplate) out.push({ dir: `manifests/${key}/K8s`, target: 'K8s', reference: definition.k8sReferenceTemplate })
  return out
}

/** The template a request is written from. */
export function variantFor(key: string, definition: TechnologyDefinition, target: DeployTarget, fields: Record<string, string>): Variant | undefined {
  return variantsOf(key, definition).find((v) => v.target === target && (v.appPath === null || v.appPath === fields.app_path))
}

type Slot = Omit<TemplateSlot, 'saved'>

/** Every template there is to fill: each technology's, then the project's. */
export function slots(): Slot[] {
  return [
    ...Object.entries(TECHNOLOGIES).flatMap(([key, definition]) => [
      ...variantsOf(key, definition).map(
        (v): Slot => ({
          dir: v.dir,
          kind: 'group_vars',
          technology: key,
          label: definition.label,
          target: v.target,
          appPath: v.appPath,
          repository: 'inventories',
          reference: `${v.reference.project}/group_vars/${v.reference.app}`,
        }),
      ),
      ...manifestVariantsOf(key, definition).map(
        (m): Slot => ({ dir: m.dir, kind: 'manifests', technology: key, label: definition.label, target: m.target, appPath: null, repository: 'ocp-templates', reference: m.reference }),
      ),
    ]),
    { dir: PROJECT_TEMPLATE_DIR, kind: 'project', technology: null, label: 'New project', target: null, appPath: null, repository: 'inventories', reference: `${PROJECT_TEMPLATE}/group_vars/all` },
  ]
}

export function slotOf(dir: string): Slot {
  const slot = slots().find((s) => s.dir === dir)
  if (!slot) throw new ApiError(404, 'no_such_template', `There is no template called ${dir}.`)
  return slot
}

// ---- reading, for the generator --------------------------------------------

/** The dirs that have a saved template. */
export async function savedDirs(): Promise<Set<string>> {
  return new Set((await db.select({ dir: pipelineTemplates.dir }).from(pipelineTemplates)).map((r) => r.dir))
}

/** A template's files; null when it has not been saved. */
export async function readTemplate(dir: string): Promise<TemplateFile[] | null> {
  const [row] = await db.select({ files: pipelineTemplates.files }).from(pipelineTemplates).where(eq(pipelineTemplates.dir, dir))
  return row?.files ?? null
}

// ---- the page --------------------------------------------------------------

const savedOf = (row: { files: PipelineFile[]; updatedByName: string; updatedAt: Date } | undefined): TemplateSlot['saved'] =>
  row ? { files: row.files.length, updatedByName: row.updatedByName, updatedAt: row.updatedAt.toISOString() } : null

export async function listTemplates(): Promise<TemplateSlot[]> {
  const saved = new Map((await db.select().from(pipelineTemplates)).map((r) => [r.dir, r]))
  return slots().map((slot) => ({ ...slot, saved: savedOf(saved.get(slot.dir)) }))
}

export async function getTemplate(dir: string): Promise<PipelineTemplate> {
  const slot = slotOf(dir)
  const [row] = await db.select().from(pipelineTemplates).where(eq(pipelineTemplates.dir, dir))
  const history = await db.select().from(pipelineTemplateHistory).where(eq(pipelineTemplateHistory.dir, dir)).orderBy(desc(pipelineTemplateHistory.changedAt), desc(pipelineTemplateHistory.id)).limit(50)
  return {
    slot: { ...slot, saved: savedOf(row) },
    files: row?.files ?? [],
    history: history.map((h): TemplateChange => ({ changedBy: h.changedBy, changedByName: h.changedByName, changedAt: h.changedAt.toISOString(), files: h.files ? h.files.length : null })),
  }
}

const MAX_FILES = 200
const MAX_FILE_BYTES = 256 * 1024
/** Relative, `/`-separated, no `..`, no empty part. */
const PATH = /^[\w.@+-]+(?:\/[\w.@+-]+)*$/

/**
 * Saves a template as given, after checking it could be written: paths
 * inside the slot, none twice, no credential, and — for the project — only
 * its own top-level files, never `team.yml`, which is the requester's.
 */
export async function saveTemplate(dir: string, files: PipelineFile[], actor: Actor): Promise<PipelineTemplate> {
  const slot = slotOf(dir)
  if (!files.length) throw new ApiError(400, 'empty_template', 'A template has at least one file. To stop offering it, remove it.')
  if (files.length > MAX_FILES) throw new ApiError(400, 'template_too_big', `A template has at most ${MAX_FILES} files.`)
  const seen = new Set<string>()
  for (const file of files) {
    if (!PATH.test(file.path) || file.path.split('/').some((part) => part === '.' || part === '..')) {
      throw new ApiError(400, 'bad_path', `“${file.path}” is not a path inside the template: letters, digits and . _ - @ +, folders separated by /.`)
    }
    if (seen.has(file.path)) throw new ApiError(400, 'duplicate_path', `${file.path} is there twice.`)
    seen.add(file.path)
    if (Buffer.byteLength(file.content) > MAX_FILE_BYTES) throw new ApiError(400, 'file_too_big', `${file.path} is over ${MAX_FILE_BYTES / 1024} KB.`)
    const keys = credentialsIn(file.content)
    if (keys.length) throw new ApiError(422, 'credential_in_template', `${file.path} has a value for ${keys.join(', ')}. Write ${PLACEHOLDER}, an Ansible expression or a vaulted value instead.`)
    if (slot.kind === 'project' && file.path.includes('/')) throw new ApiError(400, 'bad_path', `The project template holds group_vars/all's own files only; ${file.path} is in a folder.`)
    if (slot.kind === 'project' && file.path === 'team.yml') throw new ApiError(400, 'bad_path', 'team.yml is written from what the requester fills in; it is not part of the template.')
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(pipelineTemplates)
      .values({ dir, files, updatedBy: actor.uid, updatedByName: actor.name })
      .onConflictDoUpdate({ target: pipelineTemplates.dir, set: { files, updatedBy: actor.uid, updatedByName: actor.name, updatedAt: new Date() } })
    await tx.insert(pipelineTemplateHistory).values({ dir, files, changedBy: actor.uid, changedByName: actor.name })
  })
  return getTemplate(dir)
}

/** Removes a template: the technology stops being offered for that target. */
export async function removeTemplate(dir: string, actor: Actor): Promise<void> {
  slotOf(dir)
  await db.transaction(async (tx) => {
    const removed = await tx.delete(pipelineTemplates).where(eq(pipelineTemplates.dir, dir)).returning({ dir: pipelineTemplates.dir })
    if (removed.length) await tx.insert(pipelineTemplateHistory).values({ dir, files: null, changedBy: actor.uid, changedByName: actor.name })
  })
}

/**
 * A reference read as a template, from a working copy of its repository —
 * for the editor, never saved by itself. The reference's name becomes the
 * placeholder (in paths only for manifests, which the old portal copied as
 * they were), and a literal credential becomes `changeme`. `notes` says what
 * a person should look at before saving.
 */
export async function readReference(dir: string, checkout: string): Promise<TemplateImport> {
  const slot = slotOf(dir)
  const name = slot.kind === 'project' ? PROJECT_TEMPLATE : slot.reference.split('/').at(-1)!
  const placeholder = slot.kind === 'project' ? PROJECT : APPLICATION
  const root = join(checkout, slot.reference)
  const isDir = await stat(root).then(
    (s) => s.isDirectory(),
    () => false,
  )
  if (!isDir) throw new ApiError(404, 'no_reference', `${slot.reference} is not in ${slot.repository}. Fill the template in by hand, or point the technology at another reference.`)

  const entries = (await readdir(root, { recursive: slot.kind !== 'project', withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort()
  const notes: string[] = []
  const files: PipelineFile[] = []
  for (const path of entries) {
    if (slot.kind === 'project' && path === 'team.yml') continue
    const original = await readFile(join(root, path), 'utf8')
    const count = original.split(name).length - 1
    let content = slot.kind === 'manifests' ? original : original.replaceAll(name, placeholder)
    for (const key of credentialsIn(content)) {
      content = content.replace(new RegExp(`^(\\s*(?:-\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*).*$`, 'gm'), `$1${PLACEHOLDER}`)
      notes.push(`${path}: ${key} had a value in the reference; it is ${PLACEHOLDER} here.`)
    }
    if (slot.kind === 'manifests' && count) notes.push(`${path} names ${name} ${count} time${count > 1 ? 's' : ''}; manifests are copied as they are, so check it should.`)
    else if (count > 1) notes.push(`${path}: ${name} replaced by ${placeholder} ${count} times — check each one is the name.`)
    files.push({ path: path.replaceAll(name, placeholder), content })
  }
  if (!files.length) throw new ApiError(404, 'no_reference', `${slot.reference} in ${slot.repository} has no files.`)
  return { files, notes }
}
