// The projects map's model: what the filters keep, how the tree is grouped, and how a chosen card is found again.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Application, System } from './catalog.ts'
import { appId, buildTree, BUCKET_THRESHOLD, emptyFilters, filterSystems, inOrder, pathTo, resolve, systemId } from './tree.ts'

const app = (name: string, more: Partial<Application> = {}): Application => ({
  id: name,
  name,
  repository: name,
  buildTechnology: 'DotNetCore',
  deployPlatform: null,
  microservice: null,
  environments: ['dev'],
  ...more,
})
const system = (id: string, apps: Application[]): System => ({ id, projectName: id, company: 'eFinance', teams: {}, applications: apps })

const catalog = [
  system('Payments', [app('api'), app('web', { buildTechnology: 'Flutter', environments: ['dev', 'prd'] })]),
  system('Loans', [app('api'), app('scoring', { repository: 'loan-scoring' })]),
]

test('two systems may each have an "api": their cards and links stay apart', () => {
  const ids = buildTree(catalog, 'eFinance', emptyFilters).children!.flatMap((s) => s.children!.map((a) => a.id))
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(resolve(catalog, appId(catalog[1]!, catalog[1]!.applications[0]!))?.system.id, 'Loans')
})

test('a system found by name brings all its applications; one found through an application brings only the matches', () => {
  const byName = filterSystems(catalog, { ...emptyFilters, query: 'loans' })
  assert.deepEqual(byName.map((k) => [k.system.id, k.apps.length]), [['Loans', 2]])
  const byRepo = filterSystems(catalog, { ...emptyFilters, query: 'loan-scoring' })
  assert.deepEqual(byRepo.map((k) => [k.system.id, k.apps.map((a) => a.name)]), [['Loans', ['scoring']]])
})

test('technology and environment filters keep only what has them', () => {
  const kept = filterSystems(catalog, { ...emptyFilters, technologies: ['Flutter'], environments: ['prd'] })
  assert.deepEqual(kept.map((k) => [k.system.id, k.apps.map((a) => a.name)]), [['Payments', ['web']]])
})

test('above the threshold systems are grouped by initial, unless filtered', () => {
  const many = Array.from({ length: BUCKET_THRESHOLD + 1 }, (_, i) => system(`${String.fromCharCode(65 + (i % 26))}sys${i}`, [app(`a${i}`)]))
  assert.ok(buildTree(many, 'x', emptyFilters).children!.every((c) => c.kind === 'bucket'))
  assert.ok(buildTree(many, 'x', { ...emptyFilters, query: 'sys' }).children!.every((c) => c.kind === 'system'))
})

test('the path to a chosen application runs through its system, so it can be opened', () => {
  const root = buildTree(catalog, 'eFinance', emptyFilters)
  const target = appId(catalog[0]!, catalog[0]!.applications[1]!)
  assert.deepEqual(pathTo(root, target), ['root', systemId(catalog[0]!), target])
  assert.equal(resolve(catalog, 'app:Nowhere/nothing'), null)
})

test('environments read in pipeline order; one this build does not know goes last', () => {
  assert.deepEqual(inOrder(['prd', 'stress', 'dev', 'prd_dr', 'qc']), ['dev', 'qc', 'prd_dr', 'prd', 'stress'])
})
