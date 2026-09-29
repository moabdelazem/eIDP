/**
 * Brings the previous portal's access map across — reviewed, not copied.
 *
 *   pnpm --filter @eidp/api rbac:import path/to/rbac.py            # show the plan
 *   pnpm --filter @eidp/api rbac:import path/to/rbac.py --apply    # add the bindings
 *
 * Reads `VALID_GROUPS` and `VALID_USERS` from the old Python file (or the same
 * two maps as JSON). Only what e-IDP can act on is imported; everything else
 * is listed with the reason it was left out, so nothing disappears silently.
 */
import { readFile } from 'node:fs/promises'
import type { NewBinding } from './rbac.ts'

export type OldMap = { groups: Record<string, string[]>; users: Record<string, string[]> }
export type Plan = { add: NewBinding[]; skip: { subject: string; role: string; why: string }[] }

/**
 * Team names the old portal rewrote in code before using them. Carried over
 * as data here, so the binding names the team the catalog actually uses.
 */
const TEAM_ALIASES: Record<string, string> = { 'Business-Integ': 'Business-Integration' }

const REASON = 'Imported from the previous portal'

export function planImport(old: OldMap, approverGroup: string): Plan {
  const plan: Plan = { add: [], skip: [] }

  for (const [group, roles] of Object.entries(old.groups)) {
    for (const role of roles) {
      if (role === 'admin') {
        if (group.toLowerCase() === approverGroup.toLowerCase()) {
          plan.skip.push({ subject: group, role, why: 'already built in: APPROVER_GROUP runs everything' })
        } else {
          plan.add.push({ subjectType: 'group', subject: group, role: 'devops-admin', scopeType: 'global', reason: REASON })
        }
      } else if (role === 'login') {
        plan.skip.push({ subject: group, role, why: 'everyone in the directory can sign in to e-IDP' })
      } else {
        plan.skip.push({ subject: group, role, why: `no e-IDP feature needs "${role}" yet` })
      }
    }
  }

  for (const [user, roles] of Object.entries(old.users)) {
    for (const role of roles) {
      const lead = /^(.+)-Lead$/.exec(role)
      if (lead) {
        // "DEVJAVA-Lead" meant "leads DEVJAVA": a scoped binding, not a string to parse.
        const team = TEAM_ALIASES[lead[1]!] ?? lead[1]!
        plan.add.push({
          subjectType: 'user',
          subject: user,
          role: 'team-lead',
          scopeType: 'team',
          scope: team,
          reason: `${REASON} (${role})`,
        })
      } else {
        plan.skip.push({ subject: user, role, why: `no e-IDP feature needs "${role}" yet` })
      }
    }
  }
  return plan
}

/** The two maps out of the old Python module, or a JSON file holding them. */
export function parseOldMap(text: string): OldMap {
  if (text.trimStart().startsWith('{')) return JSON.parse(text) as OldMap
  const block = (name: string) => {
    const match = new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(text)
    if (!match) throw new Error(`${name} was not found in the file.`)
    const entries: Record<string, string[]> = {}
    for (const [, key, list] of match[1]!.matchAll(/"([^"]+)"\s*:\s*\[([^\]]*)\]/g)) {
      entries[key!] = [...list!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
    }
    return entries
  }
  return { groups: block('VALID_GROUPS'), users: block('VALID_USERS') }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, flag] = process.argv.slice(2)
  if (!file) {
    console.error('usage: rbac:import <rbac.py | map.json> [--apply]')
    process.exit(2)
  }
  const { config } = await import('../lib/config.ts')
  const plan = planImport(parseOldMap(await readFile(file, 'utf8')), config.APPROVER_GROUP)

  console.log(`\nTo add (${plan.add.length}):`)
  for (const b of plan.add) {
    console.log(`  ${b.subjectType} ${b.subject} → ${b.role}${b.scope ? ` (${b.scopeType} ${b.scope})` : ''}`)
  }
  console.log(`\nLeft out (${plan.skip.length}):`)
  for (const s of plan.skip) console.log(`  ${s.subject}: ${s.role} — ${s.why}`)

  if (flag !== '--apply') {
    console.log('\nNothing written. Run again with --apply to add these bindings.')
    process.exit(0)
  }

  const { ensureSchema, closeDb } = await import('../lib/db.ts')
  const { addBinding } = await import('./rbac.ts')
  await ensureSchema()
  let added = 0
  for (const binding of plan.add) {
    try {
      await addBinding(binding, 'import')
      added++
    } catch (err) {
      // A person who has left, or a binding added earlier: report it, keep going.
      console.warn(`  not added: ${binding.subject} → ${binding.role}: ${(err as Error).message}`)
    }
  }
  console.log(`\nAdded ${added} of ${plan.add.length}. Review them on the Access page.`)
  await closeDb()
}
