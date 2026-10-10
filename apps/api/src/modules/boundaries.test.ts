// The modular monolith's rules, checked on every test run rather than in
// review. No database needed: it reads the source.
//
//   - A module is reached through its `index.ts` alone; what a module keeps
//     out of its index is its own to change.
//   - Only app.ts mounts a module's routes (`routes.ts`, `*-routes.ts`).
//   - `lib/` and `integrations/` know no module: they are what modules are
//     built on (tests aside — a test may check an integration against a
//     module's rules). `middleware/` may: auth asks the access module.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (entry.name.endsWith('.ts')) yield path
  }
}

const SPEC = /(?:import|export)\s[^'";]*?\sfrom\s+'(\.{1,2}\/[^']+)'|import\(\s*'(\.{1,2}\/[^']+)'/g
const moduleOf = (rel: string) => /^modules\/([^/]+)\//.exec(rel)?.[1] ?? null
const isRoutes = (rel: string) => /\/(?:[\w-]+-)?routes\.ts$/.test(rel)

const imports = [...files(src)].flatMap((path) => {
  const from = relative(src, path)
  return [...readFileSync(path, 'utf8').matchAll(SPEC)].map((m) => ({ from, to: relative(src, resolve(dirname(path), m[1] ?? m[2]!)) }))
})

test('a module is reached only through its index', () => {
  const broken = imports.filter(({ from, to }) => {
    const target = moduleOf(to)
    if (!target || moduleOf(from) === target) return false
    if (to === `modules/${target}/index.ts`) return false
    return !(from === 'app.ts' && isRoutes(to))
  })
  assert.deepEqual(broken.map(({ from, to }) => `${from} → ${to}`), [])
})

test('only app.ts mounts routes', () => {
  const broken = imports.filter(({ from, to }) => moduleOf(to) && isRoutes(to) && from !== 'app.ts' && moduleOf(from) !== moduleOf(to))
  assert.deepEqual(broken.map(({ from, to }) => `${from} → ${to}`), [])
})

test('lib and integrations know no module', () => {
  const broken = imports.filter(({ from, to }) => /^(lib|integrations)\//.test(from) && !from.endsWith('.test.ts') && moduleOf(to))
  assert.deepEqual(broken.map(({ from, to }) => `${from} → ${to}`), [])
})

test('every module has an index', () => {
  const modules = readdirSync(join(src, 'modules'), { withFileTypes: true }).filter((e) => e.isDirectory())
  const missing = modules.filter((m) => !readdirSync(join(src, 'modules', m.name)).includes('index.ts'))
  assert.deepEqual(missing.map((m) => m.name), [])
})
