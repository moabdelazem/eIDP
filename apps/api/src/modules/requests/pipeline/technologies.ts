import type { DeployTarget, PipelineSpec, Technology, TechnologyField } from '@eidp/contracts/requests'
import type { FileWrite } from '../../../integrations/ado/index.ts'
import { FIELD_RULES, NAMESPACE_ENVIRONMENTS, noNamespacesOf, TECHNOLOGIES, targetsOf, type TechnologyDefinition } from './definitions.ts'
import { APPLICATION, applicationFiles } from './generate.ts'
import { manifestVariantsOf, readTemplate, savedDirs, variantFor, variantsOf } from './templates.ts'

/**
 * The build technologies a pipeline can be asked for: every one in
 * `definitions.ts` whose templates DevOps has saved (`templates.ts`), for the
 * deploy targets they cover. The form reads this
 * (`GET /requests/pipeline/technologies`), and so do the check and the
 * executor. Tests register technologies of their own.
 */

/** Everything a template may use to write its files. */
export type PipelineContext = {
  spec: PipelineSpec
  /** The project's directory in inventories. */
  system: string
  /** The project's directory in ocp-templates. */
  manifestsDir: string
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
  /**
   * The deployment manifests written to ocp-templates, `<project>/<application>/…`
   * — as the old portal copied its reference_template. Not for a library, and
   * not for a technology without manifests on that target.
   */
  manifests?: {
    needed: (spec: PipelineSpec) => boolean
    files: (ctx: PipelineContext) => Promise<FileWrite[]>
  }
}

const registered = new Map<string, TechnologyTemplate>()

/** Makes a technology available that is not in `definitions.ts`. Tests register their own. */
export function registerTechnology(template: TechnologyTemplate): void {
  registered.set(template.key, template)
}

export async function technology(key: string): Promise<TechnologyTemplate | undefined> {
  return registered.get(key) ?? fromDefinition(key, await savedDirs())
}

/** The registry as the form needs it: no templates, only what to ask. */
export async function listTechnologies(): Promise<Technology[]> {
  const saved = await savedDirs()
  const keys = new Set([...Object.keys(TECHNOLOGIES), ...registered.keys()])
  return [...keys]
    .map((key) => registered.get(key) ?? fromDefinition(key, saved))
    .filter((t): t is TechnologyTemplate => Boolean(t))
    .map(({ files: _, database: __, manifests: ___, ...technology }) => technology)
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** The environments a new project names a namespace for, on a deploy target — the old portal's, in its order. */
export function environmentsFor(target: DeployTarget): { key: string; label: string }[] {
  return NAMESPACE_ENVIRONMENTS[target].map(({ key, label }) => ({ key, label }))
}

/** A technology from its definition, once its templates are here; only the targets whose templates all are. */
function fromDefinition(key: string, saved: Set<string>): TechnologyTemplate | undefined {
  const definition = TECHNOLOGIES[key]
  if (!definition) return undefined
  const variants = variantsOf(key, definition)
  const manifests = manifestVariantsOf(key, definition)
  // A target is offered once everything it writes is here: its group_vars and, when it has them, its manifests.
  const targets = targetsOf(definition).filter((target) =>
    [...variants.filter((v) => v.target === target), ...manifests.filter((m) => m.target === target)].every((v) => saved.has(v.dir)),
  )
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
      const templates = variant && (await readTemplate(variant.dir))
      if (!templates) throw new Error(`There is no ${definition.label} template for ${ctx.spec.deployTarget}${ctx.spec.fields.app_path ? ` (${ctx.spec.fields.app_path})` : ''}.`)
      return applicationFiles(key, definition, ctx, templates)
    },
    manifests: {
      needed: (spec) => !spec.library && manifests.some((m) => m.target === spec.deployTarget),
      files: async (ctx) => {
        const variant = manifests.find((m) => m.target === ctx.spec.deployTarget)
        const templates = variant && (await readTemplate(variant.dir))
        if (!templates) throw new Error(`There are no ${definition.label} manifests for ${ctx.spec.deployTarget}.`)
        // As the old portal: the name in paths is the application's; the contents are copied as they are.
        return templates.map((t) => ({ path: `${ctx.manifestsDir}/${ctx.spec.application}/${t.path.replaceAll(APPLICATION, ctx.spec.application)}`, content: t.content }))
      },
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
