import { dnOf, groupsOf } from '../integrations/ldap/index.ts'
import { config } from '../lib/config.ts'
import { query } from '../lib/db.ts'
import { ApiError } from '../lib/errors.ts'

/**
 * Who may do what.
 *
 *   permission  one thing the portal can do                  code, beside the feature
 *   role        a named bundle of permissions                code, changes with features
 *   binding     a directory group or one user → a role,      Postgres, managed on the
 *               everywhere or limited to a team or project   admin page, every change audited
 *
 * Group membership is read from the directory, not the session token, so a
 * removal takes effect within `GROUP_CACHE_MS`, not when the token expires.
 * Bindings are read from the database on every check, so a change on the
 * admin page applies at once.
 */

export const PERMISSIONS = {
  'catalog.view': 'See the projects map and application configuration',
  'catalog.sync': 'Rebuild the catalog from inventories, and see the files a sync skipped',
  'requests.create': 'Ask for repositories, projects and access',
  'requests.decide': 'Approve, reject and retry any request, and see every request',
  'requests.decide_access': 'Approve or reject access requests — only within the binding’s scope',
  'rbac.manage': 'Grant and revoke roles, and read the audit log',
  'rbac.view_as': 'See the portal as someone else would, read-only',
  'jenkins.view': 'See Jenkins jobs, recent runs, failures, the queue and agents',
  'jenkins.operate': 'Re-run and stop Jenkins builds, and take them out of the queue',
  'ai.use': 'Ask the portal’s AI (Ollama, on our own machines) to explain what it shows',
} as const

export type Permission = keyof typeof PERMISSIONS

export const ROLES = {
  member: {
    label: 'Member',
    description: 'Everyone who can sign in. Built in; never bound by hand.',
    permissions: ['catalog.view', 'requests.create'],
  },
  'team-lead': {
    label: 'Team lead',
    description: 'Decides access requests for the projects their team owns. Bind it with a scope.',
    permissions: ['requests.decide_access'],
  },
  approver: {
    label: 'Approver',
    description: 'Decides every request and runs catalog syncs, without managing access.',
    permissions: ['requests.decide', 'requests.decide_access', 'catalog.sync'],
  },
  'build-operator': {
    label: 'Build operator',
    description: 'Watches Jenkins, has failed builds explained, and re-runs, stops or dequeues builds. Bind it globally.',
    permissions: ['jenkins.view', 'jenkins.operate', 'ai.use'],
  },
  'devops-admin': {
    label: 'DevOps admin',
    description: 'Everything, including who may do what.',
    permissions: Object.keys(PERMISSIONS) as Permission[],
  },
} satisfies Record<string, { label: string; description: string; permissions: Permission[] }>

export type Role = keyof typeof ROLES
export type ScopeType = 'global' | 'team' | 'project'
export type SubjectType = 'group' | 'user'

export type Binding = {
  id: string
  subjectType: SubjectType
  subject: string
  role: string
  scopeType: ScopeType
  scope: string | null
  reason: string | null
  expiresAt: string | null
  createdBy: string
  createdAt: string
  /** Defined in code, shown for completeness, and cannot be removed. */
  builtIn: boolean
}

/** A permission someone holds, and how far it reaches. */
export type Grant = { permission: Permission; scopeType: ScopeType; scope: string | null; via: string }

export type Access = {
  uid: string
  groups: string[]
  bindings: Binding[]
  grants: Grant[]
}

/** What a scoped check is about: the ADO project, and the teams that own it. */
export type Target = { project: string; teams: string[] }

// ---- evaluation --------------------------------------------------------------

/**
 * How long a person's groups are trusted before the directory is asked again.
 *
 * ponytail: per-process memory. With several API processes each keeps its
 * own; that only delays a removal by the same minute on each.
 */
const GROUP_CACHE_MS = 60_000
const groupCache = new Map<string, { groups: string[]; at: number }>()

async function groupsFor(uid: string): Promise<string[]> {
  const key = uid.toLowerCase()
  const cached = groupCache.get(key)
  if (cached && Date.now() - cached.at < GROUP_CACHE_MS) return cached.groups
  const dn = await dnOf(uid)
  const groups = dn ? await groupsOf(dn) : []
  groupCache.set(key, { groups, at: Date.now() })
  return groups
}

