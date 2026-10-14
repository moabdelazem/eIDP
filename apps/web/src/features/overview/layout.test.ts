// How someone's saved arrangement of the Overview meets the cards they may see.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { arrange, greeting, move } from './layout.ts'

const cards = ['needs-you', 'approvals', 'jenkins', 'pipelines', 'requests', 'projects', 'catalog']
const hiddenByDefault = new Set(['catalog'])

test('until someone saves, the default order, with the default-hidden ones hidden', () => {
  assert.deepEqual(arrange(cards, hiddenByDefault, null), { shown: cards.slice(0, 6), hidden: ['catalog'] })
})

test('a saved order and choice of hidden cards is kept as saved', () => {
  const saved = { order: ['pipelines', 'needs-you', 'requests', 'catalog', 'approvals', 'jenkins', 'projects'], hidden: ['jenkins'] }
  assert.deepEqual(arrange(cards, hiddenByDefault, saved), {
    shown: ['pipelines', 'needs-you', 'requests', 'catalog', 'approvals', 'projects'],
    hidden: ['jenkins'],
  })
})

test('a card new since saving goes after the one it follows by default; a card no longer theirs is dropped', () => {
  // Saved before "projects" existed, while they still had Jenkins.
  const saved = { order: ['requests', 'needs-you', 'pipelines', 'jenkins'], hidden: [] }
  const available = ['needs-you', 'pipelines', 'requests', 'projects', 'catalog']
  assert.deepEqual(arrange(available, hiddenByDefault, saved), {
    shown: ['requests', 'projects', 'needs-you', 'pipelines'],
    hidden: ['catalog'],
  })
})

test('a default-hidden card someone chose to show stays shown', () => {
  const saved = { order: ['catalog', 'needs-you'], hidden: [] }
  assert.deepEqual(arrange(['needs-you', 'catalog'], hiddenByDefault, saved), { shown: ['catalog', 'needs-you'], hidden: [] })
})

test('moving stops at the ends; the greeting follows the hour', () => {
  assert.deepEqual(move(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c'])
  assert.deepEqual(move(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c'])
  assert.deepEqual(move(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c'])
  assert.deepEqual([3, 9, 14, 20].map(greeting), ['Good evening', 'Good morning', 'Good afternoon', 'Good evening'])
})
