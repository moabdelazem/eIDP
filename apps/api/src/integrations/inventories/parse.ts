import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
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
  /**
   * Environment to owning team, from every `<env>_team` key in group_vars/all —
   * stress and preprod included, not only the environments applications use.
   */
  teams: Record<string, string>
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

/** Where the walk is, and what it could not read along the way. */
type Walk = { root: string; warnings: string[] }

export type ParsedInventories = {
  systems: InventorySystem[]
  /**
   * Files that could not be read, relative to the repo root. One bad file
   * among thousands must cost that file, not the whole catalog — so it is
   * skipped and named here instead of failing the sync.
   */
  warnings: string[]
}

export async function parseInventories(root: string): Promise<ParsedInventories> {
  const walk: Walk = { root, warnings: [] }
  const systems: InventorySystem[] = []

  for (const dir of await subdirectories(root)) {
    const groupVars = join(root, dir, 'group_vars')
    const groups = await subdirectories(groupVars)
    if (groups.length === 0) continue // not an inventory directory

    systems.push({
      ...(await readSystemMeta(groupVars, dir, walk)),
      applications: await Promise.all(
        groups
          .filter((group) => group !== 'all')
          .map((group) => readApplication(join(groupVars, group), group, walk)),
      ),
    })
  }

  return {
    systems: systems.sort((a, b) => a.dir.localeCompare(b.dir)),
    warnings: walk.warnings.sort(),
  }
}

async function readSystemMeta(
  groupVars: string,
  dir: string,
  walk: Walk,
): Promise<Omit<InventorySystem, 'applications'>> {
  // Every file in group_vars/all, merged as Ansible merges it: the teams live
  // in team.yml beside project.yml, and reading project.yml alone left every
  // system ownerless — which also left team-scoped access rules matching nothing.
  const project = await readGroupVars(join(groupVars, 'all'), walk)

  const teams: Record<string, string> = {}
  for (const [key, value] of Object.entries(project)) {
    const env = /^(.+)_team$/.exec(key)?.[1]
    if (env && typeof value === 'string' && value.trim()) teams[env] = value.trim()
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

async function readApplication(dir: string, group: string, walk: Walk): Promise<InventoryApplication> {
  const vars = await readGroupVars(dir, walk)
  const { environment, name } = splitEnvironment(group)

  return {
    group,
    name,
    environment,
    repository: str(vars.repository_name),
    buildTechnology: str(vars.build_technology),
    deployTechnology: str(vars.deploy_technology),
    deployPlatform: str(vars.deploy_platform),
    appType: str(vars.app_type),
    microservice: bool(vars.microservice),
    technologies: await technologiesIn(dir),
    descriptor: vars,
  }
}

/**
 * Every variable file in an application's directory, merged the way Ansible
 * merges a group_vars directory: files in sorted filename order, each one's
 * top-level keys replacing the ones before it.
 *
 * An application is not just cicd.yml. Its technology file — dotnet.yml,
 * Spring.yml — carries the images, ports, route, resources and replicas, and
 * reading cicd.yml alone threw all of that away. Following Ansible's order,
 * rather than inventing one, means the portal shows the values a deployment
 * actually gets: dotnet.yml sorts after cicd.yml and overrides it, while
 * Spring.yml sorts before (capitals first) and is overridden by it.
 */
async function readGroupVars(dir: string, walk: Walk): Promise<Record<string, unknown>> {
  const files = (await readdir(dir).catch(() => []))
    .filter((file) => /\.ya?ml$/.test(file) && !file.startsWith('.') && normalize(file) !== 'vaultyml')
    // Ansible sorts by code point, as Python's sorted() does: not localeCompare.
    .sort()

  const merged: Record<string, unknown> = {}
  for (const file of files) Object.assign(merged, await readYaml(join(dir, file), walk))
  return redact(merged)
}

/**
 * Keys whose values are credentials. The portal shows configuration to people
 * who may not have access to the inventories repo, so it must not become a
 * wider window onto secrets someone left in plaintext there.
 */
const SECRET_KEY = /pass(word|wd)?$|passwd|pwd|secret|token|credential|private_?key|api_?key|connection_?string/i

export const REDACTED = '[hidden]'

function redact(value: unknown, key = ''): any {
  if (SECRET_KEY.test(key) && value !== null && typeof value !== 'object') return REDACTED
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && v !== null && typeof v === 'object' ? REDACTED : redact(v, k)]))
  }
  return value
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

/**
 * Ansible's inline encryption: `db_password: !vault | $ANSIBLE_VAULT;...`.
 * Without a handler the ciphertext would be stored and shown as if it were the
 * value, so it is replaced before it ever leaves the parser.
 */
const vaultTag = {
  tag: '!vault',
  resolve: () => REDACTED,
}

/**
 * Parses one variable file the way Ansible would tolerate it, and never
 * throws: a file that still cannot be read is skipped and named in the walk's
 * warnings. Duplicate keys keep the last value, as PyYAML does — a repo that
 * works under Ansible can contain them without anyone having noticed.
 */
async function readYaml(path: string, walk: Walk): Promise<Record<string, unknown>> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) return {}
  // A whole-file vault blob is not YAML; never hand it to the parser.
  if (text.startsWith('$ANSIBLE_VAULT')) return {}

  try {
    const value = parseYaml(text, { uniqueKeys: false, customTags: [vaultTag], logLevel: 'error' })
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err)
    walk.warnings.push(`${relative(walk.root, path)}: ${reason}`)
    return {}
  }
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
