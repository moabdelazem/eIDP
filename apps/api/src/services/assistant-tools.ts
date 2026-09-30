import { z } from 'zod'
import type { ToolSpec } from '../integrations/ollama/index.ts'
import { config } from '../lib/config.ts'
import { query } from '../lib/db.ts'
import { readApplication } from './catalog.ts'
import * as jenkins from './jenkins.ts'
import { can, type Access } from './rbac.ts'
import { listMine, type Actor } from './requests.ts'

/**
 * What the assistant can look up, and nothing it can do. Every tool reads;
 * none acts — the assistant points at the page that acts instead.
 *
 * Each tool is offered to the model only when the person asking holds its
 * permission (`allowed`), so the assistant can never tell someone something
 * the portal would not show them: without `jenkins.view`, Jenkins does not
 * exist as far as the model knows. Results are the portal's own data, already
 * redacted where it is stored (the catalog's `[hidden]`, Jenkins' hidden
 * parameters), and capped in size so one result cannot fill the context.
 */

export type ToolContext = { actor: Actor; access: Access }

type Tool<A extends z.ZodType> = {
  name: string
  description: string
  args: A
  /** Only offered to people this returns true for. */
  allowed: (access: Access) => boolean
  /** What the person sees while it runs: "Searched applications for scoring". */
  label: (args: z.infer<A>) => string
  run: (args: z.infer<A>, ctx: ToolContext) => Promise<unknown>
}

function tool<A extends z.ZodType>(t: Tool<A>): Tool<A> {
  return t
}

const WINDOW = z.enum(['24h', '7d']).catch('24h')
const ENVIRONMENTS = ['dev', 'qc', 'uat', 'prd_dr', 'prd'] as const

const jenkinsOn = (access: Access) =>
  Boolean(config.JENKINS_URL && config.JENKINS_USER && config.JENKINS_TOKEN) && can(access, 'jenkins.view')

const appLink = (id: string) => `/projects/${encodeURIComponent(id)}`
const buildLink = (job: string, number: number) => `/jenkins/build?${new URLSearchParams({ job, number: String(number) })}`

