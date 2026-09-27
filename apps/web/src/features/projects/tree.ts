import type { Application, Environment, System } from './catalog.ts'

/** One node in the map. The graph is a tree, so a node has one parent. */
export type MapNode = {
  id: string
  label: string
  kind: 'root' | 'bucket' | 'system' | 'application' | 'environment'
  href?: string
  children?: MapNode[]
  meta?: string
}

export type Filters = {
  query: string
  technologies: string[]
  environments: Environment[]
}

export const emptyFilters: Filters = { query: '', technologies: [], environments: [] }

const ENV_ORDER: Environment[] = ['dev', 'qc', 'uat', 'prd_dr', 'prd']

/**
 * Above this many systems a flat root is a wall of siblings no one can scan,
 * so they are grouped by initial. Below it the extra level is just a click in
 * the way.
 */
const BUCKET_THRESHOLD = 24

export function hasFilters(filters: Filters): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.technologies.length > 0 ||
    filters.environments.length > 0
  )
}

/** The technologies and environments actually present, for the filter menus. */
export function facetsOf(systems: System[]): {
  technologies: string[]
  environments: Environment[]
} {
  const technologies = new Set<string>()
  const environments = new Set<Environment>()
  for (const system of systems) {
    for (const app of system.applications) {
      if (app.buildTechnology) technologies.add(app.buildTechnology)
      for (const env of app.environments) environments.add(env)
    }
  }
  return {
    technologies: [...technologies].sort((a, b) => a.localeCompare(b)),
    environments: ENV_ORDER.filter((env) => environments.has(env)),
  }
}

function matchesApplication(app: Application, filters: Filters): boolean {
  const query = filters.query.trim().toLowerCase()
  if (query && !app.name.toLowerCase().includes(query) && !app.repository?.toLowerCase().includes(query)) {
    return false
  }
  if (filters.technologies.length > 0 && !filters.technologies.includes(app.buildTechnology ?? '')) {
    return false
  }
  if (
    filters.environments.length > 0 &&
    !filters.environments.some((env) => app.environments.includes(env))
  ) {
    return false
  }
  return true
}

/**
 * Builds the tree for the current filters.
 *
 * A system survives if it matches by name, or if any of its applications do.
 * When it survives by name alone, all its applications come with it — you
 * searched for the system, so you want to see what is in it.
 */
export function buildTree(systems: System[], rootLabel: string, filters: Filters): MapNode {
  const query = filters.query.trim().toLowerCase()
  const narrowing = hasFilters(filters)

  const kept: MapNode[] = []
  for (const system of systems) {
    const nameMatches = query !== '' && system.projectName.toLowerCase().includes(query)
    const apps = system.applications.filter((app) =>
      nameMatches ? true : matchesApplication(app, filters),
    )

    if (narrowing && apps.length === 0 && !nameMatches) continue
    kept.push(systemNode(system, apps))
  }

  const children =
    kept.length > BUCKET_THRESHOLD && !narrowing ? bucketByInitial(kept) : kept

  return {
    id: 'root',
    label: rootLabel,
    kind: 'root',
    meta: countLabel(kept.length, 'system'),
    children,
  }
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
    .map(([initial, members]) => ({
      id: `bucket:${initial}`,
      label: initial,
      kind: 'bucket' as const,
      meta: countLabel(members.length, 'system'),
      children: members,
    }))
}

function systemNode(system: System, applications: Application[]): MapNode {
  return {
    id: system.id,
    label: system.projectName,
    kind: 'system',
    meta: countLabel(applications.length, 'app'),
    children: applications.map((app) => applicationNode(system, app)),
  }
}

function applicationNode(system: System, app: Application): MapNode {
  return {
    id: `${system.id}/${app.id}`,
    label: app.name,
    kind: 'application',
    href: `/projects/${encodeURIComponent(app.id)}`,
    meta: app.buildTechnology ?? undefined,
    children: [...app.environments]
      .sort((a, b) => ENV_ORDER.indexOf(a) - ENV_ORDER.indexOf(b))
      .map((env) => ({
        id: `${system.id}/${app.id}/${env}`,
        label: env,
        kind: 'environment' as const,
        meta: system.teams[env],
      })),
  }
}

function countLabel(count: number, noun: string): string {
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
