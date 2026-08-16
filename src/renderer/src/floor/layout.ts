export const TILE = 16

/**
 * Small enough that a narrow panel still gets an office rather than a corridor,
 * large enough that the shell plus one pod fits. Below this the floor is
 * letterboxed instead, which is the honest outcome - there is no office to draw.
 */
export const MIN_COLS = 18
export const MIN_ROWS = 14

/**
 * And large enough is enough. Past this the office is not more readable, just
 * more of it: a wall of empty desks nobody sits at, with the agents you are
 * actually watching lost somewhere in the middle.
 */
export const MAX_COLS = 34
export const MAX_ROWS = 24

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

export type Office = {
  grid: Cell[][]
  desks: Desk[]
  /** Where agents walk in from, and where they leave. */
  door: Point
  cols: number
  rows: number
}

/**
 * Build an office to fit the panel it will be drawn in.
 *
 * The grid used to be a fixed 36x26, which meant a tall narrow panel got a
 * short wide office floating in the middle of it with gaps above and below.
 * Rooms and pods are placed relative to the size instead, and dropped entirely
 * when there is no room for them - a meeting room crammed into 20 columns is
 * worse than no meeting room.
 *
 * A pod at (x, y) occupies 2 wide x 4 tall:
 *   y     two desks facing down, seats on y+1
 *   y+1   aisle / seats
 *   y+2   aisle / seats
 *   y+3   two desks facing up, seats on y+2
 */
export function buildOffice(cols: number, rows: number): Office {
  cols = Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(cols)))
  rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(rows)))

  const grid: Cell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, (): Cell => 'floor')
  )
  const set = (x: number, y: number, c: Cell): void => {
    if (y >= 0 && y < rows && x >= 0 && x < cols) grid[y][x] = c
  }

  // Outer shell. The top wall is two tiles: a cap and a face below it, which is
  // the whole trick behind the room reading as three-dimensional.
  for (let x = 0; x < cols; x++) {
    set(x, 0, 'wall')
    set(x, 1, 'wallFace')
    set(x, rows - 1, 'wall')
  }
  for (let y = 0; y < rows; y++) {
    set(0, y, 'wall')
    set(cols - 1, y, 'wall')
  }

  const door: Point = { x: Math.floor(cols / 2), y: rows - 1 }
  set(door.x, door.y, 'floor')
  for (let x = 3; x < cols - 3; x += 5) {
    set(x, 1, 'window')
    set(x + 1, 1, 'window')
  }
  set(Math.floor(cols / 2), 1, 'clock')

  // Rooms occupy the top band. Each needs its own width, so a narrow panel gets
  // one of them and a very narrow one gets neither - open plan, not a maze.
  const roomTop = 3
  const roomBottom = Math.min(9, rows - 8)
  // Rooms only if they leave room for at least one pod row below them. A floor
  // of nothing but a meeting room has nowhere to seat anyone, which is worse
  // than an open-plan floor with no meeting room.
  const hasRooms = roomBottom - roomTop >= 4 && roomBottom + 6 < rows - 2
  const meetingW = 10
  const kitchenW = 8
  const meeting = hasRooms && cols >= meetingW + 6 ? { x0: 2, x1: 2 + meetingW } : null
  const kitchen =
    hasRooms && cols >= meetingW + kitchenW + 10 ? { x0: cols - 1 - kitchenW, x1: cols - 2 } : null

  if (meeting) {
    for (let y = roomTop; y <= roomBottom; y++) set(meeting.x1, y, 'wall')
    for (let x = meeting.x0; x <= meeting.x1; x++) set(x, roomBottom, 'wall')
    // A doorway in each partition, or the room is a sealed box.
    set(meeting.x1, roomTop + 3, 'floor')
    set(meeting.x0 + 5, roomBottom, 'floor')
    for (let y = roomTop + 1; y < roomBottom; y++) {
      for (let x = meeting.x0; x < meeting.x1; x++) set(x, y, 'rug')
    }
    const midY = Math.floor((roomTop + roomBottom) / 2)
    for (let x = meeting.x0 + 2; x <= meeting.x1 - 2; x++) {
      set(x, midY, 'table')
      set(x, midY + 1, 'table')
      set(x, midY - 1, 'chairPink')
      set(x, midY + 2, 'chairPink')
    }
    set(meeting.x0 + 7, 1, 'board')
  }

  if (kitchen) {
    for (let y = roomTop; y <= roomBottom; y++) set(kitchen.x0 - 1, y, 'wall')
    for (let x = kitchen.x0 - 1; x <= kitchen.x1; x++) set(x, roomBottom, 'wall')
    set(kitchen.x0 - 1, roomBottom - 2, 'floor')
    for (let x = kitchen.x0; x <= kitchen.x1; x++) set(x, roomTop, 'counter')
    set(kitchen.x0, roomTop + 1, 'fridge')
    for (let x = kitchen.x0 + 3; x <= kitchen.x1; x++) set(x, roomBottom - 1, 'shelf')
    set(kitchen.x0 - 3, roomTop + 1, 'cooler')
  }

  // Desks in pods of four facing each other across an aisle, not a lattice. A
  // regular grid of identical desks reads as a spreadsheet; pods read as an
  // office, and cost the same to generate.
  const desks: Desk[] = []
  const podTop = hasRooms ? roomBottom + 3 : 3
  // The row inside the bottom wall stays clear: it is the corridor the door
  // opens onto. Without it a pod can land on the doorway and seal the office -
  // every seat unreachable, everyone stuck in the wall.
  for (let py = podTop; py + 3 < rows - 2; py += 6) {
    for (let px = 3; px + 1 < cols - 2; px += 5) {
      for (const dx of [0, 1]) {
        set(px + dx, py, 'desk')
        desks.push({ desk: { x: px + dx, y: py }, seat: { x: px + dx, y: py + 1 } })
        set(px + dx, py + 3, 'deskUp')
        desks.push({ desk: { x: px + dx, y: py + 3 }, seat: { x: px + dx, y: py + 2 } })
      }
    }
  }

  for (const p of [
    { x: 1, y: podTop - 1 },
    { x: cols - 2, y: podTop - 1 },
    { x: 1, y: rows - 2 },
    { x: cols - 2, y: rows - 2 }
  ]) {
    set(p.x, p.y, 'plant')
  }

  return { grid, desks, door, cols, rows }
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
  y >= 0 && y < grid.length && x >= 0 && x < grid[0].length && !BLOCKED.has(grid[y][x])

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

  const w = grid[0].length
  const key = (x: number, y: number) => y * w + x
  const prev = new Map<number, number>()
  const seen = new Uint8Array(w * grid.length)
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
        path.push({ x: k % w, y: Math.floor(k / w) })
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
export function randomWalkable(grid: Cell[][], next: () => number, fallback: Point): Point {
  for (let tries = 0; tries < 200; tries++) {
    const x = Math.floor(next() * grid[0].length)
    const y = Math.floor(next() * grid.length)
    if (walkable(grid, x, y)) return { x, y }
  }
  return fallback
}
