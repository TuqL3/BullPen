export const TILE = 16
export const COLS = 36
export const ROWS = 26

export type Cell =
  | 'floor'
  | 'rug'
  | 'wall'
  | 'wallFace'
  | 'window'
  | 'desk'
  | 'deskUp'
  | 'table'
  | 'chairPink'
  | 'plant'
  | 'counter'
  | 'shelf'
  | 'fridge'
  | 'board'
  | 'clock'
  | 'cooler'

export type Point = { x: number; y: number }
export type Desk = { desk: Point; seat: Point }

/** Where agents walk in from, and where they leave. */
export const DOOR: Point = { x: 18, y: ROWS - 1 }

/**
 * Desks in pods of four facing each other across an aisle, not a lattice. A
 * regular grid of identical desks reads as a spreadsheet; pods read as an
 * office, and cost the same to generate.
 *
 * A pod at (x, y) occupies 2 wide x 4 tall:
 *   y     two desks facing down, seats on y+1
 *   y+1   aisle / seats
 *   y+2   aisle / seats
 *   y+3   two desks facing up, seats on y+2
 */
const POD_X = [3, 8, 13, 18, 23, 28]
const POD_Y = [13, 19]

const MEETING = { x0: 2, y0: 3, x1: 12, y1: 9 }
const KITCHEN = { x0: 27, y0: 3, x1: COLS - 2, y1: 9 }

export function buildOffice(): { grid: Cell[][]; desks: Desk[] } {
  const grid: Cell[][] = Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, (): Cell => 'floor')
  )
  const set = (x: number, y: number, c: Cell): void => {
    if (y >= 0 && y < ROWS && x >= 0 && x < COLS) grid[y][x] = c
  }

  // Outer shell. The top wall is two tiles: a cap and a face below it, which is
  // the whole trick behind the room reading as three-dimensional.
  for (let x = 0; x < COLS; x++) {
    set(x, 0, 'wall')
    set(x, 1, 'wallFace')
    set(x, ROWS - 1, 'wall')
  }
  for (let y = 0; y < ROWS; y++) {
    set(0, y, 'wall')
    set(COLS - 1, y, 'wall')
  }
  set(DOOR.x, DOOR.y, 'floor')
  for (const x of [4, 5, 14, 15, 22, 23, 30, 31]) set(x, 1, 'window')
  set(18, 1, 'clock')
  set(9, 1, 'board')

  // Meeting room: partition on the right and bottom, with a doorway in each.
  for (let y = MEETING.y0; y <= MEETING.y1; y++) set(MEETING.x1, y, 'wall')
  for (let x = MEETING.x0; x <= MEETING.x1; x++) set(x, MEETING.y1, 'wall')
  set(MEETING.x1, 6, 'floor')
  set(7, MEETING.y1, 'floor')
  for (let y = MEETING.y0 + 1; y < MEETING.y1; y++) {
    for (let x = MEETING.x0; x < MEETING.x1; x++) set(x, y, 'rug')
  }
  for (let x = 4; x <= 10; x++) {
    set(x, 6, 'table')
    set(x, 7, 'table')
  }
  for (let x = 4; x <= 10; x++) {
    set(x, 5, 'chairPink')
    set(x, 8, 'chairPink')
  }

  // Kitchen: partition on the left and bottom, doorway on the left.
  for (let y = KITCHEN.y0; y <= KITCHEN.y1; y++) set(KITCHEN.x0 - 1, y, 'wall')
  for (let x = KITCHEN.x0 - 1; x <= KITCHEN.x1; x++) set(x, KITCHEN.y1, 'wall')
  set(KITCHEN.x0 - 1, 7, 'floor')
  for (let x = KITCHEN.x0; x <= KITCHEN.x1; x++) set(x, KITCHEN.y0, 'counter')
  set(KITCHEN.x0, KITCHEN.y0 + 1, 'fridge')
  for (let x = KITCHEN.x0 + 3; x <= KITCHEN.x1; x++) set(x, KITCHEN.y1 - 1, 'shelf')

  set(24, 4, 'cooler')
  for (const p of [
    { x: 1, y: 11 },
    { x: COLS - 2, y: 11 },
    { x: 1, y: ROWS - 2 },
    { x: COLS - 2, y: ROWS - 2 },
    { x: 34, y: 15 },
    { x: 34, y: 21 }
  ]) {
    set(p.x, p.y, 'plant')
  }

  const desks: Desk[] = []
  for (const py of POD_Y) {
    for (const px of POD_X) {
      for (const dx of [0, 1]) {
        set(px + dx, py, 'desk')
        desks.push({ desk: { x: px + dx, y: py }, seat: { x: px + dx, y: py + 1 } })
        set(px + dx, py + 3, 'deskUp')
        desks.push({ desk: { x: px + dx, y: py + 3 }, seat: { x: px + dx, y: py + 2 } })
      }
    }
  }
  return { grid, desks }
}

