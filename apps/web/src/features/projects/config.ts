/**
 * Reading an application's merged configuration for display: the handful of
 * settings people come looking for, the rest flattened, and what each
 * environment changes.
 */

type Json = Record<string, unknown>

export type Setting = { label: string; value: string; hint?: string }

function get(source: Json, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Json)[key] : undefined), source)
}

function text(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'object') return null
  return String(value)
}

function image(source: Json, key: string): string | null {
  const name = text(get(source, `${key}.name`))
  const tag = text(get(source, `${key}.tag`))
  return name ? (tag ? `${name}:${tag}` : name) : null
}

/** "256Mi → 2048Mi": what is reserved, then what it may burst to. */
function range(source: Json, resource: 'cpu' | 'memory'): string | null {
  const request = text(get(source, `resources.requests.${resource}`))
  const limit = text(get(source, `resources.limits.${resource}`))
  if (!request && !limit) return null
  if (request && limit) return `${request} → ${limit}`
  return request ?? `up to ${limit}`
}

/**
 * The settings people come to an application page for. Only those the
 * configuration actually has are returned — a Spring app has no nuget_name,
 * and an empty row saying so is noise.
 */
export function keySettings(source: Json): Setting[] {
  const rows: [string, string | null, string?][] = [
    ['Build image', image(source, 'build_image')],
    ['Deploy image', image(source, 'deploy_image')],
    ['Container port', text(get(source, 'server.port'))],
    ['Service port', text(get(source, 'ocp_service.expose_port'))],
    ['Node port', text(get(source, 'ocp_service.expose_nodeport'))],
    ['Route', text(get(source, 'route.path'))],
    ['Replicas', text(get(source, 'replicas'))],
    ['CPU', range(source, 'cpu'), 'requested → limit'],
    ['Memory', range(source, 'memory'), 'requested → limit'],
    ['NuGet package', text(get(source, 'nuget_name'))],
  ]
  return rows
    .filter((row): row is [string, string, string?] => row[1] !== null)
    .map(([label, value, hint]) => ({ label, value, hint }))
}

/** Every leaf as `a.b.c = value`, so nothing in the files is hidden from view. */
export function flatten(source: unknown, prefix = ''): [string, string][] {
  if (source === null || source === undefined) return prefix ? [[prefix, '']] : []
  if (Array.isArray(source)) {
    if (source.every((item) => item === null || typeof item !== 'object')) {
      return [[prefix, source.filter((item) => item !== null).join(', ')]]
    }
    return source.flatMap((item, index) => flatten(item, `${prefix}[${index}]`))
  }
  if (typeof source === 'object') {
    const entries = Object.entries(source as Json)
    if (entries.length === 0) return prefix ? [[prefix, '']] : []
    return entries.flatMap(([key, value]) => flatten(value, prefix ? `${prefix}.${key}` : key))
  }
  return [[prefix, String(source)]]
}

export type Difference = { key: string; base: string | null; value: string | null }

/**
 * What an environment's override changes from the base configuration. The
 * point of the per-environment groups is exactly this — prd running three
 * replicas where dev runs one — and it is invisible until it is laid side by
 * side.
 */
export function differences(base: Json, override: Json): Difference[] {
  const before = new Map(flatten(base))
  const after = new Map(flatten(override))
  const keys = new Set([...after.keys()])
  const changed: Difference[] = []
  for (const key of [...keys].sort()) {
    const was = before.get(key) ?? null
    const now = after.get(key) ?? null
    if (was !== now) changed.push({ key, base: was, value: now })
  }
  return changed
}
