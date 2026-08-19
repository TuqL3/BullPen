export const TILE = 16

/**
 * Small enough that a narrow panel still gets an office rather than a corridor,
 * large enough that the shell plus one pod fits. Below this the floor is
 * letterboxed instead, which is the honest outcome - there is no office to draw.
 */
export const MIN_COLS = 18
export const MIN_ROWS = 14

/**
 * A ceiling, not a target: the office is built to whatever the panel gives it.
 *
 * These were 29x24 - five pods across, four rows of desks - and the floor was
 * drawn at that size in the middle of whatever panel it had, which on a tall
 * panel is a small room with a field of empty panel under it. The panel is
 * resizable, so the room follows it and these only stop it running away on a
 * wall-sized monitor.
 */
export const MAX_COLS = 44
export const MAX_ROWS = 44

export type Cell =
  | 'floor'
  | 'rug'
  | 'door'
  | 'wall'
  | 'wallFace'
  | 'wallLeft'
  | 'wallRight'
  | 'window'
  | 'desk'
  | 'deskUp'
  | 'deskBoss'
  | 'table'
  | 'chairPink'
  | 'plant'
  | 'counter'
  | 'shelf'
  | 'fridge'
  | 'board'
  | 'clock'
  | 'cooler'
  | 'tv'
  | 'sofa'
  | 'coffee'
  | 'printer'
  | 'cabinet'

export type Point = { x: number; y: number }
export type Desk = { desk: Point; seat: Point }

const BLOCKED: ReadonlySet<Cell> = new Set<Cell>([
  'wall',
  'wallFace',
  'wallLeft',
  'wallRight',
  'window',
  'clock',
  'board',
  'desk',
  'deskUp',
  'deskBoss',
  'table',
  'plant',
  'counter',
  'shelf',
  'fridge',
  'cooler',
  'tv',
  'sofa',
  'coffee',
  'printer',
  'cabinet'
])