const TOOLS = [
  tool({
    name: 'search_applications',
    description:
      'Find applications in the inventories catalog by name, system, repository or technology (e.g. "spring", "dotnet", "flutter", "openshift"). Each word must match. Returns each application with its system, environments, repository, technologies and portal link.',
    args: z.object({
      query: z.string().max(200).catch(''),
      environment: z.enum(ENVIRONMENTS).optional().catch(undefined),
    }),
    allowed: (access) => can(access, 'catalog.view'),
    label: (a) => `Searched applications for “${a.query}”${a.environment ? ` in ${a.environment}` : ''}`,
    run: async ({ query: text, environment }) => {
      const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 6)
      const values: unknown[] = []
      const where = words.map((word) => {
        values.push(`%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
        const p = `$${values.length}`
        return `(a.name ilike ${p} or a.group_name ilike ${p} or coalesce(a.repository, '') ilike ${p}
                or s.project_name ilike ${p} or s.dir ilike ${p}
                or coalesce(a.build_technology, '') ilike ${p} or coalesce(a.deploy_technology, '') ilike ${p}
                or coalesce(a.deploy_platform, '') ilike ${p}
                or exists (select 1 from unnest(a.technologies) t where t ilike ${p}))`
      })
      if (environment) {
        values.push(environment)
        where.push(`a.environment = $${values.length}`)
      }
      const { rows } = await query<{ id: string; system_dir: string; project_name: string; name: string; environment: string | null; repository: string | null; technologies: string[] }>(
        `select a.id, a.system_dir, s.project_name, a.name, a.environment, a.repository, a.technologies
           from catalog_applications a join catalog_systems s on s.dir = a.system_dir
          ${where.length ? `where ${where.join(' and ')}` : ''}
          order by a.name, a.environment nulls first limit 400`,
        values,
      )
      // One entry per application, with the environments it is in.
      const apps = new Map<string, { name: string; system: string; environments: string[]; repository: string | null; technologies: string[]; link: string }>()
      for (const row of rows) {
        const key = `${row.system_dir}/${row.name}`
        const app = apps.get(key) ?? { name: row.name, system: row.project_name, environments: [], repository: row.repository, technologies: row.technologies, link: appLink(row.id) }
        if (row.environment) app.environments.push(row.environment)
        else app.link = appLink(row.id)
        app.repository ??= row.repository
        apps.set(key, app)
      }
      const all = [...apps.values()]
      return { total: all.length, applications: all.slice(0, 15), ...(all.length > 15 ? { note: `Showing 15 of ${all.length}; ask with more words to narrow.` } : {}) }
    },
  }),

  tool({
    name: 'get_application',
    description:
      'The configuration of one application, per environment, as the inventories repo defines it: images, ports, route, resources, replicas and more. Secrets are shown as [hidden]. Use search_applications first to find its exact name and system.',
    args: z.object({ system: z.string().max(200).catch(''), name: z.string().max(200).catch('') }),
    allowed: (access) => can(access, 'catalog.view'),
    label: (a) => `Read the configuration of ${a.name}`,
    run: async ({ system, name }) => {
      const dir = await systemDir(system)
      if (!dir) return { error: `There is no system called ${system}.` }
      const rows = await readApplication(dir, name)
      if (rows.length === 0) return { error: `${dir} has no application called ${name}.` }
      return {
        system: dir,
        name,
        link: appLink(rows[0]!.id),
        environments: rows.map((row) => ({
          environment: row.environment ?? 'base (applies everywhere unless an environment overrides it)',
          repository: row.repository,
          technologies: row.technologies,
          configuration: cap(row.descriptor, 1800),
        })),
      }
    },
  }),

  tool({
    name: 'get_system',
    description:
      'Who owns a system (a project in the inventories): the team for each environment, production approvers, project managers and operations teams, and its applications.',
    args: z.object({ name: z.string().max(200).catch('') }),
    allowed: (access) => can(access, 'catalog.view'),
    label: (a) => `Looked up who owns ${a.name}`,
    run: async ({ name }) => {
      const dir = await systemDir(name)
      if (!dir) return { error: `There is no system called ${name}. Try search_applications.` }
      const { rows } = await query<{ dir: string; project_name: string; company: string | null; teams: Record<string, string>; approvers: string[]; managers: string[]; ops_teams: string[] }>(
        'select dir, project_name, company, teams, approvers, managers, ops_teams from catalog_systems where dir = $1',
        [dir],
      )
      const system = rows[0]!
      const apps = await query<{ name: string }>('select distinct name from catalog_applications where system_dir = $1 order by name', [dir])
      return {
        system: system.project_name,
        directory: system.dir,
        company: system.company,
        teamPerEnvironment: system.teams,
        productionApprovers: system.approvers,
        projectManagers: system.managers,
        operationsTeams: system.ops_teams,
        applications: apps.rows.map((r) => r.name).slice(0, 50),
        link: `/map?q=${encodeURIComponent(system.project_name)}`,
      }
    },
  }),

  tool({
    name: 'my_requests',
    description:
      "The requests the person asking has filed in the portal (repositories, projects, Jira projects, access), newest first, with status: pending (waiting for DevOps), approved (being created), completed, rejected (with the reason), failed, cancelled.",
    args: z.object({ status: z.enum(['pending', 'approved', 'completed', 'rejected', 'failed', 'cancelled']).optional().catch(undefined) }),
    allowed: (access) => can(access, 'requests.create'),
    label: () => 'Looked at your requests',
    run: async ({ status }, { actor }) => {
      const mine = (await listMine(actor.uid)).filter((r) => !status || r.status === status)
      return {
        total: mine.length,
        requests: mine.slice(0, 15).map((r) => ({
          kind: r.kind,
          target: r.kind === 'create_jira_project' ? `Jira ${r.projectKey} ${r.project}` : [r.collection, r.project, r.repository].filter(Boolean).join('/'),
          status: r.status,
          requestedAt: r.requestedAt,
          decidedBy: r.decidedByName,
          note: r.decisionNote,
          error: r.error,
          link: `/requests/${r.id}`,
        })),
      }
    },
  }),

  tool({
    name: 'jenkins_failing',
    description: 'Jenkins jobs whose latest finished build failed or was unstable right now, with how many builds in a row and since when.',
    args: z.object({}).catch({}),
    allowed: jenkinsOn,
    label: () => 'Checked which Jenkins jobs are failing',
    run: async () => {
      const { failures } = await jenkins.overview()
      return {
        failing: failures.length,
        jobs: failures.slice(0, 15).map((f) => ({
          job: f.job,
          result: f.last.result,
          build: f.last.number,
          brokenForBuilds: f.streak,
          since: f.since,
          lastPassed: f.lastSuccess,
          link: buildLink(f.job, f.last.number),
        })),
      }
    },
  }),

  tool({
    name: 'jenkins_builds',
    description:
      'Search Jenkins builds from the last 24 hours or 7 days. Words match the job, parameter values, cause or agent; NAME=value matches a build parameter (e.g. BRANCH=release). Optionally only one result: success, failure, unstable, aborted, running.',
    args: z.object({
      query: z.string().max(300).catch(''),
      window: WINDOW,
      result: z.enum(['success', 'failure', 'unstable', 'aborted', 'running']).optional().catch(undefined),
    }),
    allowed: jenkinsOn,
    label: (a) => `Searched Jenkins builds${a.query ? ` for “${a.query}”` : ''} over ${a.window === '7d' ? '7 days' : '24 hours'}`,
    run: async ({ query: q, window, result }) => {
      const found = await jenkins.runs({ window, q, result, limit: 15, offset: 0 })
      return {
        total: found.total,
        builds: found.runs.map((r) => ({
          job: r.job,
          build: r.number,
          result: r.result,
          startedAt: r.startedAt,
          durationSeconds: Math.round(r.durationMs / 1000),
          parameters: Object.fromEntries(r.parameters.filter((p) => !p.hidden).map((p) => [p.name, p.value])),
          link: buildLink(r.job, r.number),
        })),
      }
    },
  }),

  tool({
    name: 'jenkins_stats',
    description: 'How Jenkins did over the last 24 hours or 7 days against the period before: builds, success rate, failures, typical build time, the jobs that failed most and the slowest.',
    args: z.object({ window: WINDOW }),
    allowed: jenkinsOn,
    label: (a) => `Read Jenkins numbers for the last ${a.window === '7d' ? '7 days' : '24 hours'}`,
    run: async ({ window }) => {
      const s = await jenkins.stats(window)
      return { window, current: s.current, previous: s.previous, runningNow: s.running, failedMost: s.topFailing, slowest: s.slowest.slice(0, 5), link: `/jenkins?window=${window}` }
    },
  }),
]

/** The tools this person may use, as the model is offered them. */
export function toolsFor(access: Access): ToolSpec[] {
  return TOOLS.filter((t) => t.allowed(access)).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.args, { io: 'input' }) },
  }))
}

/**
 * Runs one tool call from the model. A tool it was not offered — a name it
 * invented, or one this person may not use — is refused, not run: what the
 * model asks for is never trusted over what the person may see.
 */
export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<{ label: string; content: string }> {
  const found = TOOLS.find((t) => t.name === name)
  if (!found || !found.allowed(ctx.access)) {
    return { label: `Refused an unknown tool (${name.slice(0, 40)})`, content: JSON.stringify({ error: `There is no tool called ${name}.` }) }
  }
  const t = found as Tool<z.ZodType>
  const args = t.args.parse(rawArgs ?? {})
  try {
    return { label: t.label(args), content: cap(await t.run(args, ctx), 6000) }
  } catch (err) {
    return { label: t.label(args), content: JSON.stringify({ error: err instanceof Error ? err.message : 'The lookup failed.' }) }
  }
}

/** A system by its directory or its project name, either case. */
async function systemDir(name: string): Promise<string | null> {
  const { rows } = await query<{ dir: string }>(
    'select dir from catalog_systems where lower(dir) = lower($1) or lower(project_name) = lower($1) limit 1',
    [name.trim()],
  )
  return rows[0]?.dir ?? null
}

/** JSON, cut to `max` characters with a note, so one result cannot fill the context window. */
function cap(value: unknown, max: number): string {
  const text = JSON.stringify(value)
  return text.length <= max ? text : `${text.slice(0, max)}… (cut: the result was ${text.length} characters)`
}