const BLOCKED: ReadonlySet<Cell> = new Set<Cell>([
  'wall',
  'wallFace',
  'window',
  'clock',
  'board',
  'desk',
  'deskUp',
  'table',
  'plant',
  'counter',
  'shelf',
  'fridge',
  'cooler'
])

export const walkable = (grid: Cell[][], x: number, y: number): boolean =>
  y >= 0 && y < ROWS && x >= 0 && x < COLS && !BLOCKED.has(grid[y][x])

/**
 * Shortest path, or null when there is none.
 *
 * ponytail: breadth-first, not A*. Every step costs the same on this grid, so
 * BFS already returns a shortest path without a priority queue. Ceiling: it can
 * visit the whole floor, roughly 1500 cells, once per walk - nothing.
 */
export function findPath(grid: Cell[][], from: Point, to: Point): Point[] | null {
  if (!walkable(grid, to.x, to.y) || !walkable(grid, from.x, from.y)) return null
  if (from.x === to.x && from.y === to.y) return []

  const key = (x: number, y: number) => y * COLS + x
  const prev = new Map<number, number>()
  const seen = new Uint8Array(COLS * ROWS)
  const queue: Point[] = [from]
  seen[key(from.x, from.y)] = 1

  const STEPS = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0]
  ]

  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]
    if (cur.x === to.x && cur.y === to.y) {
      const path: Point[] = []
      let k = key(cur.x, cur.y)
      while (k !== key(from.x, from.y)) {
        path.push({ x: k % COLS, y: Math.floor(k / COLS) })
        k = prev.get(k)!
      }
      return path.reverse()
    }
    for (const [dx, dy] of STEPS) {
      const nx = cur.x + dx
      const ny = cur.y + dy
      const nk = key(nx, ny)
      if (!walkable(grid, nx, ny) || seen[nk]) continue
      seen[nk] = 1
      prev.set(nk, key(cur.x, cur.y))
      queue.push({ x: nx, y: ny })
    }
  }
  return null
}

/**
 * Stable desk assignment, filling pod by pod so three agents sit together at
 * the front instead of scattering across an empty office.
 */
export function assignDesks(agentIds: string[], desks: Desk[]): Map<string, Desk> {
  const out = new Map<string, Desk>()
  agentIds.forEach((id, i) => {
    const desk = desks[i % desks.length]
    if (desk) out.set(id, desk)
  })
  return out
}

/** Deterministic per-agent randomness, so idle wandering replays identically. */
export function rng(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return () => {
    h += 0x6d2b79f5
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A walkable tile chosen deterministically - used for idle wandering. */
export function randomWalkable(grid: Cell[][], next: () => number): Point {
  for (let tries = 0; tries < 200; tries++) {
    const x = Math.floor(next() * COLS)
    const y = Math.floor(next() * ROWS)
    if (walkable(grid, x, y)) return { x, y }
  }
  return DOOR
}
