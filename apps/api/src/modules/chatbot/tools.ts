import { z } from 'zod'
import type { ToolSpec } from '../../integrations/ollama/index.ts'
import { config } from '../../lib/config.ts'
import { eq, or, sql } from 'drizzle-orm'
import { db, sqlRows } from '../../lib/db.ts'
import { catalogApplications, catalogSystems } from '../catalog/index.ts'
import { explainer } from '../jenkins/index.ts'
import { readApplication } from '../catalog/index.ts'
import { demandTeam, peek, recentWeeks, teamsFor, weekOf } from '../digest/index.ts'
import { jenkins } from '../jenkins/index.ts'
import { pipelines } from '../pipelines/index.ts'
import { can, canSomewhere, PERMISSIONS, type Access, type Permission } from '../access/index.ts'
import type { Actor } from '../../lib/actor.ts'
import { get as getRequest, listMine, listPool, type RequestRecord } from '../requests/index.ts'

/**
 * What the chatbot can look up, and nothing it can do. Every tool reads;
 * none acts — the chatbot points at the page that acts instead, and for a
 * request it can hand over the form already filled in (`draft_request`), for
 * the person to check and submit themselves.
 *
 * Each tool is offered to the model only when the person asking holds its
 * permission (`allowed`), so the chatbot can never tell someone something
 * the portal would not show them: without `jenkins.view`, Jenkins does not
 * exist as far as the model knows. Results are the portal's own data, already
 * redacted where it is stored (the catalog's `[hidden]`, Jenkins' hidden
 * parameters), and capped in size so one result cannot fill the context.
 */

