import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assignDesks,
  buildOffice,
  COLS,
  DOOR,
  findPath,
  randomWalkable,
  rng,
  ROWS,
  walkable
} from '../src/renderer/src/floor/layout.ts'

test('the office is sealed except for the door', () => {
  const { grid } = buildOffice()
  let gaps = 0
  for (let x = 0; x < COLS; x++) {
    if (grid[0][x] === 'floor') gaps++
    if (grid[ROWS - 1][x] === 'floor') gaps++
  }
  for (let y = 1; y < ROWS - 1; y++) {
    if (grid[y][0] === 'floor') gaps++
    if (grid[y][COLS - 1] === 'floor') gaps++
  }
  assert.equal(gaps, 1, 'the only hole in the outer wall should be the door')
  assert.ok(walkable(grid, DOOR.x, DOOR.y))
})

test('the meeting room and kitchen are reachable, not sealed off', () => {
  // A partitioned room with no doorway is a room nobody can walk into.
  const { grid } = buildOffice()
  for (const [label, spot] of [
    ['meeting room', { x: 8, y: 4 }],
    ['kitchen', { x: 30, y: 6 }]
  ] as const) {
    assert.ok(walkable(grid, spot.x, spot.y), `${label} floor is blocked`)
    assert.ok(findPath(grid, DOOR, spot), `no route into the ${label}`)
  }
})

test('every desk has a reachable seat', () => {
  // A desk nobody can walk to is an agent stuck in the doorway forever.
  const { grid, desks } = buildOffice()
  assert.ok(desks.length >= 24, `only ${desks.length} desks`)
  for (const d of desks) {
    assert.ok(walkable(grid, d.seat.x, d.seat.y), `seat of desk ${d.desk.x},${d.desk.y} is blocked`)
    const path = findPath(grid, DOOR, d.seat)
    assert.ok(path, `no route from the door to desk ${d.desk.x},${d.desk.y}`)
  }
})

test('a path is contiguous, walkable, and ends where asked', () => {
  const { grid, desks } = buildOffice()
  const target = desks[7].seat
  const path = findPath(grid, DOOR, target)!
  assert.ok(path.length > 0)

  let prev = DOOR
  for (const step of path) {
    const dist = Math.abs(step.x - prev.x) + Math.abs(step.y - prev.y)
    assert.equal(dist, 1, 'steps must be orthogonal and adjacent - no teleporting')
    assert.ok(walkable(grid, step.x, step.y), 'a path must not cross furniture')
    prev = step
  }
  assert.deepEqual(path.at(-1), target)
})

test('BFS returns a shortest path, not merely some path', () => {
  const { grid } = buildOffice()
  // Two points in open floor with nothing between them.
  const a = { x: 14, y: 24 }
  const b = { x: 17, y: 24 }
  assert.ok(walkable(grid, a.x, a.y) && walkable(grid, b.x, b.y))
  assert.equal(findPath(grid, a, b)!.length, 3)
})

test('an unreachable or blocked target yields null, not a crash', () => {
  const { grid, desks } = buildOffice()
  assert.equal(findPath(grid, DOOR, { x: 0, y: 0 }), null, 'walls are not destinations')
  assert.equal(findPath(grid, DOOR, desks[0].desk), null, 'the desk itself is furniture')
  assert.equal(findPath(grid, DOOR, { x: -1, y: 5 }), null)
})

test('walking to where you already stand is an empty path, not null', () => {
  const { grid } = buildOffice()
  assert.deepEqual(findPath(grid, DOOR, DOOR), [])
})

test('desks are assigned one per agent, stably', () => {
  const { desks } = buildOffice()
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
  const { grid } = buildOffice()
  const a = rng('michael')
  const b = rng('michael')
  const c = rng('dwight')
  assert.deepEqual(randomWalkable(grid, a), randomWalkable(grid, b), 'same agent, same wander')
  const first = rng('michael')
  assert.notDeepEqual(
    randomWalkable(grid, first),
    randomWalkable(grid, c),
    'different agents should not move in lockstep'
  )
})

test('randomWalkable never returns furniture', () => {
  const { grid } = buildOffice()
  const next = rng('sampling')
  for (let i = 0; i < 300; i++) {
    const p = randomWalkable(grid, next)
    assert.ok(walkable(grid, p.x, p.y), `returned ${p.x},${p.y}`)
  }
})