/** The grants that exist without any row: everyone is a member, and the bootstrap group runs everything. */
function builtInBindings(): Binding[] {
  const base = { scopeType: 'global' as const, scope: null, reason: null, expiresAt: null, createdBy: 'system', createdAt: '', builtIn: true }
  return [
    { ...base, id: 'built-in:member', subjectType: 'group', subject: 'Everyone', role: 'member' },
    // From APPROVER_GROUP, so the portal can never be left with nobody able to
    // manage it — the admin page cannot remove what is not a row.
    { ...base, id: 'built-in:admin', subjectType: 'group', subject: config.APPROVER_GROUP, role: 'devops-admin' },
  ]
}

/** Everything `uid` may do, worked out now. */
export async function accessOf(uid: string): Promise<Access> {
  const groups = await groupsFor(uid)
  const lowered = groups.map((g) => g.toLowerCase())
  const { rows } = await query<BindingRow>(
    `select * from rbac_bindings
      where (expires_at is null or expires_at > now())
        and ((subject_type = 'group' and lower(subject) = any($1))
          or (subject_type = 'user' and lower(subject) = lower($2)))`,
    [lowered, uid],
  )
  const bindings = [
    ...builtInBindings().filter((b) => b.role === 'member' || lowered.includes(b.subject.toLowerCase())),
    ...rows.map(toBinding),
  ]
  return { uid, groups, bindings, grants: grantsOf(bindings) }
}

export function grantsOf(bindings: Binding[]): Grant[] {
  return bindings.flatMap((b) => {
    // A role removed from code leaves its rows inert rather than failing checks.
    const role = ROLES[b.role as Role]
    if (!role) return []
    const via = `${b.subjectType === 'user' ? 'user' : 'group'} ${b.subject} → ${role.label}`
    return role.permissions.map((permission) => ({ permission, scopeType: b.scopeType, scope: b.scope, via }))
  })
}

/** Whether `access` holds `permission` everywhere, or — given a target — for that target. */
export function can(access: Access, permission: Permission, target?: Target): boolean {
  return access.grants.some((g) => {
    if (g.permission !== permission) return false
    if (g.scopeType === 'global') return true
    if (!target || !g.scope) return false
    const scope = g.scope.toLowerCase()
    if (g.scopeType === 'project') return target.project.toLowerCase() === scope
    return target.teams.some((team) => team.toLowerCase() === scope)
  })
}

/** Whether `access` holds `permission` anywhere at all — enough to open the page it lives on. */
export function canSomewhere(access: Access, permission: Permission): boolean {
  return access.grants.some((g) => g.permission === permission)
}

/** Refuses with a 403 that names what is missing. */
export function demand(access: Access, permission: Permission, target?: Target): void {
  if (!can(access, permission, target)) {
    throw new ApiError(403, 'forbidden', `You don’t have permission to ${describe(permission)}.`)
  }
}

