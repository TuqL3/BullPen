import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EMPTY,
  addColumn,
  moveTo,
  moveToNewColumn,
  remove,
  resizeColumns,
  resizeRows,
  type Grid
} from '../src/renderer/src/split.ts'

const cols = (g: Grid): string => g.columns.map((c) => c.join('+')).join('|')

const three = (): Grid => addColumn(addColumn(addColumn(EMPTY, 'a'), 'b'), 'c')

test('a new cell opens beside the others, with a weight of its own', () => {
  const g = three()
  assert.equal(cols(g), 'a|b|c')
  assert.equal(g.colWeight.length, 3)
  assert.deepEqual(g.rowWeight, { a: 1, b: 1, c: 1 })
  assert.deepEqual(addColumn(g, 'a'), g, 'adding one that is already there changes nothing')
})

test('a cell can be stacked above or below another', () => {
  assert.equal(cols(moveTo(three(), 'c', 'a', 'above')), 'c+a|b')
  assert.equal(cols(moveTo(three(), 'c', 'a', 'below')), 'a+c|b')
  assert.deepEqual(moveTo(three(), 'a', 'a', 'above'), three(), 'onto itself is a no-op')
})

test('an emptied column takes its width with it rather than leaving a gap', () => {
  const g = moveTo(three(), 'c', 'a', 'below')
  assert.equal(g.columns.length, 2)
  assert.equal(g.colWeight.length, 2)
})

test('a stacked cell can be lifted back into a column of its own', () => {
  const stacked = moveTo(three(), 'c', 'a', 'below') // a+c | b
  assert.equal(cols(moveToNewColumn(stacked, 'c', 0)), 'c|a|b')
  assert.equal(cols(moveToNewColumn(stacked, 'c', 2)), 'a|b|c')
  // Already alone where it would land: left exactly as it is, weights included.
  assert.deepEqual(moveToNewColumn(three(), 'b', 1), three())
})

test('closing a cell drops it, and the column with it when it was the last one', () => {
  const g = remove(three(), 'b')
  assert.equal(cols(g), 'a|c')
  assert.equal(g.colWeight.length, 2)
  assert.equal('b' in g.rowWeight, false, 'a closed cell must not leave its height behind')
  assert.equal(cols(remove(moveTo(three(), 'c', 'a', 'below'), 'a')), 'c|b')
})

test('dragging a divider keeps the pair total, so the rest holds still', () => {
  const g = three()
  const l = resizeColumns(g, 0, 1, 0.1)
  assert.ok(l.colWeight[0] > g.colWeight[0])
  assert.equal(l.colWeight[0] + l.colWeight[1], g.colWeight[0] + g.colWeight[1])
  assert.equal(l.colWeight[2], g.colWeight[2], 'the column nobody dragged is untouched')

  // Non-adjacent indices are honoured: with a cell hidden between them the two
  // columns either side of a divider are not neighbours in storage.
  const far = resizeColumns(g, 0, 2, 0.1)
  assert.equal(far.colWeight[1], g.colWeight[1])
})

test('a cell cannot be dragged down to nothing', () => {
  const stacked = moveTo(three(), 'c', 'a', 'below')
  const squashed = resizeRows(stacked, 'a', 'c', -99)
  assert.ok(squashed.rowWeight.a > 0, 'still has a grip to drag back')
  assert.equal(squashed.rowWeight.a + squashed.rowWeight.c, 2)
  const far = resizeColumns(three(), 0, 1, 99)
  assert.ok(far.colWeight[1] > 0)
})
