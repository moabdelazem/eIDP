import type { Check, PipelineProject, PipelineSpec } from '@eidp/contracts/requests'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { listRepositories } from '../../../integrations/ado/index.ts'
import { db } from '../../../lib/db.ts'
import { catalogApplications, catalogSystems } from '../../catalog/index.ts'
import { same } from '../rows.ts'
import { requests } from '../schema.ts'
import { overridePrefix } from './files.ts'
import { environmentsFor, technology } from './technologies.ts'

export type PipelineTarget = { kind: 'create_pipeline'; collection: string; project: string; repository: string; pipeline: PipelineSpec }

/** What inventories would accept as an application's directory name. */
const APPLICATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const VERSION = /^[\w.+-]{1,32}$/

/**
 * Whether a pipeline could be asked for as it stands — the same answer the
 * form shows and `submit` enforces. Against the catalog (the last sync of
 * inventories) and ADO; the files themselves are checked again against
 * inventories at approval, when they are written.
 */
export async function checkPipeline(input: PipelineTarget): Promise<Check> {
  const spec = input.pipeline
  const fail = (reason: string): Check => ({ ok: false, reason })

  if (!APPLICATION.test(spec.application)) return fail('An application name is letters, digits, dots, dashes and underscores, starting with a letter or digit, at most 64.')
  if (spec.application.toLowerCase() === 'all') return fail('“all” holds a project’s own files in inventories; choose another name.')
  const prefix = overridePrefix(spec.application)
  if (prefix) return fail(`Inventories reads a name starting with “${prefix}_” as the ${prefix} override of another application. Choose a name without it.`)

  const template = technology(spec.technology)
  if (!template) return fail(`Pipelines for ${spec.technology} are not set up in the portal.`)
  if (!template.targets.includes(spec.deployTarget)) return fail(`${template.label} does not deploy to ${spec.deployTarget}.`)
  if (template.versions.length && !(spec.version && VERSION.test(spec.version))) return fail(`Choose the ${template.label} version.`)
  for (const field of template.fields) {
    const value = spec.fields[field.name]?.trim()
    if (!value) return fail(`${field.label} is needed for ${template.label}.`)
    if (field.options && !field.options.includes(value)) return fail(`${field.label} is one of ${field.options.join(', ')}.`)
  }

  const repos = await listRepositories(input.collection, input.project)
  if (!repos.some((r) => same(r.name, input.repository))) return fail(`${input.project} has no repository called ${input.repository}.`)

  const project = await pipelineProject(input.project)
  if (project.exists && spec.newProject) return fail(`${input.project} already has its project files in inventories; they are reused, so its teams are not asked for.`)
  if (!project.exists && !spec.newProject) return fail(`${input.project} is new to inventories: its teams and namespaces are needed.`)
  if (spec.newProject) {
    const t = spec.newProject.teams
    const missing = (
      [
        ['Company', t.company],
        ['Dev team', t.devTeam],
        ['QC team', t.qcTeam],
        ['UAT team', t.uatTeam],
        ['PRD team', t.prdTeam],
      ] as const
    ).find(([, value]) => !value.trim())
    if (missing) return fail(`${missing[0]} is needed for a new project.`)
    if (!template.noNamespaces) {
      const environments = environmentsFor(spec.deployTarget)
      if (!environments.length) return fail(`Namespaces for ${spec.deployTarget} are not set up in the portal.`)
      const empty = environments.find((env) => !spec.newProject!.namespaces[env.key]?.name.trim())
      if (empty) return fail(`Name the ${empty.label} namespace.`)
    }
  }

  if (project.system) {
    const [taken] = await db
      .select({ name: catalogApplications.name })
      .from(catalogApplications)
      .where(and(eq(catalogApplications.systemDir, project.system), eq(sql`lower(${catalogApplications.name})`, spec.application.toLowerCase())))
      .limit(1)
    if (taken) return fail(`${project.system} already has an application called ${taken.name}.`)
  }

  const [asked] = await db
    .select({ by: requests.requestedByName })
    .from(requests)
    .where(
      and(
        eq(requests.kind, 'create_pipeline'),
        inArray(requests.status, ['pending', 'approved']),
        eq(sql`lower(${requests.project})`, input.project.toLowerCase()),
        or(
          eq(sql`lower(${requests.pipeline}->>'application')`, spec.application.toLowerCase()),
          eq(sql`lower(${requests.repository})`, input.repository.toLowerCase()),
        ),
      ),
    )
    .limit(1)
  if (asked) return fail(`${asked.by} has already asked for this pipeline; it is waiting on approval.`)

  return { ok: true }
}

/** Whether inventories has the project, by its directory or its name — and so what the form asks. */
export async function pipelineProject(project: string): Promise<PipelineProject> {
  const lower = project.toLowerCase()
  const [system] = await db
    .select({ dir: catalogSystems.dir })
    .from(catalogSystems)
    .where(or(eq(sql`lower(${catalogSystems.dir})`, lower), eq(sql`lower(${catalogSystems.projectName})`, lower)))
    .limit(1)
  return {
    exists: Boolean(system),
    system: system?.dir ?? null,
    environments: { OCP: environmentsFor('OCP'), K8s: environmentsFor('K8s') },
  }
}
