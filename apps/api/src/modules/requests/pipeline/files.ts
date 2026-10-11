import type { PipelineFile, ProjectTeams } from '@eidp/contracts/requests'
import { ENVIRONMENTS } from '../../../integrations/inventories/parse.ts'
import { namespacesFor, technology, type Inventories, type PipelineContext } from './technologies.ts'

/**
 * What a pipeline request writes into inventories, worked out from the
 * request and the repository as it is *now* — at approval, not at filing:
 * whatever changed while the request waited is taken into account, and a
 * file that has appeared since is a conflict rather than overwritten.
 *
 *   <system>/group_vars/<application>/…   the technology's files, always
 *   <system>/group_vars/all/team.yml      a new project only
 *   namespaces                            a new project only, per deploy target
 */

export type Plan = { files: PipelineFile[]; errors: string[] }

export async function planFiles(ctx: PipelineContext, inventories: Inventories): Promise<Plan> {
  const { exists } = inventories
  const { spec } = ctx
  const errors: string[] = []
  const template = technology(spec.technology)
  if (!template) return { files: [], errors: [`Pipelines for ${spec.technology} are not set up in the portal.`] }

  const files: PipelineFile[] = []
  const appDir = `${ctx.system}/group_vars/${spec.application}`
  if (await exists(appDir)) errors.push(`${spec.application} already has files in inventories (${appDir}).`)
  files.push(...(await template.files(ctx, inventories)))

  if (spec.newProject) {
    if (await exists(`${ctx.system}/group_vars/all`)) {
      errors.push(`${ctx.system} already has its project files; it is not a new project.`)
    }
    if (spec.newProject.teams.automaticDeployToQc === null) errors.push('Whether QC is deployed to automatically was never chosen.')
    files.push({ path: `${ctx.system}/group_vars/all/team.yml`, content: teamYml(spec.newProject.teams) })
    if (!template.noNamespaces) {
      const namespaces = namespacesFor(spec.deployTarget)
      if (!namespaces) errors.push(`Namespaces for ${spec.deployTarget} are not set up in the portal.`)
      else files.push(...(await namespaces.files(ctx, spec.newProject.namespaces, inventories)))
    }
  }

  // Nothing is ever overwritten: every path written must be new.
  for (const file of files) {
    if (!file.path.startsWith(`${ctx.system}/`)) errors.push(`A template wrote outside ${ctx.system}: ${file.path}`)
    else if (await exists(file.path)) errors.push(`${file.path} already exists.`)
  }
  return { files, errors: [...new Set(errors)] }
}

/** An application name that inventories would read back as an environment's override of another. */
export function overridePrefix(application: string): string | null {
  const lower = application.toLowerCase()
  return ENVIRONMENTS.find((env) => lower.startsWith(`${env}_`)) ?? null
}

/**
 * `group_vars/all/team.yml`, as the repository writes it: scalars plain, the
 * auto-deploy flag a quoted string, and an empty list as one empty item —
 * which is how the projects already there spell "nobody".
 */
export function teamYml(teams: ProjectTeams): string {
  const scalar = (value: string) => (/^[\w.@-]+$/.test(value) ? value : JSON.stringify(value))
  const list = (values: string[]) => (values.length ? values.map((v) => `  - ${scalar(v)}`).join('\n') : '  -')
  return [
    `company: ${scalar(teams.company)}`,
    `automatic_deploy_to_qc: "${teams.automaticDeployToQc ? 'true' : 'false'}"`,
    `dev_team: ${scalar(teams.devTeam)}`,
    `qc_team: ${scalar(teams.qcTeam)}`,
    `uat_team: ${scalar(teams.uatTeam)}`,
    `prd_team: ${scalar(teams.prdTeam)}`,
    'dev_team_list:',
    list(teams.devTeamList),
    'ops_team_list:',
    list(teams.opsTeamList),
    'prd_only:',
    list(teams.prdOnly),
    'prd_approvers:',
    list(teams.prdApprovers),
    'project_managers:',
    list(teams.projectManagers),
    '',
  ].join('\n')
}
