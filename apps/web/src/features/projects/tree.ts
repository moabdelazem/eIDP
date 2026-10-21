import type { Application, Environment, System } from './catalog.ts'

/**
 * One node in the map. The graph is a tree, so a node has one parent.
 *
 * Ids carry their kind (`system:AgriLand`, `app:<application id>`), so a
 * selection can live in the URL (`/map?sel=app:…`) and be found again without
 * guessing where one id ends and the next begins. An application is a leaf:
 * its environments ride on its card, not as a level of their own.
 */
export type MapNode = {
  id: string
  label: string
  kind: 'root' | 'bucket' | 'system' | 'application'
  children?: MapNode[]
  /** A short count or label beside the name ("7 apps", "DotNetCore"). */
  meta?: string
  system?: System
  app?: Application
}

export type Filters = {
  query: string
  technologies: string[]
  environments: Environment[]
}

export const emptyFilters: Filters = { query: '', technologies: [], environments: [] }

export const ENV_ORDER: Environment[] = ['dev', 'qc', 'uat', 'prd_dr', 'prd']

/** Production, and its disaster-recovery twin: marked on every card and pill. */
export const isProduction = (env: string) => env === 'prd' || env === 'prd_dr'

/** How an environment reads on a pill: `prd_dr` as "prd-dr". */
export const envLabel = (env: string) => env.replace('_', '-')

/**
 * Above this many systems a flat root is a wall of siblings no one can scan,
 * so they are grouped by initial. Below it the extra level is just a click in
 * the way.
 */
export const BUCKET_THRESHOLD = 24

export const systemId = (system: Pick<System, 'id'>) => `system:${system.id}`
// An application's id is its name, which two systems may share: scoped by its system, it is unique on the map and in a link.
export const appId = (system: Pick<System, 'id'>, app: Pick<Application, 'id'>) => `app:${system.id}/${app.id}`

export function hasFilters(filters: Filters): boolean {
  return filters.query.trim() !== '' || filters.technologies.length > 0 || filters.environments.length > 0
}

/** The technologies and environments actually present, each with how many applications have it — for the filters and the overview. */
export function facetsOf(systems: System[]): {
  technologies: { name: string; count: number }[]
  environments: { name: Environment; count: number }[]
} {
  const technologies = new Map<string, number>()
  const environments = new Map<Environment, number>()
  for (const system of systems) {
    for (const app of system.applications) {
      if (app.buildTechnology) technologies.set(app.buildTechnology, (technologies.get(app.buildTechnology) ?? 0) + 1)
      for (const env of app.environments) environments.set(env, (environments.get(env) ?? 0) + 1)
    }
  }
  return {
    technologies: [...technologies].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    environments: ENV_ORDER.filter((env) => environments.has(env)).map((name) => ({ name, count: environments.get(name)! })),
  }
}

export function matchesApplication(app: Application, filters: Filters): boolean {
  const query = filters.query.trim().toLowerCase()
  if (query && !app.name.toLowerCase().includes(query) && !app.repository?.toLowerCase().includes(query)) return false
  if (filters.technologies.length > 0 && !filters.technologies.includes(app.buildTechnology ?? '')) return false
  if (filters.environments.length > 0 && !filters.environments.some((env) => app.environments.includes(env))) return false
  return true
}

/**
 * The systems the filters leave, each with the applications that survive.
 *
 * A system survives if it matches by name, or if any of its applications do.
 * When it survives by name alone, all its applications come with it — you
 * searched for the system, so you want to see what is in it. The map and the
 * list both read this, so they never disagree about what matches.
 */
export function filterSystems(systems: System[], filters: Filters): { system: System; apps: Application[] }[] {
  const query = filters.query.trim().toLowerCase()
  const narrowing = hasFilters(filters)
  const kept: { system: System; apps: Application[] }[] = []
  for (const system of systems) {
    const nameMatches = query !== '' && system.projectName.toLowerCase().includes(query)
    const apps = system.applications.filter((app) => (nameMatches ? true : matchesApplication(app, filters)))
    if (narrowing && apps.length === 0 && !nameMatches) continue
    kept.push({ system, apps })
  }
  return kept
}

/** Builds the tree for the current filters. */
export function buildTree(systems: System[], rootLabel: string, filters: Filters): MapNode {
  const kept = filterSystems(systems, filters).map(({ system, apps }) => systemNode(system, apps))
  const children = kept.length > BUCKET_THRESHOLD && !hasFilters(filters) ? bucketByInitial(kept) : kept
  return { id: 'root', label: rootLabel, kind: 'root', meta: countLabel(kept.length, 'system'), children }
}

/** Groups systems under their initial so the root stays scannable. */
function bucketByInitial(systems: MapNode[]): MapNode[] {
  const buckets = new Map<string, MapNode[]>()
  for (const system of systems) {
    const initial = (system.label[0] ?? '#').toUpperCase()
    const key = /[A-Z]/.test(initial) ? initial : '#'
    buckets.set(key, [...(buckets.get(key) ?? []), system])
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([initial, members]) => ({ id: `bucket:${initial}`, label: initial, kind: 'bucket' as const, meta: countLabel(members.length, 'system'), children: members }))
}

function systemNode(system: System, applications: Application[]): MapNode {
  return {
    id: systemId(system),
    label: system.projectName,
    kind: 'system',
    meta: countLabel(applications.length, 'app'),
    system,
    children: applications.map((app) => ({
      id: appId(system, app),
      label: app.name,
      kind: 'application' as const,
      meta: app.buildTechnology ?? undefined,
      system,
      app: { ...app, environments: [...app.environments].sort((a, b) => ENV_ORDER.indexOf(a) - ENV_ORDER.indexOf(b)) },
    })),
  }
}

export function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** Every id from the root down to `id`, so a match can be opened. */
export function pathTo(root: MapNode, id: string): string[] | null {
  if (root.id === id) return [root.id]
  for (const child of root.children ?? []) {
    const found = pathTo(child, id)
    if (found) return [root.id, ...found]
  }
  return null
}

/** Ids of every branch that has children, for expand-all on a narrowed tree. */
export function allBranchIds(root: MapNode, depth = Infinity): string[] {
  if (depth < 0 || !root.children?.length) return []
  return [root.id, ...root.children.flatMap((child) => allBranchIds(child, depth - 1))]
}

export function countLeaves(root: MapNode, kind: MapNode['kind']): number {
  const self = root.kind === kind ? 1 : 0
  return self + (root.children ?? []).reduce((total, child) => total + countLeaves(child, kind), 0)
}

/** Environments in pipeline order (dev → prd); one this build does not know goes last, by name. */
export function inOrder(environments: string[]): string[] {
  const rank = (env: string) => {
    const i = (ENV_ORDER as string[]).indexOf(env)
    return i === -1 ? ENV_ORDER.length : i
  }
  return [...environments].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/** The system or application a selection id names, if it still exists. */
export function resolve(systems: System[], id: string | null): { system: System; app?: Application } | null {
  if (!id) return null
  for (const system of systems) {
    if (systemId(system) === id) return { system }
    const app = system.applications.find((a) => appId(system, a) === id)
    if (app) return { system, app }
  }
  return null
}
