import type { DeployTarget, Namespace, PipelineSpec, Technology } from '@eidp/contracts/requests'
import type { FileWrite } from '../../../integrations/ado/index.ts'

/**
 * The build technologies a pipeline can be asked for, and what each writes
 * into the inventories repo — the old portal's TECH_CONFIG and the templates
 * behind its preview, in one place. The form reads the registry
 * (`GET /requests/pipeline/technologies`), so a technology added here is on
 * the form with its own fields; the check and the executor read it too.
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

export type TechnologyTemplate = Technology & {
  /** The application's own files — `group_vars/<application>/…` — paths relative to the repository root. */
  files: (ctx: PipelineContext) => FileWrite[]
}

/** A new project's namespaces for one deploy target: the environments asked for, and the files they become. */
export type NamespaceTemplate = {
  environments: { key: string; label: string }[]
  files: (ctx: PipelineContext, namespaces: Record<string, Namespace>) => FileWrite[]
}

const technologies = new Map<string, TechnologyTemplate>()
const namespaceTemplates = new Map<DeployTarget, NamespaceTemplate>()

/** Makes a technology available. Templates register themselves; tests register their own. */
export function registerTechnology(template: TechnologyTemplate): void {
  technologies.set(template.key, template)
}

export function registerNamespaces(target: DeployTarget, template: NamespaceTemplate): void {
  namespaceTemplates.set(target, template)
}

export const technology = (key: string): TechnologyTemplate | undefined => technologies.get(key)
export const namespacesFor = (target: DeployTarget): NamespaceTemplate | undefined => namespaceTemplates.get(target)

/** The registry as the form needs it: no templates, only what to ask. */
export function listTechnologies(): Technology[] {
  return [...technologies.values()]
    .map(({ files: _, ...technology }) => technology)
    .sort((a, b) => a.label.localeCompare(b.label))
}

export function environmentsFor(target: DeployTarget): { key: string; label: string }[] {
  return namespaceTemplates.get(target)?.environments ?? []
}