export function describe(permission: Permission): string {
  const text = PERMISSIONS[permission]
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/**
 * The teams that own an ADO project, from the catalog: every environment's
 * team in the system whose project name matches. A project the catalog does
 * not know has no teams, so only a project-scoped binding can reach it.
 */
export async function teamsOwning(project: string): Promise<string[]> {
  const { rows } = await query<{ teams: Record<string, string> }>(
    'select teams from catalog_systems where lower(project_name) = lower($1)',
    [project],
  )
  return [...new Set(rows.flatMap((row) => Object.values(row.teams ?? {})))]
}

// ---- managing bindings -------------------------------------------------------

export type NewBinding = {
  subjectType: SubjectType
  subject: string
  role: string
  scopeType: ScopeType
  scope?: string | null
  reason?: string | null
  expiresAt?: string | null
}

export async function listBindings(): Promise<Binding[]> {
  const { rows } = await query<BindingRow>('select * from rbac_bindings order by role, subject_type, lower(subject)')
  return [...builtInBindings(), ...rows.map(toBinding)]
}

/**
 * Adds a binding, checked for sense: a real role, a scope when the scope type
 * needs one, and a reason for anything granted to one person — an exception
 * for an individual is exactly what someone asks about a year later.
 */
export async function addBinding(input: NewBinding, actor: string): Promise<Binding> {
  const subject = input.subject.trim()
  const scope = input.scopeType === 'global' ? null : input.scope?.trim() || null
  const reason = input.reason?.trim() || null
  if (!subject) throw new ApiError(400, 'invalid_binding', 'Name the group or person.')
  if (!(input.role in ROLES) || input.role === 'member') {
    throw new ApiError(400, 'invalid_binding', `There is no role called ${input.role} to grant.`)
  }
  if (input.scopeType !== 'global' && !scope) {
    throw new ApiError(400, 'invalid_binding', `Name the ${input.scopeType} this applies to.`)
  }
  if (input.subjectType === 'user' && !reason) {
    throw new ApiError(400, 'invalid_binding', 'Say why this person needs it — grants to one person need a reason.')
  }
  if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) {
    throw new ApiError(400, 'invalid_binding', 'That expiry is not a date.')
  }
  if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) {
    throw new ApiError(400, 'invalid_binding', 'That expiry is already in the past.')
  }
  if (input.subjectType === 'user' && !(await dnOf(subject))) {
    throw new ApiError(400, 'invalid_binding', `The directory has no account called ${subject}.`)
  }

  try {
    const { rows } = await query<BindingRow>(
      `insert into rbac_bindings (subject_type, subject, role, scope_type, scope, reason, expires_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [input.subjectType, subject, input.role, input.scopeType, scope, reason, input.expiresAt || null, actor],
    )
    const binding = toBinding(rows[0]!)
    await audit(actor, 'grant', binding)
    return binding
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new ApiError(409, 'binding_exists', 'That binding already exists.')
    }
    throw err
  }
}

export async function removeBinding(id: string, actor: string): Promise<void> {
  if (id.startsWith('built-in:')) {
    throw new ApiError(400, 'built_in_binding', 'Built-in bindings come from configuration and cannot be removed here.')
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, 'binding_not_found', 'There is no such binding.')
  const { rows } = await query<BindingRow>('delete from rbac_bindings where id = $1 returning *', [id])
  if (!rows[0]) throw new ApiError(404, 'binding_not_found', 'There is no such binding.')
  await audit(actor, 'revoke', toBinding(rows[0]))
}

export type AuditEntry =
  | { id: string; at: string; actor: string; action: 'grant' | 'revoke'; binding: Binding; target: null }
  | { id: string; at: string; actor: string; action: 'assume'; binding: null; target: string }

export async function listAudit(limit = 100): Promise<AuditEntry[]> {
  const { rows } = await query<{ id: string; at: Date; actor: string; action: AuditEntry['action']; binding: Binding | null; target: string | null }>(
    'select * from rbac_audit order by at desc, id desc limit $1',
    [limit],
  )
  return rows.map((r) => ({ id: String(r.id), at: r.at.toISOString(), actor: r.actor, action: r.action, binding: r.binding, target: r.target }) as AuditEntry)
}

async function audit(actor: string, action: 'grant' | 'revoke', binding: Binding): Promise<void> {
  await query('insert into rbac_audit (actor, action, binding) values ($1, $2, $3)', [actor, action, binding])
}

/** Viewing as someone is recorded like a grant: who, whom, when. */
export async function auditAssume(actor: string, target: string): Promise<void> {
  await query(`insert into rbac_audit (actor, action, target) values ($1, 'assume', $2)`, [actor, target])
}

/**
 * Why someone can (or cannot) do each thing — the answer to "why can bob
 * approve?". Includes the groups the directory returned, because a missing
 * group is the usual reason for a missing grant.
 */
export async function explain(uid: string) {
  if (!(await dnOf(uid))) throw new ApiError(404, 'user_not_found', `The directory has no account called ${uid}.`)
  groupCache.delete(uid.toLowerCase()) // an explanation should never be a minute stale
  const access = await accessOf(uid)
  return {
    uid,
    groups: access.groups,
    bindings: access.bindings,
    permissions: (Object.keys(PERMISSIONS) as Permission[]).map((permission) => ({
      permission,
      description: PERMISSIONS[permission],
      grants: access.grants.filter((g) => g.permission === permission),
    })),
  }
}

// ---- rows --------------------------------------------------------------------

type BindingRow = {
  id: string
  subject_type: SubjectType
  subject: string
  role: string
  scope_type: ScopeType
  scope: string | null
  reason: string | null
  expires_at: Date | null
  created_by: string
  created_at: Date
}

function toBinding(row: BindingRow): Binding {
  return {
    id: row.id,
    subjectType: row.subject_type,
    subject: row.subject,
    role: row.role,
    scopeType: row.scope_type,
    scope: row.scope,
    reason: row.reason,
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    builtIn: false,
  }
}