export type Office = {
  grid: Cell[][]
  /**
   * What is under each tile - floor or rug. Kept apart from `grid` because a
   * chair standing on a rug is still standing on a rug: with one grid the
   * furniture tile carried its own ground and painted green squares across the
   * meeting room carpet.
   */
  ground: Cell[][]
  desks: Desk[]
  /**
   * The corner office. Dispatch stands in for the operator and everything
   * routes through them, so they do not sit in a pod like everyone else - if
   * they did, finding them on the floor would mean reading name labels.
   */
  boss: Desk | null
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
  const ground: Cell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, (): Cell => 'floor')
  )
  const set = (x: number, y: number, c: Cell): void => {
    if (y >= 0 && y < rows && x >= 0 && x < cols) grid[y][x] = c
  }
  /** Lay carpet: the tile on top may later be furniture, the carpet stays. */
  const carpet = (x: number, y: number): void => {
    if (y >= 0 && y < rows && x >= 0 && x < cols) {
      ground[y][x] = 'rug'
      grid[y][x] = 'rug'
    }
  }

  // Outer shell. The top wall is two tiles: a cap and a face below it, which is
  // the whole trick behind the room reading as three-dimensional.
  for (let x = 0; x < cols; x++) {
    set(x, 0, 'wall')
    set(x, 1, 'wallFace')
    set(x, rows - 1, 'wall')
  }
  // The side walls get a face of their own. Drawn as a flat cap they read as a
  // strip of paint rather than a wall, which is exactly how the top wall would
  // read without the face tile under it.
  for (let y = 0; y < rows; y++) {
    set(0, y, y === 0 || y === rows - 1 ? 'wall' : 'wallLeft')
    set(cols - 1, y, y === 0 || y === rows - 1 ? 'wall' : 'wallRight')
  }

  const door: Point = { x: Math.floor(cols / 2), y: rows - 1 }
  // A doorway drawn as a hole in the wall reads as a wall with a piece missing.
  // 'door' is walkable like floor, but drawn with a frame.
  set(door.x, door.y, 'door')
  for (let x = 3; x < cols - 3; x += 5) {
    set(x, 1, 'window')
    set(x + 1, 1, 'window')
  }
  set(Math.floor(cols / 2), 1, 'clock')

  // Rooms occupy the top band. Each needs its own width, so a narrow panel gets
  // one of them and a very narrow one gets neither - open plan, not a maze.
  // Partitions start directly under the wall face; the interior is everything
  // between that and the bottom wall.
  const partTop = 2
  // Six rows of interior: one of floor, the four-row table block, one of floor.
  const roomBottom = Math.min(partTop + 6, rows - 8)
  // Rooms only if they leave room for at least one pod row below them. A floor
  // of nothing but a meeting room has nowhere to seat anyone, which is worse
  // than an open-plan floor with no meeting room.
  const hasRooms = roomBottom - partTop >= 6 && roomBottom + 6 < rows - 2
  // Two rooms, each with its own door, sharing the vertical wall between them.
  // Sharing it is what keeps the back wall continuous: when each room's wall ran
  // out into open floor, the result was a wall that stopped in mid-air with the
  // next one starting further along, read - correctly - as a missing wall.
  const split = Math.floor(cols / 2)
  const roomsFit = hasRooms && cols >= 24
  const meeting = roomsFit ? { x0: 2, x1: split } : hasRooms ? { x0: 2, x1: 2 + 10 } : null


  if (meeting) {
    for (let y = partTop; y <= roomBottom; y++) set(meeting.x1, y, 'wall')
    // From the building wall, not from x0: the room's rug reaches the outer wall,
    // and starting the bottom run one tile in left a hole beside it - a second
    // way out of the room that was not a door.
    for (let x = meeting.x0 - 1; x <= meeting.x1; x++) set(x, roomBottom, 'wall')
    // The right-hand partition is shared with the kitchen, so its door goes in
    // the bottom wall - one in the other would open into the fridge.
    set(meeting.x0 + 5, roomBottom, 'door')
    for (let y = partTop; y < roomBottom; y++) {
      for (let x = meeting.x0 - 1; x < meeting.x1; x++) carpet(x, y)
    }
    // Centred both ways. A table pinned to one end of the room reads as
    // furniture that was pushed aside rather than a meeting room.
    const inX0 = meeting.x0 - 1
    const inX1 = meeting.x1 - 1
    const inY0 = partTop
    // One tile of floor on three sides, three on the screen side: a meeting room
    // needs somewhere to stand and something to look at, and a table pushed up
    // against the wall the screen is on leaves neither.
    const SCREEN_GAP = 3
    const tableW = inX1 - inX0 + 1 - 1 - SCREEN_GAP
    const tx = inX0 + 1
    const ty = inY0 + 1
    for (let x = tx; x < tx + tableW; x++) {
      set(x, ty, 'chairPink')
      set(x, ty + 1, 'table')
      set(x, ty + 2, 'table')
      set(x, ty + 3, 'chairPink')
    }
    set(Math.floor((inX0 + inX1) / 2), 1, 'board')
    // Nothing else inside: the ring around the table is meant to be floor, and
    // a cooler standing in it is not floor.
  }

  // The screen goes on last: it hangs on the wall the two rooms share, and the
  // kitchen redraws that wall after the meeting room is furnished.
  if (meeting) {
    set(meeting.x1, partTop + 2, 'tv')
    set(meeting.x1, partTop + 3, 'tv')
  }

  // The corner office, bottom right. Needs its own walls, so it is only carved
  // when there is width for it and pods left over beside it.
  // Small on purpose: a corner office the size of the meeting room reads as
  // empty floor with a desk in it. It has to be his, not spacious.
  const OFFICE_W = 6
  const OFFICE_H = 4
  const bossRoom =
    cols >= OFFICE_W + 14 && rows >= OFFICE_H + 8
      ? { x0: cols - 1 - OFFICE_W, y0: rows - 2 - OFFICE_H, x1: cols - 2, y1: rows - 2 }
      : null

  let boss: Desk | null = null
  if (bossRoom) {
    for (let y = bossRoom.y0 - 1; y <= bossRoom.y1; y++) set(bossRoom.x0 - 1, y, 'wall')
    for (let x = bossRoom.x0 - 1; x <= cols - 1; x++) set(x, bossRoom.y0 - 1, 'wall')
    // A doorway, or it is a sealed box with the one agent you most want to see
    // in it. Two tiles in from the bottom so the aisle reaches it.
    set(bossRoom.x0 - 1, bossRoom.y1 - 1, 'door')
    for (let y = bossRoom.y0; y <= bossRoom.y1; y++) {
      for (let x = bossRoom.x0; x <= bossRoom.x1; x++) carpet(x, y)
    }
    const bx = bossRoom.x0 + 1
    const by = bossRoom.y0 + 1
    set(bx, by, 'deskBoss')
    set(bx + 1, by, 'deskBoss')
    boss = { desk: { x: bx, y: by }, seat: { x: bx, y: by + 1 } }
    // Furnished, or it is a rug with a desk on it: a shelf and a cabinet on the
    // back wall, a plant in the far corner.
    set(bossRoom.x1, bossRoom.y0, 'shelf')
    set(bossRoom.x1, bossRoom.y0 + 1, 'cabinet')
    set(bossRoom.x1, bossRoom.y1, 'plant')
    set(bossRoom.x0, bossRoom.y0, 'plant')
  }

  /**
   * Does a pod's 2x4 footprint run into the corner office, its walls, or the
   * tile you have to stand on to open its door?
   *
   * The door is in the office's left wall, so the approach is the column left
   * of that wall. A pod was allowed to sit in it, and at every width where one
   * landed there the boss was sealed in: his seat had no route from the front
   * door, so the agent who owns that desk stood in the doorway forever.
   */
  const hitsOffice = (px: number, py: number): boolean =>
    bossRoom !== null &&
    px + 1 >= bossRoom.x0 - 2 &&
    px <= bossRoom.x1 &&
    py + 3 >= bossRoom.y0 - 1 &&
    py <= bossRoom.y1

  // Desks in pods of four facing each other across an aisle, not a lattice. A
  // regular grid of identical desks reads as a spreadsheet; pods read as an
  // office, and cost the same to generate.
  const desks: Desk[] = []
  const podTop = hasRooms ? roomBottom + 3 : 3
  // The row inside the bottom wall stays clear: it is the corridor the door
  // opens onto. Without it a pod can land on the doorway and seal the office -
  // every seat unreachable, everyone stuck in the wall.
  const pod = (px: number, py: number): void => {
    for (const dx of [0, 1]) {
      set(px + dx, py, 'desk')
      desks.push({ desk: { x: px + dx, y: py }, seat: { x: px + dx, y: py + 1 } })
      set(px + dx, py + 3, 'deskUp')
      desks.push({ desk: { x: px + dx, y: py + 3 }, seat: { x: px + dx, y: py + 2 } })
    }
  }

  for (let py = podTop; py + 3 < rows - 2; py += 6) {
    for (let px = 3; px + 1 < cols - 2; px += 5) {
      if (hitsOffice(px, py)) continue
      pod(px, py)
    }
  }

  // The strip the kitchen used to occupy, between the meeting room and the back
  // wall. Interior floor exactly as tall as a pod, so it seats people: a
  // fridge and two sinks were the only things in it, and desks are what this
  // office is short of. One tile of aisle beside the meeting room's wall.
  if (meeting) {
    for (let px = meeting.x1 + 2; px + 1 < cols - 2; px += 5) pod(px, partTop + 1)
  }

  /**
   * Decor, placed only where it does not cut the floor in two.
   *
   * Everything here is furniture, and a single plant dropped in a one-tile
   * corridor strands whatever was behind it - which is how a desk ends up
   * unreachable and an agent stands in the doorway forever. Rather than hunting
   * for safe coordinates by hand, each piece is placed, checked, and undone if
   * it cost more than the tile it covers.
   */
  const reachable = (): number => {
    const seen = new Uint8Array(cols * rows)
    const queue: Point[] = [door]
    seen[door.y * cols + door.x] = 1
    let n = 0
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head]
      n++
      for (const [dx, dy] of [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0]
      ]) {
        const nx = cur.x + dx
        const ny = cur.y + dy
        const k = ny * cols + nx
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || seen[k]) continue
        if (BLOCKED.has(grid[ny][nx])) continue
        seen[k] = 1
        queue.push({ x: nx, y: ny })
      }
    }
    return n
  }

  let open = reachable()
  const decor = (x: number, y: number, c: Cell): void => {
    if (grid[y]?.[x] !== 'floor') return
    set(x, y, c)
    const after = reachable()
    // One tile fewer is the tile just covered. Anything more was stranded.
    if (after === open - 1) open = after
    else set(x, y, 'floor')
  }
  for (const y of [podTop - 1, rows - 2]) {
    decor(1, y, 'plant')
    decor(cols - 2, y, 'plant')
  }
  if (hasRooms) {
    // The strip between the rooms and the first pod row: a lounge, which is
    // what an office has where a floor plan has empty space.
    const y = roomBottom + 1
    decor(3, y, 'sofa')
    decor(4, y, 'sofa')
    decor(5, y, 'sofa')
    decor(7, y, 'coffee')
    decor(9, y, 'plant')
    decor(cols - 4, y, 'printer')
    decor(cols - 6, y, 'cabinet')
    decor(cols - 7, y, 'cabinet')
  }
  // Against the side walls, level with the pods.
  for (let y = podTop + 1; y < rows - 2; y += 5) {
    decor(1, y, y % 2 ? 'cabinet' : 'plant')
    decor(cols - 2, y, y % 2 ? 'plant' : 'printer')
  }

  return { grid, ground, desks, door, boss, cols, rows }
}


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
export function assignDesks(
  agentIds: string[],
  office: Pick<Office, 'desks' | 'boss'>,
  godId?: string | null
): Map<string, Desk> {
  const out = new Map<string, Desk>()
  // The god agent takes the corner office; everyone else fills the pods from
  // the front, so three agents sit together rather than scattering.
  const workers = agentIds.filter((id) => id !== godId || !office.boss)
  if (godId && office.boss && agentIds.includes(godId)) out.set(godId, office.boss)
  workers.forEach((id, i) => {
    const desk = office.desks[i % office.desks.length]
    if (desk) out.set(id, desk)
  })
  return out
}

/**
 * Where to stand to talk to someone at `seat`.
 *
 * Beside them, never on them: the seat is walkable - a chair is drawn on the
 * room layer rather than blocking the grid - so a visitor sent to the seat
 * itself ends up standing inside the person it came to see.
 *
 * The nearest free neighbour to where the visitor is now, so someone crossing
 * the floor stops on the side they arrived from instead of walking round the
 * desk. Null when the seat has no free side at all, which is what the caller
 * needs to know: there is no conversation to draw.
 */
export function standingSpot(grid: Cell[][], seat: Point, from: Point): Point | null {
  const sides = [
    { x: seat.x, y: seat.y - 1 },
    { x: seat.x + 1, y: seat.y },
    { x: seat.x, y: seat.y + 1 },
    { x: seat.x - 1, y: seat.y }
  ].filter((p) => walkable(grid, p.x, p.y))
  if (sides.length === 0) return null
  return sides.reduce((best, p) =>
    Math.abs(p.x - from.x) + Math.abs(p.y - from.y) <
    Math.abs(best.x - from.x) + Math.abs(best.y - from.y)
      ? p
      : best
  )
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
