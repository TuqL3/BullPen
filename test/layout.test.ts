import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_LAYOUT,
  type Layout,
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
  assert.equal(cols(DEFAULT_LAYOUT), 'roster|command|tree+floor')
  assert.deepEqual(DEFAULT_LAYOUT.hidden, [])
  const last = visible(DEFAULT_LAYOUT).at(-1)!
  assert.deepEqual(last.panels, ['tree', 'floor'])
  assert.equal(last.panels.at(-1), 'floor', 'the office floor sits at the bottom right')
})

test('a panel can be dropped above or below the one it lands on', () => {
  assert.equal(
    cols(moveTo(DEFAULT_LAYOUT, 'floor', 'tree', 'above')),
    'roster|command|floor+tree'
  )
  // Moving into another column empties the one it left, which disappears.
  assert.equal(
    cols(moveTo(DEFAULT_LAYOUT, 'floor', 'roster', 'below')),
    'roster+floor|command|tree'
  )
  assert.deepEqual(moveTo(DEFAULT_LAYOUT, 'tree', 'tree', 'above'), DEFAULT_LAYOUT)
})

test('an emptied column takes its width with it rather than leaving a gap', () => {
  const l = moveTo(DEFAULT_LAYOUT, 'roster', 'tree', 'above')
  assert.equal(l.columns.length, l.colWeight.length)
  assert.equal(l.columns.length, 2, 'the column the roster left is gone, not blank')
})

test('a panel can be lifted into a column of its own', () => {
  assert.equal(
    cols(moveToNewColumn(DEFAULT_LAYOUT, 'floor', 0)),
    'floor|roster|command|tree'
  )
  const l = moveToNewColumn(DEFAULT_LAYOUT, 'floor', 4)
  assert.equal(cols(l), 'roster|command|tree|floor')
  assert.equal(l.colWeight.length, 4)
  // A panel already alone where it would land is left exactly as it is.
  assert.deepEqual(moveToNewColumn(DEFAULT_LAYOUT, 'command', 1), DEFAULT_LAYOUT)
})

test('a persisted layout is repaired rather than trusted', () => {
  // Written by a build that had panels this one no longer has.
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
  const far = resizeColumns(DEFAULT_LAYOUT, 1, 2, 99)
  assert.ok(far.colWeight[2] > 0)
  const rows = resizeRows(DEFAULT_LAYOUT, 'tree', 'floor', -99)
  assert.ok(rows.rowWeight.tree > 0)
})

test('dragging a divider keeps the pair total, so the rest of the row holds still', () => {
  const before = DEFAULT_LAYOUT.colWeight[1] + DEFAULT_LAYOUT.colWeight[2]
  const l = resizeColumns(DEFAULT_LAYOUT, 1, 2, 0.1)
  assert.ok(l.colWeight[1] > DEFAULT_LAYOUT.colWeight[1])
  assert.equal(Math.round((l.colWeight[1] + l.colWeight[2]) * 1000), Math.round(before * 1000))
  assert.equal(l.colWeight[3], DEFAULT_LAYOUT.colWeight[3])
})

test('a divider resizes the columns either side of it, hidden ones skipped', () => {
  // With a column hidden, the two columns a divider sits between are no longer
  // neighbours in storage. Taking the pair as `left` and `left + 1` resized a
  // column nobody was dragging - and left the dragged one untouched.
  const off = toggle(DEFAULT_LAYOUT, 'command')
  const shown = visible(off)
  assert.deepEqual(shown.map((c) => c.index), [0, 2], 'column 1 is hidden, not renumbered')

  const l = resizeColumns(off, shown[0].index, shown[1].index, 0.1)
  assert.ok(l.colWeight[0] > off.colWeight[0], 'the column left of the divider grew')
  assert.ok(l.colWeight[2] < off.colWeight[2], 'the one right of it gave up the room')
  assert.equal(l.colWeight[1], off.colWeight[1], 'the hidden column was not touched')
})

test('the command centre is never hidden - nothing in the bar brings it back', () => {
  // Its switch was taken out of the title bar: it is what the window is for.
  // A stored config that hides it - or one that hides everything - opens on a
  // window with the command centre still up.
  assert.deepEqual(normalise({ hidden: [...PANELS] }).hidden, ['roster', 'tree', 'floor'])
  assert.deepEqual(normalise({ hidden: ['command'] }).hidden, [])
  assert.deepEqual(normalise({ hidden: ['floor', 'nope'] }).hidden, ['floor'])
})

test('an absent hidden list takes the default; an empty one is a choice', () => {
  // Showing every panel and hiding none are different states, and reading the
  // second as the first would put the shell back every time it was dismissed.
  assert.deepEqual(normalise({}).hidden, DEFAULT_LAYOUT.hidden)
  assert.deepEqual(normalise({ hidden: [] }).hidden, [])
})

test('hiding a panel drops its column but not its place in the layout', () => {
  const off = toggle(DEFAULT_LAYOUT, 'command')
  assert.equal(visible(off).length, 2)
  assert.equal(cols(off), cols(DEFAULT_LAYOUT))
  assert.deepEqual(toggle(off, 'command').hidden, [])
  // Hiding one of a stack leaves the column, holding the rest.
  assert.deepEqual(visible(toggle(DEFAULT_LAYOUT, 'floor')).at(-1)?.panels, ['tree'])
})

test('the visible columns always grow by at least one between them', () => {
  // `weight` is a `flex-grow` factor and flexbox reads a total below one
  // literally: items summing to 0.89 absorb 89% of the free space and leave the
  // rest of the row empty. Dragging dividers leaves whatever ratios it leaves -
  // this config is one that shipped - so hiding two columns left the third
  // growing by 0.89 and a 208px dead strip down the right of the window.
  const dragged: Layout = {
    ...DEFAULT_LAYOUT,
    hidden: ['roster', 'tree', 'floor'],
    colWeight: [0.16883142469278725, 0.8908460827304588, 0.2805211244522837]
  }
  const one = visible(dragged)
  assert.deepEqual(one.map((c) => c.panels), [['command']])
  assert.equal(one[0].weight, 1, 'the only column on screen takes the whole row')

  // Two columns keep their ratio to each other, and still sum to their count.
  const two = visible({ ...dragged, hidden: ['tree', 'floor'] })
  const sum = two.reduce((n, c) => n + c.weight, 0)
  assert.ok(Math.abs(sum - two.length) < 1e-9, `weights must sum to ${two.length}, got ${sum}`)
  const before = 0.16883142469278725 / 0.8908460827304588
  assert.ok(Math.abs(two[0].weight / two[1].weight - before) < 1e-9, 'the ratio is unchanged')

  // And every stored layout, whatever it holds, grows by at least one.
  for (const hidden of [[], ['roster'], ['tree'], ['roster', 'floor'], ['roster', 'tree', 'floor']]) {
    const shown = visible({ ...dragged, hidden: hidden as typeof dragged.hidden })
    const grow = shown.reduce((n, c) => n + c.weight, 0)
    assert.ok(grow >= 1 - 1e-9, `hidden=${hidden.join()} grows by ${grow}`)
  }
})
