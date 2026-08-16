import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bandOf,
  DEFAULT_LAYOUT,
  MAX_BOTTOM,
  MIN_BOTTOM,
  move,
  moveToBand,
  normalise,
  PANELS,
  resize,
  setBottomPct,
  toggle,
  visible
} from '../src/renderer/src/layout.ts'

test('a dragged panel lands where the panel it was dropped on sat', () => {
  const l = move(DEFAULT_LAYOUT, 'floor', 'code')
  assert.deepEqual(l.bottom, ['floor', 'code'])
  // Dropping a panel on itself is a click, not a move.
  assert.deepEqual(move(DEFAULT_LAYOUT, 'code', 'code'), DEFAULT_LAYOUT)
})

test('dropping onto the other band is what moves a panel between them', () => {
  const l = move(DEFAULT_LAYOUT, 'floor', 'command')
  assert.equal(bandOf(l, 'floor'), 'top')
  assert.deepEqual(l.top, ['roster', 'floor', 'command'])
  assert.deepEqual(l.bottom, ['code'])
  // And a band emptied that way can still be reached.
  const empty = moveToBand(l, 'code', 'top')
  assert.deepEqual(empty.bottom, [])
  assert.deepEqual(moveToBand(empty, 'code', 'bottom').bottom, ['code'])
})

test('a persisted layout is repaired rather than trusted', () => {
  // Written by a build that had no code panel.
  const old = normalise({ top: ['roster', 'command'], bottom: ['floor'] })
  assert.equal(bandOf(old, 'code'), 'bottom')
  // Hand-edited nonsense: a duplicate across bands and an unknown id.
  const fixed = normalise({ top: ['floor', 'nope', 'floor'], bottom: ['floor', 'roster'] })
  const all = [...fixed.top, ...fixed.bottom]
  assert.equal(all.length, PANELS.length)
  assert.equal(new Set(all).size, PANELS.length)
  assert.equal(fixed.top[0], 'floor')
  assert.deepEqual(normalise(undefined), DEFAULT_LAYOUT)
})

test('a size that would collapse a panel past reach is refused', () => {
  assert.equal(normalise({ bottomPct: 0 }).bottomPct, MIN_BOTTOM)
  assert.equal(normalise({ bottomPct: 500 }).bottomPct, MAX_BOTTOM)
  assert.equal(normalise({ bottomPct: 'tall' }).bottomPct, DEFAULT_LAYOUT.bottomPct)
  assert.equal(normalise({ weight: { code: 0 } }).weight.code, DEFAULT_LAYOUT.weight.code)
  assert.equal(normalise({ weight: { code: -3 } }).weight.code, DEFAULT_LAYOUT.weight.code)
  assert.equal(normalise({ weight: { code: 2.5 } }).weight.code, 2.5)
  assert.equal(setBottomPct(DEFAULT_LAYOUT, 99).bottomPct, MAX_BOTTOM)
})

test('dragging a divider keeps the pair total, so the rest of the row holds still', () => {
  const before = DEFAULT_LAYOUT.weight.code + DEFAULT_LAYOUT.weight.floor
  const l = resize(DEFAULT_LAYOUT, 'code', 'floor', 0.2)
  assert.ok(l.weight.code > DEFAULT_LAYOUT.weight.code)
  assert.equal(Math.round((l.weight.code + l.weight.floor) * 1000), Math.round(before * 1000))
  // Dragging past the end clamps instead of collapsing the neighbour.
  const far = resize(DEFAULT_LAYOUT, 'code', 'floor', 99)
  assert.ok(far.weight.floor > 0)
})

test('hiding every panel is refused - it would leave no way back', () => {
  assert.deepEqual(normalise({ hidden: [...PANELS] }).hidden, [])
  assert.deepEqual(normalise({ hidden: ['floor', 'nope'] }).hidden, ['floor'])
})

test('toggling is its own inverse and only affects visibility', () => {
  const off = toggle(DEFAULT_LAYOUT, 'code')
  assert.deepEqual(visible(off, 'bottom'), ['floor'])
  assert.deepEqual(off.bottom, DEFAULT_LAYOUT.bottom)
  assert.deepEqual(toggle(off, 'code').hidden, [])
})
