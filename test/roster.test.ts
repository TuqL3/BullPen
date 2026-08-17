import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FACE_SIZE, faceFor, PRESETS, slug } from '../src/renderer/src/roster.ts'

const CAST = ['michael', 'dwight', 'jim', 'pam', 'stanley', 'kevin', 'angela', 'oscar', 'toby']

test('a face is stable for the same id', () => {
  const a = faceFor('michael')
  const b = faceFor('michael')
  assert.deepEqual(a, b, 'an agent must keep its face across restarts')
})

test('every template is a well-formed 12x12 grid', () => {
  for (const id of CAST) {
    const { grid } = faceFor(id)
    assert.equal(grid.length, FACE_SIZE, `${id}: wrong row count`)
    for (const row of grid) assert.equal(row.length, FACE_SIZE, `${id}: row "${row}" is not ${FACE_SIZE} wide`)
  }
})

test('every non-transparent cell has a colour', () => {
  for (const id of CAST) {
    const { grid, colors } = faceFor(id)
    for (const row of grid) {
      for (const ch of row) {
        if (ch === '.') continue
        assert.ok(colors[ch], `${id}: no colour for "${ch}"`)
        assert.match(colors[ch], /^#[0-9a-f]{6}$/i)
      }
    }
  }
})

test('faces are eyed and clothed - the template is not blank', () => {
  const { grid } = faceFor('pam')
  const flat = grid.join('')
  assert.equal([...flat].filter((c) => c === 'E').length, 2, 'exactly two eyes')
  assert.ok(flat.includes('T'), 'has a shirt')
  assert.ok(flat.includes('S'), 'has skin')
})

test('a shirt override wins without disturbing the rest of the face', () => {
  const plain = faceFor('Andy')
  const red = faceFor('Andy', '#d4685f')
  assert.equal(red.colors.T, '#d4685f')
  assert.equal(red.colors.H, plain.colors.H, 'hair must not change')
  assert.equal(red.colors.S, plain.colors.S, 'skin must not change')
  assert.deepEqual(red.grid, plain.grid)
})

test('every wizard preset renders', () => {
  for (const p of PRESETS) {
    const { grid } = faceFor(p)
    assert.equal(grid.length, FACE_SIZE, `${p} has no face`)
  }
})

test('slug produces safe directory names', () => {
  // Agent ids become directory names under ~/.bullpen, so a slug that escapes
  // into a path separator would let a name choose where files land.
  assert.equal(slug('Andy'), 'andy')
  assert.equal(slug('Dwight K. Schrute'), 'dwight-k-schrute')
  assert.equal(slug('Nguyễn Văn A'), 'nguyen-van-a')
  assert.equal(slug('../../etc/passwd'), 'etc-passwd')
  assert.equal(slug('   '), 'agent')
  assert.equal(slug(''), 'agent')
  assert.equal(slug('a'.repeat(80)).length, 32)
  for (const evil of ['../x', 'a/b', 'a\\b', 'a\0b', '.', '..']) {
    assert.doesNotMatch(slug(evil), /[/\\.\0]/, `slug("${evil}") must not contain path characters`)
  }
})

test('the roster does not collapse into one look', () => {
  const seen = new Set(CAST.map((id) => JSON.stringify(faceFor(id))))
  // Nine agents drawn from 3 templates x 7 hair x 5 skin x 7 shirt: a couple of
  // collisions is fine, everyone looking identical is not.
  assert.ok(seen.size >= 7, `only ${seen.size} distinct faces across ${CAST.length} agents`)
})
