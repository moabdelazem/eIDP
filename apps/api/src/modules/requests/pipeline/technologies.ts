import type { DeployTarget, PipelineSpec, Technology, TechnologyField } from '@eidp/contracts/requests'
import type { FileWrite } from '../../../integrations/ado/index.ts'
import { config } from '../../../lib/config.ts'
import { FIELD_RULES, NAMESPACE_ENVIRONMENTS, noNamespacesOf, TECHNOLOGIES, targetsOf, type TechnologyDefinition } from './definitions.ts'
import { applicationFiles } from './generate.ts'
import { BUNDLED_TEMPLATES, hasTemplate, readTemplate, variantFor, variantsOf } from './templates.ts'

/**
 * The build technologies a pipeline can be asked for: every one in
 * `definitions.ts` whose templates have been extracted (`templates.ts`), for
 * the deploy targets they cover. The form reads this
 * (`GET /requests/pipeline/technologies`), and so do the check and the
 * executor. Tests register technologies of their own.
 */

/** Everything a template may use to write its files. */
export type PipelineContext = {
  spec: PipelineSpec
  /** The project's directory in inventories. */
  system: string
  collection: string
  project: string
  repository: string
  /** Where the repository is cloned from, as ADO names it. */
  repositoryUrl: string
  requestedBy: { uid: string; name: string }
}

/** The inventories repository as it is at the moment of planning, read-only. Paths are relative to its root. */
export type Inventories = {
  exists: (path: string) => Promise<boolean>
  /** A file's text, or null when there is no file there. */
  read: (path: string) => Promise<string | null>
  /** The files under a directory, recursively, relative to the root; empty when there is none. */
  list: (dir: string) => Promise<string[]>
}

export type TechnologyTemplate = Technology & {
  /** Deploys from the host: its inventory groups are `localhost`, and it needs `host_vars/localhost`. */
  database?: boolean
  /** The application's own files — `group_vars/<application>/…` — paths relative to the repository root. */
  files: (ctx: PipelineContext, inventories: Inventories) => FileWrite[] | Promise<FileWrite[]>
}

const registered = new Map<string, TechnologyTemplate>()

/** Makes a technology available that is not in `definitions.ts`. Tests register their own. */
export function registerTechnology(template: TechnologyTemplate): void {
  registered.set(template.key, template)
}

export const templatesRoot = (): string => config.PIPELINE_TEMPLATES_DIR ?? BUNDLED_TEMPLATES

export function technology(key: string): TechnologyTemplate | undefined {
  return registered.get(key) ?? fromDefinition(key)
}

/** The registry as the form needs it: no templates, only what to ask. */
export function listTechnologies(): Technology[] {
  const keys = new Set([...Object.keys(TECHNOLOGIES), ...registered.keys()])
  return [...keys]
    .map((key) => technology(key))
    .filter((t): t is TechnologyTemplate => Boolean(t))
    .map(({ files: _, database: __, ...technology }) => technology)
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** The environments a new project names a namespace for, on a deploy target — the old portal's, in its order. */
export function environmentsFor(target: DeployTarget): { key: string; label: string }[] {
  return NAMESPACE_ENVIRONMENTS[target].map(({ key, label }) => ({ key, label }))
}

/** A technology from its definition, once its templates are here; only the targets whose templates all are. */
function fromDefinition(key: string): TechnologyTemplate | undefined {
  const definition = TECHNOLOGIES[key]
  if (!definition) return undefined
  const root = templatesRoot()
  const variants = variantsOf(key, definition)
  const targets = targetsOf(definition).filter((target) => variants.filter((v) => v.target === target).every((v) => hasTemplate(root, v.dir)))
  if (!targets.length) return undefined
  return {
    key,
    label: definition.label,
    versions: definition.versions,
    fields: fieldsOf(definition),
    targets,
    noNamespaces: noNamespacesOf(definition),
    database: Boolean(definition.isDatabase),
    files: async (ctx) => {
      const variant = variantFor(key, definition, ctx.spec.deployTarget, ctx.spec.fields)
      const templates = variant && (await readTemplate(root, variant.dir))
      if (!templates) throw new Error(`There is no ${definition.label} template for ${ctx.spec.deployTarget}${ctx.spec.fields.app_path ? ` (${ctx.spec.fields.app_path})` : ''}.`)
      return applicationFiles(key, definition, ctx, templates)
    },
  }
}

function fieldsOf(definition: TechnologyDefinition): TechnologyField[] {
  return definition.requiredFields.map((name) => {
    const rule = FIELD_RULES[name]
    return {
      name,
      label: rule?.label ?? name.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase()),
      options: definition.fieldOptions?.[name] ?? null,
      default: rule?.default ?? null,
      help: rule?.help ?? null,
      pattern: rule?.pattern ?? null,
    }
  })
}