export type ToolContext = { actor: Actor; access: Access; me: pipelines.Me }

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
      const where = words.map((word) => {
        const p = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        return sql`(a.name ilike ${p} or a.group_name ilike ${p} or coalesce(a.repository, '') ilike ${p}
                or s.project_name ilike ${p} or s.dir ilike ${p}
                or coalesce(a.build_technology, '') ilike ${p} or coalesce(a.deploy_technology, '') ilike ${p}
                or coalesce(a.deploy_platform, '') ilike ${p}
                or exists (select 1 from unnest(a.technologies) t where t ilike ${p}))`
      })
      if (environment) where.push(sql`a.environment = ${environment}`)
      const rows = await sqlRows<{ id: string; system_dir: string; project_name: string; name: string; environment: string | null; repository: string | null; technologies: string[] }>(
        sql`select a.id, a.system_dir, s.project_name, a.name, a.environment, a.repository, a.technologies
           from ${catalogApplications} a join ${catalogSystems} s on s.dir = a.system_dir
          ${where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``}
          order by a.name, a.environment nulls first limit 400`,
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
      const [system] = await db.select().from(catalogSystems).where(eq(catalogSystems.dir, dir))
      const apps = await db
        .selectDistinct({ name: catalogApplications.name })
        .from(catalogApplications)
        .where(eq(catalogApplications.systemDir, dir))
        .orderBy(catalogApplications.name)
      return {
        system: system!.projectName,
        directory: system!.dir,
        company: system!.company,
        teamPerEnvironment: system!.teams,
        productionApprovers: system!.approvers,
        projectManagers: system!.managers,
        operationsTeams: system!.opsTeams,
        applications: apps.map((r) => r.name).slice(0, 50),
        link: `/map?q=${encodeURIComponent(system!.projectName)}`,
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
    run: async (_, { access }) => {
      const { failures } = await jenkins.overview({ withExplanations: can(access, 'ai.use') })
      return {
        failing: failures.length,
        jobs: failures.slice(0, 15).map((f) => ({
          job: f.job,
          result: f.last.result,
          build: f.last.number,
          brokenForBuilds: f.streak,
          since: f.since,
          lastPassed: f.lastSuccess,
          ...(f.explanation ? { whyItFailed: f.explanation.summary } : {}),
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

  tool({
    name: 'whoami',
    description:
      "Who the person asking is in the portal: their directory groups, the teams of theirs that own systems, what the portal lets them do and why (which group or binding). Use it for \"what can I do\", \"why can't I see X\", \"which team am I in\".",
    args: z.object({}).catch({}),
    allowed: () => true,
    label: () => 'Looked up what you can do here',
    run: async (_, { actor, access }) => {
      const { mine } = await teamsFor(access)
      const held = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => canSomewhere(access, p))
      return {
        name: actor.name,
        login: actor.uid,
        groups: access.groups,
        teams: mine,
        permissions: held.map((p) => ({
          permission: p,
          means: PERMISSIONS[p],
          via: [...new Set(access.grants.filter((g) => g.permission === p).map((g) => g.via + (g.scope ? ` (${g.scopeType} ${g.scope})` : '')))],
        })),
        link: '/me',
      }
    },
  }),

  tool({
    name: 'my_pipelines',
    description:
      "The person's own Jenkins runs and their teams' (runs they started, runs that built their commits, runs for projects their teams own) over 24h, 7d or 30d: which pipelines are broken now, and the latest runs with why each is theirs.",
    args: z.object({ window: z.enum(['24h', '7d', '30d']).catch('7d') }),
    allowed: (access) => Boolean(config.JENKINS_URL && config.JENKINS_USER && config.JENKINS_TOKEN) && canSomewhere(access, 'pipelines.view'),
    label: (a) => `Looked at your pipelines over ${a.window === '24h' ? '24 hours' : a.window === '7d' ? '7 days' : '30 days'}`,
    run: async ({ window }, { access, me }) => {
      const mine = await pipelines.mine(access, me, window)
      const broken = mine.pipelines.filter((p) => {
        const done = p.recent.find((b) => b.result !== 'running' && b.result !== 'not_built')
        return done?.result === 'failure' || done?.result === 'unstable'
      })
      return {
        runs: mine.runs.length,
        brokenNow: broken.slice(0, 10).map((p) => ({ job: p.job, applications: p.applications, last: p.last.number, result: p.last.result, link: runLink(p.job, p.last.number) })),
        latest: mine.runs.slice(0, 10).map((r) => ({
          job: r.job,
          build: r.number,
          result: r.result,
          startedAt: r.startedAt,
          applications: r.applications,
          why: r.reasons.map((x) => x.kind),
          link: runLink(r.job, r.number),
        })),
        link: '/pipelines',
      }
    },
  }),

  tool({
    name: 'build_details',
    description:
      'One Jenkins build in detail: result, stages (with parallel branches and which one broke), parameters, agent, the commits it built, and the portal\'s explanation of a failure if one was made. Give the job\'s full name with folders (e.g. payments/loan-scoring-api) and the build number.',
    args: z.object({ job: z.string().max(300).catch(''), number: z.coerce.number().int().positive().catch(0) }),
    allowed: (access) => Boolean(config.JENKINS_URL && config.JENKINS_USER && config.JENKINS_TOKEN) && (can(access, 'jenkins.view') || canSomewhere(access, 'pipelines.view')),
    label: (a) => `Read build ${a.job} #${a.number}`,
    run: async ({ job, number }, { access, me }) => {
      if (!job || !number) return { error: 'Name the job and the build number.' }
      // A build that is not theirs reads as not found, exactly as on the build page.
      await pipelines.demandView(access, me, job, number)
      const run = await jenkins.run(job, number)
      const explained = await explainer.cached(job, number).catch(() => null)
      const broke = run.stages.find((st) => st.result === 'failure' || st.result === 'unstable')
      return {
        job,
        build: number,
        result: run.result,
        startedAt: run.startedAt,
        durationSeconds: Math.round(run.durationMs / 1000),
        agent: run.builtOn,
        startedBy: run.causes,
        stages: run.stages.map((st) => ({ name: st.name, result: st.result, seconds: Math.round(st.durationMs / 1000), ...(st.branches.length ? { parallel: st.branches.map((b) => ({ name: b.name, result: b.result })) } : {}) })),
        failedStage: broke ? broke.name + (broke.branches.some((b) => b.result === 'failure' || b.result === 'unstable') ? ` › ${broke.branches.filter((b) => b.result === 'failure' || b.result === 'unstable').map((b) => b.name).join(', ')}` : '') : null,
        parameters: Object.fromEntries(run.parameters.filter((p) => !p.hidden).map((p) => [p.name, p.value])),
        commits: run.changes.slice(0, 5),
        ...(explained ? { whyItFailed: { summary: explained.summary, cause: explained.cause, category: explained.category } } : {}),
        // The last lines of the log, where a failure explains itself — already redacted of secrets.
        logTail: explainer.redact(run.log.split('\n').slice(-25).join('\n')).slice(-2000),
        link: runLink(job, number),
      }
    },
  }),

  tool({
    name: 'get_request',
    description: 'One request in the portal by its id (a UUID, as in /requests/<id>): what was asked, its status, who decided it and why, and any error.',
    args: z.object({ id: z.string().max(64).catch('') }),
    allowed: (access) => can(access, 'requests.create'),
    label: () => 'Looked up a request',
    run: async ({ id }, { actor, access }) => {
      const id_ = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(id)?.[0]
      if (!id_) return { error: 'That is not a request id.' }
      const r = await getRequest(id_, actor, access)
      return { ...describeRequest(r), description: r.description, justification: r.justification, grantees: r.grantees, canDecide: r.canDecide, risk: r.assessment ? { level: r.assessment.level, summary: r.assessment.summary } : undefined }
    },
  }),

  tool({
    name: 'pending_approvals',
    description: 'Requests waiting for a decision that the person asking may decide (approve or reject), oldest first, with each one\'s risk level when assessed. Also those approved but failed, which can be retried.',
    args: z.object({}).catch({}),
    allowed: (access) => canSomewhere(access, 'requests.decide_access'),
    label: () => 'Checked what is waiting for your approval',
    run: async (_, { access }) => {
      const { open } = await listPool(access)
      const pending = open.filter((r) => r.status === 'pending')
      return {
        waiting: pending.length,
        requests: pending.slice(0, 12).map((r) => ({ ...describeRequest(r), risk: r.assessment?.level ?? null })),
        failed: open.filter((r) => r.status === 'failed').slice(0, 5).map(describeRequest),
        link: '/approvals',
      }
    },
  }),

  tool({
    name: 'team_digest',
    description:
      "A team's week: builds and success rate against the week before, pipelines that broke, and requests for its projects. Teams are the person's own unless they may read every team's. Defaults to the last finished week; week is the Monday's date, YYYY-MM-DD.",
    args: z.object({ team: z.string().max(100).optional().catch(undefined), week: z.string().max(10).optional().catch(undefined) }),
    allowed: (access) => can(access, 'catalog.view'),
    label: (a) => `Read ${a.team ? `${a.team}’s` : 'your team’s'} weekly digest`,
    run: async ({ team, week }, { access }) => {
      const { teams, mine } = await teamsFor(access)
      const name = team ? await demandTeam(access, team) : (mine[0] ?? null)
      if (!name) return { error: 'You are not in a team that owns a system in the inventories.', teamsYouMayRead: teams.slice(0, 20) }
      const which = week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? week : recentWeeks()[1]!
      const d = await peek(name, which)
      const b = d.facts.builds
      return {
        team: name,
        week: which,
        inProgress: which === weekOf(new Date()),
        builds: b ? { ...b.current, pipelines: b.pipelines, weekBefore: b.previous, brokeThisWeek: b.failing.slice(0, 6), timeToFix: b.fixes } : { error: d.facts.buildsError },
        requests: { ...d.facts.requests, failed: d.facts.requests.failed.slice(0, 5), waiting: d.facts.requests.waiting.slice(0, 5) },
        summary: d.summary,
        link: `/digest?team=${encodeURIComponent(name)}&week=${which}`,
      }
    },
  }),

  tool({
    name: 'draft_request',
    description:
      'Prepare a request for the person to file themselves: returns a link to the request form already filled in. It does not file anything. Kinds: repository (needs project and repository; collection optional), project (an Azure DevOps project; needs project), access (Contribute on an Azure DevOps project for people by login; needs project and people), jira_project (needs name and key). The form checks the names as they are typed.',
    args: z.object({
      kind: z.enum(['repository', 'project', 'access', 'jira_project']).catch('repository'),
      collection: z.string().max(100).optional().catch(undefined),
      project: z.string().max(100).optional().catch(undefined),
      repository: z.string().max(100).optional().catch(undefined),
      people: z.array(z.string().max(64)).max(20).optional().catch(undefined),
      name: z.string().max(100).optional().catch(undefined),
      key: z.string().max(20).optional().catch(undefined),
      reason: z.string().max(500).optional().catch(undefined),
    }),
    allowed: (access) => can(access, 'requests.create'),
    label: (a) => `Drafted a ${a.kind === 'jira_project' ? 'Jira project' : a.kind === 'access' ? 'access' : a.kind} request`,
    run: async (a) => {
      const path = {
        repository: '/requests/new/azure-devops/repository',
        project: '/requests/new/azure-devops/project',
        access: '/requests/new/azure-devops/access',
        jira_project: '/requests/new/jira/project',
      }[a.kind]
      const params = new URLSearchParams()
      const set = (key: string, value: string | undefined) => value?.trim() && params.set(key, value.trim())
      set('collection', a.collection)
      set('project', a.kind === 'jira_project' ? undefined : a.project)
      set('repository', a.kind === 'repository' ? a.repository : undefined)
      set('people', a.kind === 'access' ? a.people?.join(',') : undefined)
      set('name', a.kind === 'jira_project' ? (a.name ?? a.project) : undefined)
      set('key', a.kind === 'jira_project' ? a.key?.toUpperCase() : undefined)
      set('reason', a.reason)
      params.set('from', 'chatbot')
      return {
        filed: false,
        note: 'Nothing is filed. The person opens the form, checks it and submits it themselves; DevOps then approve it.',
        link: `${path}?${params}`,
      }
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

/** Where a run opens: the Jenkins page's build view for those who see Jenkins is the same page under /pipelines for everyone. */
const runLink = (job: string, number: number) => `/pipelines/build?${new URLSearchParams({ job, number: String(number) })}`

/** A request as the model reads it, with its page. */
function describeRequest(r: RequestRecord) {
  return {
    kind: r.kind,
    target: r.kind === 'create_jira_project' ? `Jira ${r.projectKey} ${r.project}` : [r.collection, r.project, r.repository].filter(Boolean).join('/'),
    status: r.status,
    requestedBy: r.requestedByName,
    requestedAt: r.requestedAt,
    decidedBy: r.decidedByName,
    note: r.decisionNote,
    error: r.error,
    link: `/requests/${r.id}`,
  }
}

/** A system by its directory or its project name, either case. */
async function systemDir(name: string): Promise<string | null> {
  const wanted = name.trim().toLowerCase()
  const [row] = await db
    .select({ dir: catalogSystems.dir })
    .from(catalogSystems)
    .where(or(eq(sql`lower(${catalogSystems.dir})`, wanted), eq(sql`lower(${catalogSystems.projectName})`, wanted)))
    .limit(1)
  return row?.dir ?? null
}

/** JSON, cut to `max` characters with a note, so one result cannot fill the context window. */
function cap(value: unknown, max: number): string {
  const text = JSON.stringify(value)
  return text.length <= max ? text : `${text.slice(0, max)}… (cut: the result was ${text.length} characters)`
}
