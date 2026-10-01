import { ApiError } from '../../lib/errors.ts'
import { jenkinsGet, jenkinsText, jobPath } from './client.ts'

/**
 * Who Jenkins itself lets see each job — read from whichever authorization
 * Jenkins runs, so the portal shows a team the pipelines Jenkins already
 * shows it, and no others.
 *
 * Two strategies are understood:
 *
 *  - **Role-based** (the role-strategy plugin): project roles, each a regex
 *    over full job names and a list of users and groups. Its REST endpoints
 *    answer in one call per role, and need the service account to administer
 *    roles. Global roles are left out: a global grant says nothing about
 *    which pipelines are whose.
 *  - **Matrix** (project-based matrix authorization): grants live in each
 *    folder's and job's `config.xml` and flow down the folders unless an item
 *    stops inheriting. One call per item, and the service account needs
 *    Job/ExtendedRead to read configuration.
 *
 * Only `Job/Read` (`hudson.model.Item.Read`) is taken — this decides seeing.
 * A grant to `authenticated` or `anonymous` is kept as the group `authenticated`:
 * it names no team, but it does let everyone read the job, which is how a
 * shared build or deploy job is usually set up.
 */

export type SidType = 'user' | 'group' | 'either'

/** One person or group Jenkins lets read one job, and what grants it. */
export type JobGrant = { job: string; sid: string; sidType: SidType; via: string }

export type AccessRules = {
  source: 'role-strategy' | 'matrix' | 'none'
  grants: JobGrant[]
  /** Roles or items that could not be read or understood, named. */
  warnings: string[]
}

const READ = 'hudson.model.Item.Read'
const EVERYONE = new Set(['authenticated', 'anonymous'])
/** The one name every grant to everyone is stored under. */
export const EVERYONE_SID = 'authenticated'

const everyoneAs = (s: { sid: string; sidType: SidType }) =>
  EVERYONE.has(s.sid.toLowerCase()) ? { sid: EVERYONE_SID, sidType: 'group' as const } : s
/** Config reads at once, so a thousand jobs do not open a thousand connections. */
const PARALLEL = 8

type Item = { fullName: string; parent: string | null; isJob: boolean }
type RawItem = { name: string; fullName?: string; jobs?: RawItem[] }

const ITEM = 'name,fullName'
const ITEMS_TREE = `jobs[${ITEM},jobs[${ITEM},jobs[${ITEM}]]]`

/** Every folder and job, with its parent — the same three levels the sync reads. */
async function listItems(): Promise<Item[]> {
  const { jobs = [] } = await jenkinsGet<{ jobs?: RawItem[] }>('api/json', { tree: ITEMS_TREE })
  const items: Item[] = []
  const walk = (list: RawItem[], parent: string | null) => {
    for (const raw of list) {
      const fullName = raw.fullName ?? (parent ? `${parent}/${raw.name}` : raw.name)
      items.push({ fullName, parent, isJob: !raw.jobs })
      if (raw.jobs) walk(raw.jobs, fullName)
    }
  }
  walk(jobs, null)
  return items
}

/** Reads the rules from whichever strategy this Jenkins runs. */
export async function readAccess(): Promise<AccessRules> {
  const items = await listItems()
  const roles = await readRoleStrategy(items)
  if (roles) return roles
  return readMatrix(items)
}

// ---- role-based -------------------------------------------------------------------

type RawSid = string | { type?: string; sid: string }

/** The roles, or null when the plugin is not installed. */
async function readRoleStrategy(items: Item[]): Promise<AccessRules | null> {
  let all: Record<string, RawSid[]>
  try {
    all = await jenkinsGet<Record<string, RawSid[]>>('role-strategy/strategy/getAllRoles', { type: 'projectRoles' })
  } catch (err) {
    if (err instanceof ApiError && err.code === 'jenkins_not_found') return null
    throw err
  }
  const jobs = items.filter((item) => item.isJob).map((item) => item.fullName)
  const grants: JobGrant[] = []
  const warnings: string[] = []
  for (const [roleName, listed] of Object.entries(all)) {
    const role = await jenkinsGet<{ permissionIds?: Record<string, boolean>; pattern?: string; sids?: RawSid[] }>(
      'role-strategy/strategy/getRole',
      { type: 'projectRoles', roleName },
    ).catch((err: unknown) => {
      warnings.push(`Role ${roleName} could not be read: ${err instanceof Error ? err.message : String(err)}`)
      return null
    })
    if (!role?.permissionIds?.[READ] || role.pattern === undefined) continue
    let pattern: RegExp
    try {
      // Jenkins matches the whole name, case-sensitively.
      pattern = new RegExp(`^(?:${role.pattern})$`)
    } catch {
      warnings.push(`Role ${roleName}'s pattern ${role.pattern} is not a pattern the portal can read.`)
      continue
    }
    const sids = (role.sids ?? listed).map(toSid).map(everyoneAs)
    for (const job of jobs.filter((name) => pattern.test(name))) {
      for (const { sid, sidType } of sids) grants.push({ job, sid, sidType, via: `role ${roleName}` })
    }
  }
  return { source: 'role-strategy', grants, warnings }
}

