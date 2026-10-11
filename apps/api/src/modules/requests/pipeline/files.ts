import type { PipelineFile } from '@eidp/contracts/requests'
import { ENVIRONMENTS } from '../../../integrations/inventories/parse.ts'
import { credentialsIn } from './credentials.ts'
import { inventoryFile, localhostVars, namespaceFile, projectFiles } from './generate.ts'
import { PROJECT_TEMPLATE_DIR, readTemplate } from './templates.ts'
import { environmentsFor, technology, templatesRoot, type Inventories, type PipelineContext } from './technologies.ts'

/**
 * What a pipeline request writes into inventories, worked out from the
 * request and the repository as it is *now* — at approval, not at filing:
 * whatever changed while the request waited is taken into account, and a
 * file that has appeared since is a conflict rather than overwritten.
 *
 *   <system>/<application>.yml               its groups and hosts, always
 *   <system>/group_vars/<application>/…      the technology's files, always
 *   <system>/group_vars/all/…                a new project only: the template project's, and team.yml
 *   <system>/host_vars/<env>_<target>/…      a new project only, one namespace per environment
 *   <system>/host_vars/localhost/vars.yml    a database, when the project has none yet
 */

export type Plan = { files: PipelineFile[]; errors: string[] }

export async function planFiles(ctx: PipelineContext, inventories: Inventories): Promise<Plan> {
  const { exists } = inventories
  const { spec, system } = ctx
  const errors: string[] = []
  const template = technology(spec.technology)
  if (!template) return { files: [], errors: [`Pipelines for ${spec.technology} are not set up in the portal.`] }

  const files: PipelineFile[] = []
  const appDir = `${system}/group_vars/${spec.application}`
  const appFile = `${system}/${spec.application}.yml`
  if (await exists(appDir)) errors.push(`${spec.application} already has files in inventories (${appDir}).`)
  else if (await exists(appFile)) errors.push(`${spec.application} already has an inventory in inventories (${appFile}).`)
  files.push({ path: appFile, content: inventoryFile(spec.application, spec.deployTarget, Boolean(template.database)) })
  try {
    files.push(...(await template.files(ctx, inventories)))
  } catch (error) {
    errors.push((error as Error).message)
  }

  if (spec.newProject) {
    if (await exists(`${system}/group_vars/all`)) errors.push(`${system} already has its project files; it is not a new project.`)
    if (spec.newProject.teams.automaticDeployToQc === null) errors.push('Whether QC is deployed to automatically was never chosen.')
    const project = await readTemplate(templatesRoot(), PROJECT_TEMPLATE_DIR)
    if (!project) errors.push('The new-project template has not been extracted into the portal yet.')
    else files.push(...projectFiles(ctx, spec.newProject.teams, project))
    if (!template.noNamespaces) {
      for (const env of environmentsFor(spec.deployTarget)) {
        const namespace = spec.newProject.namespaces[env.key]
        if (!namespace?.name.trim()) errors.push(`The ${env.label} namespace has no name.`)
        else files.push(namespaceFile(system, env.key, namespace, spec.deployTarget))
      }
    }
  }

  // A database's host, once per project: kept when it is there, as it was.
  if (template.database) {
    const localhost = localhostVars(system)
    if (!(await exists(localhost.path))) files.push(localhost)
    else if ((await inventories.read(localhost.path)) === null) errors.push(`${localhost.path} is there but is not a file.`)
  }

  await guard(files, system, inventories, errors)
  return { files, errors: [...new Set(errors)] }
}

/**
 * What a pipeline writes to ocp-templates: its manifests, under
 * `<project>/<application>/` — nothing for a library or a technology without
 * manifests on that target. A directory already there for the application
 * is a conflict, as it was in the old portal.
 */
export async function planManifests(ctx: PipelineContext, repository: Inventories): Promise<Plan> {
  const template = technology(ctx.spec.technology)
  if (!template?.manifests?.needed(ctx.spec)) return { files: [], errors: [] }
  const errors: string[] = []
  const dir = `${ctx.manifestsDir}/${ctx.spec.application}`
  if (await repository.exists(dir)) errors.push(`${ctx.spec.application} already has manifests in ocp-templates (${dir}).`)
  let files: PipelineFile[] = []
  try {
    files = await template.manifests.files(ctx)
  } catch (error) {
    errors.push((error as Error).message)
  }
  await guard(files, dir, repository, errors)
  return { files, errors: [...new Set(errors)] }
}

/** Nothing is ever overwritten, nothing lands outside where it belongs, and no credential is carried. */
async function guard(files: PipelineFile[], root: string, repository: Inventories, errors: string[]): Promise<void> {
  for (const file of files) {
    if (!file.path.startsWith(`${root}/`)) errors.push(`A template wrote outside ${root}: ${file.path}`)
    else if (await repository.exists(file.path)) errors.push(`${file.path} already exists.`)
    for (const key of credentialsIn(file.content)) errors.push(`${file.path} would carry a value for ${key}. A credential is never copied from another application; it is set from the vault.`)
  }
}

/** An application name that inventories would read back as an environment's override of another. */
export function overridePrefix(application: string): string | null {
  const lower = application.toLowerCase()
  return ENVIRONMENTS.find((env) => lower.startsWith(`${env}_`)) ?? null
}
