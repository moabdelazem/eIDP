import type { DeployTarget } from '@eidp/contracts/requests'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { InventoryApp, TechnologyDefinition } from './definitions.ts'
import type { TemplateFile } from './generate.ts'

/**
 * The templates a pipeline's files are written from, kept in e-IDP.
 *
 *   templates/<Technology>/OCP/…            group_vars/<application>/ of the OCP reference
 *   templates/<Technology>/OCP/<app_path>/… Flutter: one per app_path
 *   templates/<Technology>/K8s/…            of the K8s reference
 *   templates/project/…                     group_vars/all/ of the new-project template
 *
 * Each is extracted once from its reference application in inventories by
 * `scripts/pipeline-templates.ts`, reviewed, and committed. The old portal
 * copied the live reference at every request instead, so a change to one
 * application silently changed every pipeline made after it. The same script
 * checks for drift: a reference that moved on is reported, not followed.
 *
 * A technology is offered once its templates are here, and only for the
 * deploy targets they cover.
 */

export const BUNDLED_TEMPLATES = fileURLToPath(new URL('./templates', import.meta.url))
export const PROJECT_TEMPLATE_DIR = 'project'

export type Variant = { dir: string; target: DeployTarget; appPath: string | null; reference: InventoryApp }

/** Every template a technology needs, and the reference each is extracted from. */
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

/** The template a request is written from. */
export function variantFor(key: string, definition: TechnologyDefinition, target: DeployTarget, fields: Record<string, string>): Variant | undefined {
  return variantsOf(key, definition).find((v) => v.target === target && (v.appPath === null || v.appPath === fields.app_path))
}

export const hasTemplate = (root: string, dir: string): boolean => existsSync(join(root, dir))

/** A template's files, paths relative to its directory with `/`; null when it has not been extracted. */
export async function readTemplate(root: string, dir: string): Promise<TemplateFile[] | null> {
  const base = join(root, dir)
  if (!existsSync(base)) return null
  const entries = await readdir(base, { recursive: true, withFileTypes: true })
  const files = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name))
  return Promise.all(
    files.sort().map(async (file) => ({ path: relative(base, file).split(sep).join('/'), content: await readFile(file, 'utf8') })),
  )
}
