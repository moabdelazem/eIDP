import type { DeployTarget, Namespace, PipelineFile, ProjectTeams } from '@eidp/contracts/requests'
import { posix } from 'node:path'
import { NAMESPACE_ENVIRONMENTS, type TechnologyDefinition } from './definitions.ts'
import type { PipelineContext } from './technologies.ts'
import { setKey, setNested } from './yaml-edit.ts'

/**
 * What the old `new_applications.py` wrote, file by file, from a request and
 * the templates e-IDP keeps (`templates.ts`). The output matches the old
 * portal's; where the old code did something wrong, the comment says what and
 * why it is different here.
 */

/** Stands for the application's name in a template, path and content. */
export const APPLICATION = '__APPLICATION__'
/** Stands for the project's name in the new-project template. */
export const PROJECT = '__PROJECT__'
/** What a value a person must set by hand after approval is written as. */
export const PLACEHOLDER = 'changeme'

export type TemplateFile = { path: string; content: string }

/**
 * `<system>/<application>.yml`: the application's groups and the hosts they
 * deploy to. A database deploys from the host, so every group is `localhost`;
 * production is two hosts, the main site and DR. OCP has no `preprod`, K8s does.
 */
export function inventoryFile(application: string, target: DeployTarget, database: boolean): string {
  const head = `all:\n  children:\n    ${application}:\n      children:\n`
  if (database) {
    return head + ['dev', 'qc', 'uat', 'prd'].map((env) => `        ${env}_${application}:\n          hosts:\n            localhost:\n`).join('')
  }
  const suffix = target === 'K8s' ? 'k8s' : 'ocp'
  const before = target === 'K8s' ? ['dev', 'qc', 'uat', 'preprod'] : ['dev', 'qc', 'uat']
  return (
    head +
    before.map((env) => `        ${env}_${application}:\n          hosts:\n            ${env}_${suffix}:\n\n`).join('') +
    `        prd_${application}:\n          hosts:\n            prd_${suffix}:\n            prd_dr_${suffix}:\n`
  )
}

/** A new project's namespace for one environment: `host_vars/<env>_<ocp|k8s>/vars.yml`. */
export function namespaceFile(system: string, env: string, namespace: Namespace, target: DeployTarget): PipelineFile {
  const cluster = NAMESPACE_ENVIRONMENTS[target].find((e) => e.key === env)?.cluster ?? 'HQ'
  const user = namespace.user?.trim() || PLACEHOLDER
  const block = target === 'K8s' ? 'k8s_namespace' : 'ocp_namespace'
  // As the old portal wrote them: the OCP token a placeholder, the K8s one empty.
  // Both are set by hand, and the request page lists them until they are.
  const token = target === 'K8s' ? 'token:' : `token: ${PLACEHOLDER}`
  return {
    path: `${system}/host_vars/${env}_${target === 'K8s' ? 'k8s' : 'ocp'}/vars.yml`,
    content: `cluster_type: ${cluster}\n\n${block}:\n  name: ${namespace.name.trim()}\n  user: ${user}\n  ${token}\n`,
  }
}

/** A database's host: written once per project, kept when it is there. */
export const localhostVars = (system: string): PipelineFile => ({ path: `${system}/host_vars/localhost/vars.yml`, content: 'ansible_connection: local\n' })

/**
 * The application's `group_vars/<application>/…`: the template with the name
 * filled in, then the keys each technology sets — the old
 * `build_group_vars_files`, step for step.
 *
 * Not ported: the old code replaced the reference application's name wherever
 * it appeared in the copied text, so a name that was also part of something
 * else (a project, a host, a longer name) was changed too. The templates mark
 * where the name goes with `__APPLICATION__`, put there once at extraction
 * and reviewed.
 */
