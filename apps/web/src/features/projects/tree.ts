import type { Application, Environment, System } from './catalog.ts'

/** One node in the map. The graph is a tree, so a node has one parent. */
export type MapNode = {
  id: string
  label: string
  kind: 'root' | 'system' | 'application' | 'environment'
  /** Where clicking the label goes, when the node stands for a page. */
  href?: string
  /** Undefined for leaves; empty array is a parent with nothing under it. */
  children?: MapNode[]
  meta?: string
}

const ENV_ORDER: Environment[] = ['dev', 'qc', 'uat', 'prd_dr', 'prd']

/** Builds the whole tree once; expansion is handled at render time. */
export function buildTree(systems: System[], rootLabel = 'Organization'): MapNode {
  return {
    id: 'root',
    label: rootLabel,
    kind: 'root',
    children: systems.map(systemNode),
  }
}

function systemNode(system: System): MapNode {
  return {
    id: system.id,
    label: system.projectName,
    kind: 'system',
    meta: `${system.applications.length} app${system.applications.length === 1 ? '' : 's'}`,
    children: system.applications.map((app) => applicationNode(system, app)),
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

/** Every id on the path from the root down to `id`, so search can open it. */
export function pathTo(root: MapNode, id: string): string[] | null {
  if (root.id === id) return [root.id]
  for (const child of root.children ?? []) {
    const found = pathTo(child, id)
    if (found) return [root.id, ...found]
  }
  return null
}

/** Node ids whose label matches, cheapest possible search. */
export function matches(root: MapNode, query: string): MapNode[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  const found: MapNode[] = []
  const walk = (node: MapNode) => {
    if (node.label.toLowerCase().includes(needle)) found.push(node)
    node.children?.forEach(walk)
  }
  walk(root)
  return found
}
