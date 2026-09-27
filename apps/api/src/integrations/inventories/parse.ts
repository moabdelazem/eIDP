import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Reads the `inventories` repo into a catalog.
 *
 * Layout is flat and uniform: `<System>/group_vars/<app>/<descriptor>.yml`.
 * A system's metadata lives in `group_vars/all/`. Environments are a fixed
 * set, and an `<env>_` prefix on a group name marks that group as an override
 * of the unprefixed base application rather than an application of its own.
 */

export const ENVIRONMENTS = ['dev', 'qc', 'uat', 'prd_dr', 'prd'] as const
export type Environment = (typeof ENVIRONMENTS)[number]

export type InventoryApplication = {
  /** Directory name as written, e.g. `prd_nfp-backend`. */
  group: string
  /** The application itself, with any environment prefix removed. */
  name: string
  /** Null for the base entry that applies to every environment. */
  environment: Environment | null
  repository: string | null
  buildTechnology: string | null
  deployTechnology: string | null
  deployPlatform: string | null
  appType: string | null
  microservice: boolean | null
  /** Derived from descriptor filenames, deduped case-insensitively. */
  technologies: string[]
  /** Everything from cicd.yml verbatim, for fields we do not model yet. */
  descriptor: Record<string, unknown>
}

export type InventorySystem = {
  /** Top-level directory name — the stable id. */
  dir: string
  projectName: string
  company: string | null
  /** Environment to owning team, from project.yml's `<env>_team` keys. */
  teams: Partial<Record<Environment, string>>
  approvers: string[]
  managers: string[]
  opsTeams: string[]
  /** project.yml minus the fields above. */
  policy: Record<string, unknown>
  applications: InventoryApplication[]
}

/**
 * Descriptor files that describe *how* an app is handled rather than *what it
 * is built with*. Everything else in an app directory names a technology.
 */
const NOT_A_TECHNOLOGY = new Set(
  [
    'cicd',
    'logging',
    'ocpresources',
    'resources',
    'vars',
    'service',
    'route',
    'team',
    'project',
    'helmchart',
    'flag',
    'exposed',
    'vault',
    'archivereleases',
  ].map(normalize),
)

/** Lowercase and drop separators, so `ocp-resources` and `ocp_resources` agree. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[-_\s.]/g, '')
}

export async function parseInventories(root: string): Promise<InventorySystem[]> {
  const systems: InventorySystem[] = []

  for (const dir of await subdirectories(root)) {
    const groupVars = join(root, dir, 'group_vars')
    const groups = await subdirectories(groupVars)
    if (groups.length === 0) continue // not an inventory directory

    systems.push({
      ...(await readSystemMeta(groupVars, dir)),
      applications: await Promise.all(
        groups
          .filter((group) => group !== 'all')
          .map((group) => readApplication(join(groupVars, group), group)),
      ),
    })
  }

  return systems.sort((a, b) => a.dir.localeCompare(b.dir))
}

async function readSystemMeta(
  groupVars: string,
  dir: string,
): Promise<Omit<InventorySystem, 'applications'>> {
  const project = await readYaml(join(groupVars, 'all', 'project.yml'))

  const teams: Partial<Record<Environment, string>> = {}
  for (const env of ENVIRONMENTS) {
    const team = project[`${env}_team`]
    if (typeof team === 'string' && team.trim()) teams[env] = team.trim()
  }

  const policy = { ...project }
  for (const key of Object.keys(project)) {
    if (
      key === 'project_name' ||
      key === 'company' ||
      key.endsWith('_team') ||
      key === 'prd_approvers' ||
      key === 'project_managers' ||
      key === 'ops_team_list'
    ) {
      delete policy[key]
    }
  }

  return {
    dir,
    projectName: str(project.project_name) ?? dir,
    company: str(project.company),
    teams,
    approvers: list(project.prd_approvers),
    managers: list(project.project_managers),
    opsTeams: list(project.ops_team_list),
    policy,
  }
}

async function readApplication(dir: string, group: string): Promise<InventoryApplication> {
  const cicd = await readYaml(join(dir, 'cicd.yml'))
  const { environment, name } = splitEnvironment(group)

  return {
    group,
    name,
    environment,
    repository: str(cicd.repository_name),
    buildTechnology: str(cicd.build_technology),
    deployTechnology: str(cicd.deploy_technology),
    deployPlatform: str(cicd.deploy_platform),
    appType: str(cicd.app_type),
    microservice: bool(cicd.microservice),
    technologies: await technologiesIn(dir),
    descriptor: cicd,
  }
}

/** `prd_dr_` must be tried before `prd_`, or the longer prefix never matches. */
export function splitEnvironment(group: string): { environment: Environment | null; name: string } {
  for (const env of ENVIRONMENTS) {
    if (group.startsWith(`${env}_`)) {
      return { environment: env, name: group.slice(env.length + 1) }
    }
  }
  return { environment: null, name: group }
}

async function technologiesIn(dir: string): Promise<string[]> {
  const seen = new Map<string, string>()
  for (const file of await readdir(dir).catch(() => [])) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue
    const stem = file.replace(/\.ya?ml$/, '')
    const key = normalize(stem)
    if (NOT_A_TECHNOLOGY.has(key) || seen.has(key)) continue
    seen.set(key, stem)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

async function readYaml(path: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) return {}
  // Never hand a vault blob to the YAML parser; it is not YAML.
  if (text.startsWith('$ANSIBLE_VAULT')) return {}

  const value = parseYaml(text)
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

async function subdirectories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number') return String(value)
  return null
}

/** `"false"` is written quoted throughout the repo, so it arrives as a string. */
function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === 'yes') return true
    if (text === 'false' || text === 'no') return false
  }
  return null
}

/**
 * An empty list is written as a bare `-`, which YAML reads as `[null]`.
 * Taken at face value that is one team, not none.
 */
function list(value: unknown): string[] {
  if (!Array.isArray(value)) return str(value) ? [str(value)!] : []
  return value.map(str).filter((entry): entry is string => entry !== null)
}
