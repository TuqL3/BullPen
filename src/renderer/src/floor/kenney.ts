import { TILE, type Cell } from './layout'
import { buildAtlas, type Palette } from './tiles'

/**
 * Hybrid art: Kenney's CC0 "Roguelike Indoors" pack over the generated tiles.
 *
 * The pack is public domain, so nothing here carries a licence obligation. It
 * is also a medieval tavern set - there is no desk-with-monitor, no office
 * chair, no cubicle in it - so the mapping below stands wooden furniture in for
 * office furniture, and the walls stay generated because the sheet has none.
 * Judge the result, do not assume it is an upgrade.
 */
const SHEET_URL = 'kenney/roguelikeIndoor_transparent.png'
const PITCH = 17 // 16px tiles with a 1px gutter

/** Cell -> [column, row] in the sheet. Cells left out keep the generated art. */
// No floor or rug here on purpose: the pack has no plain floor tile at all -
// its only ground tiles are bordered area rugs, which tile into stripes. The
// generated floor stays underneath.
const MAP: Partial<Record<Cell, [number, number]>> = {
  desk: [4, 12],
  deskUp: [4, 13],
  table: [0, 0],
  chairPink: [0, 9],
  plant: [16, 0],
  board: [18, 0],
  shelf: [25, 8],
  counter: [0, 15],
  fridge: [26, 8],
  cooler: [22, 9]
}

/** The chair drawn on an occupied seat. */
export const KENNEY_CHAIR: [number, number] = [0, 3]

const KINDS: Cell[] = [
  'floor',
  'rug',
  'wall',
  'wallFace',
  'window',
  'desk',
  'deskUp',
  'table',
  'chairPink',
  'plant',
  'counter',
  'shelf',
  'fridge',
  'board',
  'clock',
  'cooler'
]

let sheet: HTMLImageElement | null = null
let loading = false

/** Kick off the load once; callers re-check `sheet` on later frames. */
export function loadSheet(onReady: () => void): void {
  if (sheet || loading) return
  loading = true
  const img = new Image()
  img.onload = () => {
    sheet = img
    loading = false
    onReady()
  }
  img.onerror = () => {
    // Missing or blocked art is not worth breaking the floor over; the
    // generated tiles are a complete set on their own.
    loading = false
  }
  img.src = SHEET_URL
}

export function sheetReady(): boolean {
  return sheet !== null
}

export function drawSheetTile(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  x: number,
  y: number
): void {
  if (!sheet) return
  ctx.drawImage(sheet, col * PITCH, row * PITCH, TILE, TILE, x, y, TILE, TILE)
}

/**
 * Start from the generated atlas, then paint Kenney art over the cells it has.
 * Furniture tiles are transparent, so each one is laid over a Kenney floor
 * rather than over nothing.
 */
/** The plain floor from the generated set, used as ground under Kenney props. */
function drawGeneratedFloor(ctx: CanvasRenderingContext2D, x: number, p: Palette): void {
  ctx.fillStyle = p.floor
  ctx.fillRect(x, 0, TILE, TILE)
  ctx.fillStyle = p.floorLine
  ctx.fillRect(x, 0, TILE, 1)
  ctx.fillRect(x, 0, 1, TILE)
  ctx.fillStyle = p.floorDot
  ctx.fillRect(x + TILE / 2 - 1, TILE / 2 - 1, 2, 2)
}

export function buildHybridAtlas(p: Palette): HTMLCanvasElement {
  const canvas = buildAtlas(p)
  if (!sheet) return canvas
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false

  KINDS.forEach((kind, i) => {
    const src = MAP[kind]
    if (!src) return
    const x = i * TILE
    // Painted over the generated tile, which already carries the floor. The
    // sheet's furniture is transparent, so it lands on ground, not on nothing.
    ctx.clearRect(x, 0, TILE, TILE)
    drawGeneratedFloor(ctx, x, p)
    drawSheetTile(ctx, src[0], src[1], x, 0)
  })
  return canvas
}