function toSid(raw: RawSid): { sid: string; sidType: SidType } {
  if (typeof raw === 'string') return { sid: raw, sidType: 'either' }
  const type = raw.type?.toUpperCase()
  return { sid: raw.sid, sidType: type === 'USER' ? 'user' : type === 'GROUP' ? 'group' : 'either' }
}

// ---- matrix -----------------------------------------------------------------------

/** What one item's `config.xml` grants, and whether it takes its folder's grants too. */
export type ItemMatrix = { inherits: boolean; read: { sid: string; sidType: SidType }[] } | null

async function readMatrix(items: Item[]): Promise<AccessRules> {
  const own = new Map<string, ItemMatrix>()
  let refused = 0
  let failed = 0
  for (let i = 0; i < items.length; i += PARALLEL) {
    await Promise.all(
      items.slice(i, i + PARALLEL).map(async (item) => {
        try {
          own.set(item.fullName, parseMatrix(await jenkinsText(`${jobPath(item.fullName)}/config.xml`)))
        } catch (err) {
          if (err instanceof ApiError && err.code === 'jenkins_forbidden') refused++
          else failed++
        }
      }),
    )
  }

  const warnings: string[] = []
  if (refused > 0) warnings.push(`The service account may not read the configuration of ${refused} item(s) — it needs Job/ExtendedRead.`)
  if (failed > 0) warnings.push(`The configuration of ${failed} item(s) could not be read.`)
  if (![...own.values()].some(Boolean)) return { source: 'none', grants: [], warnings }

  const byName = new Map(items.map((item) => [item.fullName, item]))
  const grants: JobGrant[] = []
  for (const job of items.filter((item) => item.isJob)) {
    // The chain from the top folder down to the job; an item that stops
    // inheriting drops everything granted above it.
    const chain: Item[] = []
    for (let at: Item | undefined = job; at; at = at.parent ? byName.get(at.parent) : undefined) chain.unshift(at)
    let effective: JobGrant[] = []
    for (const item of chain) {
      const matrix = own.get(item.fullName)
      if (!matrix) continue
      const here = matrix.read.map(({ sid, sidType }) => ({
        job: job.fullName,
        sid,
        sidType,
        via: item.fullName === job.fullName ? 'the job' : `folder ${item.fullName}`,
      }))
      effective = matrix.inherits ? [...effective, ...here] : here
    }
    grants.push(...effective)
  }
  return { source: 'matrix', grants, warnings }
}

/**
 * The Job/Read grants in one item's `config.xml`. Three spellings exist across
 * matrix-auth versions, and Jenkins keeps writing whichever it loaded:
 *
 *   <permission>hudson.model.Item.Read:Payments</permission>          user or group
 *   <permission>GROUP:hudson.model.Item.Read:Payments</permission>    3.x
 *   <entry><group><name>Payments</name><permission>hudson.model.Item.Read</permission></group></entry>
 */
export function parseMatrix(xml: string): ItemMatrix {
  const block = /<([\w.$-]*AuthorizationMatrixProperty)\b[^>]*>([\s\S]*?)<\/\1>/.exec(xml)?.[2]
  if (block === undefined) return null
  const strategy = /<inheritanceStrategy\s+class="([^"]+)"/.exec(block)?.[1] ?? ''
  const inherits = !/NonInheritingStrategy|InheritGlobalStrategy/.test(strategy)

  const read: { sid: string; sidType: SidType }[] = []
  const add = (sid: string, sidType: SidType) => {
    if (!sid.trim()) return
    const entry = everyoneAs({ sid: decode(sid.trim()), sidType })
    if (!read.some((r) => r.sid === entry.sid && r.sidType === entry.sidType)) read.push(entry)
  }
  // Entries first, and taken out, so their bare <permission> is not read twice.
  const rest = block.replace(/<entry>([\s\S]*?)<\/entry>/g, (_, entry: string) => {
    const type = /<(user|group|userOrGroup)>/.exec(entry)?.[1]
    const name = /<name>([^<]*)<\/name>/.exec(entry)?.[1] ?? /<sid>([^<]*)<\/sid>/.exec(entry)?.[1]
    const permissions = [...entry.matchAll(/<permission>([^<]*)<\/permission>/g)].map((m) => m[1]!.trim())
    if (name && permissions.includes(READ)) add(name, type === 'user' ? 'user' : type === 'group' ? 'group' : 'either')
    return ''
  })
  for (const [, text] of rest.matchAll(/<permission>([^<]*)<\/permission>/g)) {
    const m = /^(?:(USER|GROUP):)?([\w.$]+):(.+)$/.exec(text!.trim())
    if (m && m[2] === READ) add(m[3]!, m[1] === 'USER' ? 'user' : m[1] === 'GROUP' ? 'group' : 'either')
  }
  return { inherits, read }
}

function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (entity, name: string) =>
    name === 'amp' ? '&' : name === 'lt' ? '<' : name === 'gt' ? '>' : name === 'quot' ? '"' : name === 'apos' ? "'" : String.fromCharCode(Number(name.slice(1))),
  )
}
