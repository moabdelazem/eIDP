/**
 * A schema change, from the schema files to a migration:
 *
 *   pnpm --filter @eidp/api db:generate add_team_owner
 *
 * drizzle-kit compares the schema files with its last snapshot (drizzle/meta)
 * and writes the SQL for the difference; this moves that SQL into
 * src/lib/migrations as the next NNNN_name.sql, where the API's runner applies
 * it at boot under its lock (lib/db.ts). Read it before committing — it is
 * the change the database will get — and say at its top why it is made.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const name = process.argv[2]
if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) {
  console.error('usage: pnpm db:generate <name_in_snake_case>')
  process.exit(2)
}

const api = new URL('../', import.meta.url).pathname
const kit = join(api, 'drizzle')
const migrations = join(api, 'src/lib/migrations')
const sqlIn = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.sql'))

const before = new Set(sqlIn(kit))
execFileSync(join(api, 'node_modules/.bin/drizzle-kit'), ['generate', '--name', name], { cwd: api, stdio: 'inherit' })
const made = sqlIn(kit).filter((f) => !before.has(f))
if (made.length === 0) process.exit(0) // "No schema changes"

const last = Math.max(0, ...sqlIn(migrations).map((f) => Number(f.slice(0, 4))))
const target = `${String(last + 1).padStart(4, '0')}_${name}.sql`
const sql = readFileSync(join(kit, made[0]!), 'utf8').replaceAll('--> statement-breakpoint\n', '')
writeFileSync(join(migrations, target), `-- ${target.slice(0, 4)} — TODO: why this change is made.\n\n${sql.trimEnd()}\n`)
// The snapshot in drizzle/meta stays: it is what the next change is compared against.
rmSync(join(kit, made[0]!))
console.log(`\nwrote src/lib/migrations/${target}`)
