import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_LAYOUT,
  moveTo,
  moveToNewColumn,
  normalise,
  PANELS,
  resizeColumns,
  resizeRows,
  toggle,
  visible
} from '../src/renderer/src/layout.ts'

const cols = (l: { columns: string[][] }): string => l.columns.map((c) => c.join('+')).join('|')

test('the default is the arrangement asked for, with the floor bottom right', () => {
  assert.equal(cols(DEFAULT_LAYOUT), 'roster|command|editor|tree+shell+floor')
  assert.deepEqual(DEFAULT_LAYOUT.hidden, [])
  const last = visible(DEFAULT_LAYOUT).at(-1)!
  assert.deepEqual(last.panels, ['tree', 'shell', 'floor'])
  assert.equal(last.panels.at(-1), 'floor', 'the office floor sits at the bottom right')
})

test('a panel can be dropped above or below the one it lands on', () => {
  assert.equal(
    cols(moveTo(DEFAULT_LAYOUT, 'floor', 'tree', 'above')),
    'roster|command|editor|floor+tree+shell'
  )
  // Moving into another column empties the one it left, which disappears.
  assert.equal(
    cols(moveTo(DEFAULT_LAYOUT, 'editor', 'tree', 'below')),
    'roster|command|tree+editor+shell+floor'
  )
  assert.deepEqual(moveTo(DEFAULT_LAYOUT, 'tree', 'tree', 'above'), DEFAULT_LAYOUT)
})

test('an emptied column takes its width with it rather than leaving a gap', () => {
  const l = moveTo(DEFAULT_LAYOUT, 'editor', 'tree', 'above')
  assert.equal(l.columns.length, l.colWeight.length)
  assert.equal(l.columns.length, 3)
})

test('a panel can be lifted into a column of its own', () => {
  assert.equal(
    cols(moveToNewColumn(DEFAULT_LAYOUT, 'floor', 0)),
    'floor|roster|command|editor|tree+shell'
  )
  const l = moveToNewColumn(DEFAULT_LAYOUT, 'floor', 4)
  assert.equal(cols(l), 'roster|command|editor|tree+shell|floor')
  assert.equal(l.colWeight.length, 5)
  // A panel already alone where it would land is left exactly as it is.
  assert.deepEqual(moveToNewColumn(DEFAULT_LAYOUT, 'command', 1), DEFAULT_LAYOUT)
})

test('a persisted layout is repaired rather than trusted', () => {
  // Written by a build that had one code panel instead of an editor and a tree.
  const old = normalise({ columns: [['roster'], ['command']] })
  const all = old.columns.flat()
  assert.equal(all.length, PANELS.length)
  assert.equal(new Set(all).size, PANELS.length)
  // Hand-edited nonsense: a duplicate across columns, an unknown id, an empty column.
  const fixed = normalise({ columns: [['floor'], [], ['floor', 'nope'], ['roster']] })
  assert.equal(new Set(fixed.columns.flat()).size, PANELS.length)
  assert.ok(fixed.columns.every((c) => c.length > 0))
  assert.equal(fixed.columns.length, fixed.colWeight.length)
  assert.deepEqual(normalise(undefined), DEFAULT_LAYOUT)
})

test('a size that would collapse a panel past reach is refused', () => {
  // A width that would collapse the column falls back to the default for that
  // position, not to an arbitrary equal share.
  assert.equal(normalise({ colWeight: [0, -1] }).colWeight[0], DEFAULT_LAYOUT.colWeight[0])
  assert.equal(normalise({ rowWeight: { floor: 0 } }).rowWeight.floor, 1)
  assert.equal(normalise({ rowWeight: { floor: 3 } }).rowWeight.floor, 3)
  const far = resizeColumns(DEFAULT_LAYOUT, 1, 99)
  assert.ok(far.colWeight[2] > 0)
  const rows = resizeRows(DEFAULT_LAYOUT, 'tree', 'floor', -99)
  assert.ok(rows.rowWeight.tree > 0)
})

test('dragging a divider keeps the pair total, so the rest of the row holds still', () => {
  const before = DEFAULT_LAYOUT.colWeight[1] + DEFAULT_LAYOUT.colWeight[2]
  const l = resizeColumns(DEFAULT_LAYOUT, 1, 0.1)
  assert.ok(l.colWeight[1] > DEFAULT_LAYOUT.colWeight[1])
  assert.equal(Math.round((l.colWeight[1] + l.colWeight[2]) * 1000), Math.round(before * 1000))
  assert.equal(l.colWeight[3], DEFAULT_LAYOUT.colWeight[3])
})

test('hiding every panel is refused - it would leave no way back', () => {
  assert.deepEqual(normalise({ hidden: [...PANELS] }).hidden, [])
  assert.deepEqual(normalise({ hidden: ['floor', 'nope'] }).hidden, ['floor'])
})

test('an absent hidden list takes the default; an empty one is a choice', () => {
  // Showing every panel and hiding none are different states, and reading the
  // second as the first would put the shell back every time it was dismissed.
  assert.deepEqual(normalise({}).hidden, DEFAULT_LAYOUT.hidden)
  assert.deepEqual(normalise({ hidden: [] }).hidden, [])
})

test('hiding a panel drops its column but not its place in the layout', () => {
  const off = toggle(DEFAULT_LAYOUT, 'editor')
  assert.equal(visible(off).length, 3)
  assert.equal(cols(off), cols(DEFAULT_LAYOUT))
  assert.deepEqual(toggle(off, 'editor').hidden, [])
  // Hiding one of a stack leaves the column, holding the rest.
  assert.deepEqual(visible(toggle(DEFAULT_LAYOUT, 'floor')).at(-1)?.panels, ['tree', 'shell'])
})
