import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assignDesks,
  buildOffice,
  findPath,
  DESK_ROWS,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  randomWalkable,
  rng,
  walkable
} from '../src/renderer/src/floor/layout.ts'

/**
 * The office is built to whatever shape the panel is, so every invariant has to
 * hold at every shape - a tall narrow column, a short wide strip, and the
 * smallest thing that still counts as an office.
 */
const SIZES: [number, number][] = [
  [36, 26], // the original fixed grid - now above the cap, so it clamps
  [200, 200], // far past the cap in both directions
  [22, 60], // a tall narrow column
  [90, 16], // a short wide strip
  [MIN_COLS, MIN_ROWS], // the floor of what is allowed
  [4, 4] // below it - must be clamped, not crash
]

for (const [cols, rows] of SIZES) {
  const label = `${cols}x${rows}`

  test(`${label}: the office is sealed except for the door`, () => {
    const o = buildOffice(cols, rows)
    let gaps = 0
    for (let x = 0; x < o.cols; x++) {
      if (o.grid[0][x] === 'floor') gaps++
      if (o.grid[o.rows - 1][x] === 'floor') gaps++
    }
    for (let y = 1; y < o.rows - 1; y++) {
      if (o.grid[y][0] === 'floor') gaps++
      if (o.grid[y][o.cols - 1] === 'floor') gaps++
    }
    assert.equal(gaps, 1, 'the only hole in the outer wall should be the door')
    assert.ok(walkable(o.grid, o.door.x, o.door.y))
  })

  test(`${label}: every desk has a seat reachable from the door`, () => {
    // A desk nobody can walk to is an agent stuck in the doorway forever.
    const o = buildOffice(cols, rows)
    assert.ok(o.desks.length > 0, 'an office with no desks has nowhere to put anyone')
    for (const d of o.desks) {
      assert.ok(walkable(o.grid, d.seat.x, d.seat.y), `seat of ${d.desk.x},${d.desk.y} is blocked`)
      assert.ok(findPath(o.grid, o.door, d.seat), `no route to desk ${d.desk.x},${d.desk.y}`)
    }
  })

  test(`${label}: no room is walled off from the rest of the floor`, () => {
    // A partition with no doorway is a room nobody can walk into, and at some
    // sizes the rooms are dropped entirely - both are fine, sealed is not.
    const o = buildOffice(cols, rows)
    for (let y = 1; y < o.rows - 1; y++) {
      for (let x = 1; x < o.cols - 1; x++) {
        if (!walkable(o.grid, x, y)) continue
        assert.ok(findPath(o.grid, o.door, { x, y }), `${x},${y} is cut off from the door`)
      }
    }
  })

  test(`${label}: the grid is exactly the size it reports`, () => {
    const o = buildOffice(cols, rows)
    assert.equal(o.grid.length, o.rows)
    assert.ok(o.grid.every((r) => r.length === o.cols))
    assert.ok(o.cols >= MIN_COLS && o.rows >= MIN_ROWS)
    // And capped: past this the office is not more readable, just more of it.
    assert.ok(o.cols <= MAX_COLS && o.rows <= MAX_ROWS)
  })
}

test('at full size the office is exactly four rows of desks', () => {
  // Asked for explicitly: more rows is a wall of empty desks, fewer wastes the
  // panel. The cap has to produce the count, not merely allow it.
  const o = buildOffice(MAX_COLS, MAX_ROWS)
  const rows = new Set(o.desks.map((d) => d.desk.y))
  assert.equal(rows.size, DESK_ROWS, [...rows].join(','))
  // And a panel larger than the cap gets the same office, not a bigger one.
  const huge = buildOffice(500, 500)
  assert.equal(new Set(huge.desks.map((d) => d.desk.y)).size, DESK_ROWS)
})

test('a path is contiguous, walkable, and ends where asked', () => {
  const o = buildOffice(36, 26)
  const target = o.desks[7].seat
  const path = findPath(o.grid, o.door, target)!
  assert.ok(path.length > 0)

  let prev = o.door
  for (const step of path) {
    const dist = Math.abs(step.x - prev.x) + Math.abs(step.y - prev.y)
    assert.equal(dist, 1, 'steps must be orthogonal and adjacent - no teleporting')
    assert.ok(walkable(o.grid, step.x, step.y), 'a path must not cross furniture')
    prev = step
  }
  assert.deepEqual(path.at(-1), target)
})

test('BFS returns a shortest path, not merely some path', () => {
  const o = buildOffice(36, 26)
  // Two points in open floor with nothing between them.
  const a = { x: 14, y: o.rows - 2 }
  const b = { x: 17, y: o.rows - 2 }
  assert.ok(walkable(o.grid, a.x, a.y) && walkable(o.grid, b.x, b.y))
  assert.equal(findPath(o.grid, a, b)!.length, 3)
})

test('an unreachable or blocked target yields null, not a crash', () => {
  const o = buildOffice(36, 26)
  assert.equal(findPath(o.grid, o.door, { x: 0, y: 0 }), null, 'walls are not destinations')
  assert.equal(findPath(o.grid, o.door, o.desks[0].desk), null, 'the desk itself is furniture')
  assert.equal(findPath(o.grid, o.door, { x: -1, y: 5 }), null)
})

test('walking to where you already stand is an empty path, not null', () => {
  const o = buildOffice(36, 26)
  assert.deepEqual(findPath(o.grid, o.door, o.door), [])
})

test('desks are assigned one per agent, stably', () => {
  const { desks } = buildOffice(36, 26)
  const ids = ['michael', 'dwight', 'jim']
  const first = assignDesks(ids, desks)
  const second = assignDesks(ids, desks)

  assert.equal(first.size, 3)
  const seats = [...first.values()].map((d) => `${d.seat.x},${d.seat.y}`)
  assert.equal(new Set(seats).size, 3, 'two agents must not share a seat')
  for (const id of ids) {
    assert.deepEqual(first.get(id), second.get(id), 'assignment must not shuffle between renders')
  }
})

test('idle wandering is deterministic per agent', () => {
  const o = buildOffice(36, 26)
  const a = rng('michael')
  const b = rng('michael')
  const c = rng('dwight')
  assert.deepEqual(
    randomWalkable(o.grid, a, o.door),
    randomWalkable(o.grid, b, o.door),
    'same agent, same wander'
  )
  const first = rng('michael')
  assert.notDeepEqual(
    randomWalkable(o.grid, first, o.door),
    randomWalkable(o.grid, c, o.door),
    'different agents should not move in lockstep'
  )
})

test('randomWalkable never returns furniture', () => {
  const o = buildOffice(36, 26)
  const next = rng('sampling')
  for (let i = 0; i < 300; i++) {
    const p = randomWalkable(o.grid, next, o.door)
    assert.ok(walkable(o.grid, p.x, p.y), `returned ${p.x},${p.y}`)
  }
})