export function applicationFiles(key: string, definition: TechnologyDefinition, ctx: PipelineContext, templates: TemplateFile[]): PipelineFile[] {
  const { spec } = ctx
  const app = spec.application
  const dir = `${ctx.system}/group_vars/${app}`
  const fields = spec.fields
  const version = spec.version
  const versionFields = (version && definition.versionFieldOverrides?.[version]) || {}

  const files = templates.map((template) => {
    const path = template.path.replaceAll(APPLICATION, app)
    const name = posix.basename(path)
    let content = template.content.replaceAll(APPLICATION, app)

    if (name === 'cicd.yml') {
      content = setKey(content, 'repository_name', ctx.repository)
      if (spec.library) {
        content = setKey(content, 'deploy_technology', 'None')
        content = setKey(content, 'deploy_platform', 'None')
        content = setKey(content, 'app_type', 'Lib')
      }
    }
    if (key === 'Maven_InContainer' && name === 'Spring.yml') {
      if (fields.artifact_id) content = setKey(content, 'artifact_id', fields.artifact_id)
      // group_path is always group_id; it is never asked for.
      if (fields.group_id) {
        content = setKey(content, 'group_id', fields.group_id)
        content = setKey(content, 'group_path', fields.group_id)
      }
    }
    if (key === 'DotNetCore' && name === 'cicd.yml') {
      content = setKey(content, 'app_path', `"${app}"`, { append: true })
      if (fields.nuget_name) content = setKey(content, 'nuget_name', fields.nuget_name)
      for (const [field, value] of Object.entries(versionFields)) content = setKey(content, field, value)
    }
    if (key === 'Flutter' && name === 'cicd.yml' && fields.app_path) {
      content = setKey(content, 'app_path', `"${fields.app_path}"`)
    }
    if (definition.dockerfileByTarget && name === 'cicd.yml') {
      const dockerfile = definition.dockerfileByTarget[spec.deployTarget]
      if (dockerfile) content = setKey(content, 'dockerfile_name', `"${dockerfile}"`, { append: true })
    }
    for (const tag of definition.versionTagOverrides ?? []) {
      if (name === tag.file && version) content = setNested(content, tag.top, tag.sub, (tag.format ?? '{version}').replaceAll('{version}', version))
    }
    return { path: `${dir}/${path}`, content }
  })

  for (const [name, content] of Object.entries(definition.generatedFiles ?? {})) {
    const path = `${dir}/${name}`
    const existing = files.find((f) => f.path === path)
    if (existing) existing.content = content
    else files.push({ path, content })
  }
  return files
}

/**
 * A new project's `group_vars/all/`: the template project's files with the
 * project's name, and a `team.yml` of its own.
 *
 * Not ported: the old code copied GAFI_Digital_Network's files and changed
 * only `project_name`, so anything else naming that project came along; and it
 * wrote `team.yml` only if the template project happened to have one. Here
 * the template marks the project's name with `__PROJECT__`, and `team.yml` is
 * always written.
 */
export function projectFiles(ctx: PipelineContext, teams: ProjectTeams, templates: TemplateFile[]): PipelineFile[] {
  const dir = `${ctx.system}/group_vars/all`
  const files = templates
    .filter((t) => t.path !== 'team.yml')
    .map((t) => {
      let content = t.content.replaceAll(PROJECT, ctx.project)
      if (t.path === 'project.yml') content = setKey(content, 'project_name', ctx.project)
      return { path: `${dir}/${t.path.replaceAll(PROJECT, ctx.project)}`, content }
    })
  return [...files, { path: `${dir}/team.yml`, content: teamYml(teams) }]
}

/** Who stands in for an empty list that must not be empty: DevOps, as the old portal had it. */
const DEVOPS = 'DEVOPS'

/**
 * `group_vars/all/team.yml`, in the old portal's order. Scalars plain, the
 * auto-deploy flag a quoted string, and an empty list as one empty item —
 * which is how the projects already there spell "nobody". The ops, approver,
 * prd-only and manager lists fall back to DEVOPS when left empty, as they did
 * before; the form says so.
 *
 * Not ported: the old code ignored the auto-deploy answer and wrote "false"
 * for the DEVdotNET team and "true" for everyone else. The answer is the
 * requester's, and the approver sees it.
 */
export function teamYml(teams: ProjectTeams): string {
  const scalar = (value: string) => (/^[\w.@-]+$/.test(value) ? value : JSON.stringify(value))
  const list = (values: string[], fallback: string[] = []) => {
    const items = values.length ? values : fallback
    return items.length ? items.map((v) => `  - ${scalar(v)}`).join('\n') : '  -'
  }
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
    list(teams.opsTeamList, [DEVOPS]),
    'prd_approvers:',
    list(teams.prdApprovers, [DEVOPS]),
    'prd_only:',
    list(teams.prdOnly, [DEVOPS]),
    'project_managers:',
    list(teams.projectManagers, [DEVOPS]),
    '',
  ].join('\n')
}
