import { TILE, type Cell } from './layout'

export type Palette = {
  floor: string
  floorLine: string
  floorDot: string
  rug: string
  rugLine: string
  wallTop: string
  wallFace: string
  wallEdge: string
  glass: string
  glassFrame: string
  deskTop: string
  bossTop: string
  bossEdge: string
  deskEdge: string
  deskLeg: string
  screen: string
  screenGlow: string
  chair: string
  chairPink: string
  sofa: string
  sofaDark: string
  table: string
  tableEdge: string
  leaf: string
  leafDark: string
  pot: string
  metal: string
  metalDark: string
  paper: string
  shadow: string
}

export const PALETTES: Record<'light' | 'dark', Palette> = {
  light: {
    floor: '#cfe8d4',
    floorLine: '#c0dcc6',
    floorDot: '#aed3b6',
    rug: '#e6dcc4',
    rugLine: '#d8ccae',
    wallTop: '#f7f5ef',
    wallFace: '#e3ded1',
    wallEdge: '#c5bfae',
    glass: '#bcd9e8',
    glassFrame: '#8fa6b3',
    deskTop: '#eccb89',
    bossTop: '#b8823c',
    bossEdge: '#8a5c22',
    deskEdge: '#c99f56',
    deskLeg: '#a87f3d',
    screen: '#3b3b46',
    screenGlow: '#93bcd8',
    chair: '#c58f52',
    chairPink: '#e39aa8',
    sofa: '#7f93b8',
    sofaDark: '#5a6d90',
    table: '#eccb89',
    tableEdge: '#c99f56',
    leaf: '#5f9e63',
    leafDark: '#437a48',
    pot: '#b5714a',
    metal: '#d8dade',
    metalDark: '#a8adb5',
    paper: '#fffdf5',
    shadow: 'rgba(60,70,60,0.16)'
  },
  dark: {
    floor: '#22302a',
    floorLine: '#28372f',
    floorDot: '#2f4038',
    rug: '#33302a',
    rugLine: '#3c3830',
    wallTop: '#333743',
    wallFace: '#262a34',
    wallEdge: '#171a21',
    glass: '#2c4a5c',
    glassFrame: '#465a68',
    deskTop: '#8a7040',
    bossTop: '#a8813e',
    bossEdge: '#6b4d18',
    deskEdge: '#5f4d2a',
    deskLeg: '#463819',
    screen: '#0d0e13',
    screenGlow: '#3f6b8c',
    chair: '#6b4b2b',
    chairPink: '#8d5b66',
    sofa: '#4a5877',
    sofaDark: '#333d55',
    table: '#8a7040',
    tableEdge: '#5f4d2a',
    leaf: '#3f7048',
    leafDark: '#2c5133',
    pot: '#6b4230',
    metal: '#454a54',
    metalDark: '#2e323a',
    paper: '#c9c6bb',
    shadow: 'rgba(0,0,0,0.35)'
  }
}

const px = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string) => {
  ctx.fillStyle = fill
  ctx.fillRect(x, y, w, h)
}

/**
 * Every tile is drawn from code - no bundled tileset, so nothing here carries
 * an asset licence. It will not match hand-drawn pixel art; what it can do is
 * be consistent, and carry the shading that makes a flat grid read as a room.
 */
function drawCell(ctx: CanvasRenderingContext2D, cell: Cell, p: Palette): void {
  // Only the two ground tiles paint a background. Everything else is drawn on
  // transparency and blitted over whichever ground it stands on - a chair on a
  // rug used to bring its own green square with it.
  if (cell === 'floor' || cell === 'rug') {
    px(ctx, 0, 0, TILE, TILE, cell === 'rug' ? p.rug : p.floor)
    px(ctx, 0, 0, TILE, 1, cell === 'rug' ? p.rugLine : p.floorLine)
    px(ctx, 0, 0, 1, TILE, cell === 'rug' ? p.rugLine : p.floorLine)
    if (cell !== 'rug') px(ctx, TILE / 2 - 1, TILE / 2 - 1, 2, 2, p.floorDot)
    return
  }

  switch (cell) {
    // A doorway. Walkable, but framed - a plain floor tile in a wall run reads
    // as a wall with a piece missing, which is exactly how it was reported.
    case 'door':
      px(ctx, 0, 0, TILE, TILE, p.floor)
      px(ctx, 0, 0, 2, TILE, p.wallTop)
      px(ctx, TILE - 2, 0, 2, TILE, p.wallTop)
      px(ctx, 0, 0, TILE, 2, p.wallEdge)
      px(ctx, 2, 2, TILE - 4, 2, p.shadow)
      px(ctx, 3, TILE - 5, TILE - 6, 3, p.rug)
      px(ctx, 3, TILE - 5, TILE - 6, 1, p.rugLine)
      break

    case 'wall':
      px(ctx, 0, 0, TILE, TILE, p.wallTop)
      px(ctx, 0, TILE - 2, TILE, 2, p.wallEdge)
      // Edges on every side, not just the bottom. A vertical run had no line
      // where it met the floor, so the left and right walls read as open - the
      // room looked like it had no side to it.
      px(ctx, 0, 0, 1, TILE, p.wallEdge)
      px(ctx, TILE - 1, 0, 1, TILE, p.wallEdge)
      px(ctx, 0, 0, TILE, 1, p.wallEdge)
      break

    case 'wallFace':
      // The face below a wall cap. Two tones plus a skirting line is the whole
      // depth cue, and it costs three fillRects.
      px(ctx, 0, 0, TILE, TILE, p.wallFace)
      px(ctx, 0, 0, TILE, 1, p.wallEdge)
      px(ctx, 0, TILE - 3, TILE, 1, p.wallEdge)
      px(ctx, 0, TILE - 2, TILE, 2, p.wallTop)
      break

    // The inner face of a side wall: cap outside, face toward the room, so a
    // vertical run has the same depth the top wall gets from its face row.
    // Mostly face, with a cap on the outer edge - the same way round as the top
    // wall. Drawn mostly cap, the tile came out the colour of the page and the
    // room looked open on that side.
    case 'wallLeft':
      px(ctx, 0, 0, TILE, TILE, p.wallFace)
      px(ctx, 0, 0, 5, TILE, p.wallTop)
      px(ctx, 4, 0, 1, TILE, p.wallEdge)
      px(ctx, TILE - 1, 0, 1, TILE, p.wallEdge)
      break

    case 'wallRight':
      px(ctx, 0, 0, TILE, TILE, p.wallFace)
      px(ctx, TILE - 5, 0, 5, TILE, p.wallTop)
      px(ctx, TILE - 5, 0, 1, TILE, p.wallEdge)
      px(ctx, 0, 0, 1, TILE, p.wallEdge)
      break

    // A screen on a partition, seen from above: the wall cap with a dark panel
    // hung on the room side of it.
    case 'tv':
      px(ctx, 0, 0, TILE, TILE, p.wallTop)
      px(ctx, 0, 0, 1, TILE, p.wallEdge)
      px(ctx, TILE - 1, 0, 1, TILE, p.wallEdge)
      px(ctx, 1, 1, 5, TILE - 2, p.metalDark)
      px(ctx, 2, 2, 3, TILE - 4, p.screen)
      px(ctx, 2, 3, 2, TILE - 7, p.screenGlow)
      break

    case 'window':
      px(ctx, 0, 0, TILE, TILE, p.wallFace)
      px(ctx, 1, 2, TILE - 2, 9, p.glassFrame)
      px(ctx, 2, 3, TILE - 4, 7, p.glass)
      px(ctx, TILE / 2 - 1, 3, 1, 7, p.glassFrame)
      px(ctx, 0, TILE - 2, TILE, 2, p.wallTop)
      break

    case 'clock':
      px(ctx, 0, 0, TILE, TILE, p.wallFace)
      px(ctx, 4, 3, 8, 8, p.metalDark)
      px(ctx, 5, 4, 6, 6, p.paper)
      px(ctx, 8, 5, 1, 3, p.metalDark)
      px(ctx, 8, 7, 3, 1, p.metalDark)
      px(ctx, 0, TILE - 2, TILE, 2, p.wallTop)
      break

    case 'board':
      px(ctx, 0, 0, TILE, TILE, p.wallFace)
      px(ctx, 1, 2, TILE - 2, 9, p.metalDark)
      px(ctx, 2, 3, TILE - 4, 7, p.paper)
      px(ctx, 3, 5, 6, 1, p.glassFrame)
      px(ctx, 3, 7, 9, 1, p.glassFrame)
      px(ctx, 0, TILE - 2, TILE, 2, p.wallTop)
      break

    case 'desk': // faces down: monitor at the back, keyboard toward the seat
      px(ctx, 0, 13, TILE, 2, p.shadow)
      px(ctx, 1, 5, TILE - 2, 8, p.deskTop)
      px(ctx, 1, 12, TILE - 2, 2, p.deskEdge)
      px(ctx, 2, 14, 2, 1, p.deskLeg)
      px(ctx, TILE - 4, 14, 2, 1, p.deskLeg)
      px(ctx, 4, 1, 8, 5, p.screen)
      px(ctx, 5, 2, 6, 3, p.screenGlow)
      px(ctx, 7, 6, 2, 1, p.deskEdge)
      px(ctx, 4, 9, 8, 2, p.metal)
      px(ctx, 12, 10, 2, 1, p.metalDark)
      break

    // The boss desk: wider, darker wood, and it takes the whole tile. It has to
    // be tellable from a pod desk at a glance, which is the only reason it is a
    // separate tile rather than a flag on 'desk'.
    case 'deskBoss':
      px(ctx, 0, 14, TILE, 2, p.shadow)
      px(ctx, 0, 4, TILE, 9, p.bossTop)
      px(ctx, 0, 12, TILE, 3, p.bossEdge)
      px(ctx, 1, 15, 2, 1, p.deskLeg)
      px(ctx, TILE - 3, 15, 2, 1, p.deskLeg)
      px(ctx, 3, 0, 10, 5, p.screen)
      px(ctx, 4, 1, 8, 3, p.screenGlow)
      px(ctx, 7, 5, 2, 1, p.bossEdge)
      px(ctx, 3, 8, 10, 2, p.metal)
      px(ctx, 1, 6, 2, 3, p.paper)
      break

    case 'deskUp': // faces up: the seat is above, so the monitor is at the front
      px(ctx, 0, 13, TILE, 2, p.shadow)
      px(ctx, 1, 3, TILE - 2, 9, p.deskTop)
      px(ctx, 1, 11, TILE - 2, 2, p.deskEdge)
      px(ctx, 2, 13, 2, 1, p.deskLeg)
      px(ctx, TILE - 4, 13, 2, 1, p.deskLeg)
      px(ctx, 4, 6, 8, 5, p.screen)
      px(ctx, 5, 7, 6, 3, p.screenGlow)
      px(ctx, 4, 4, 8, 2, p.metal)
      break

    case 'sofa':
      px(ctx, 0, 3, TILE, 3, p.sofaDark)
      px(ctx, 0, 6, TILE, 6, p.sofa)
      px(ctx, 0, 12, TILE, 2, p.sofaDark)
      px(ctx, 0, 14, TILE, 1, p.shadow)
      break

    case 'coffee':
      px(ctx, 2, 6, TILE - 4, 6, p.table)
      px(ctx, 2, 11, TILE - 4, 2, p.tableEdge)
      px(ctx, 6, 4, 4, 3, p.leaf)
      px(ctx, 3, 13, 1, 2, p.deskLeg)
      px(ctx, TILE - 4, 13, 1, 2, p.deskLeg)
      break

    case 'printer':
      px(ctx, 1, 5, TILE - 2, 8, p.metal)
      px(ctx, 1, 12, TILE - 2, 2, p.metalDark)
      px(ctx, 3, 3, TILE - 6, 3, p.paper)
      px(ctx, 3, 9, TILE - 6, 2, p.metalDark)
      px(ctx, 0, 14, TILE, 1, p.shadow)
      break

    case 'cabinet':
      px(ctx, 1, 2, TILE - 2, 12, p.deskTop)
      px(ctx, 1, 7, TILE - 2, 1, p.deskEdge)
      px(ctx, 1, 13, TILE - 2, 1, p.deskEdge)
      px(ctx, 6, 4, 4, 1, p.metalDark)
      px(ctx, 6, 10, 4, 1, p.metalDark)
      px(ctx, 0, 14, TILE, 1, p.shadow)
      break

    case 'table':
      px(ctx, 0, 2, TILE, 11, p.table)
      px(ctx, 0, 12, TILE, 2, p.tableEdge)
      px(ctx, 0, 14, TILE, 1, p.shadow)
      break

    case 'chairPink':
      px(ctx, 4, 4, 8, 7, p.chairPink)
      px(ctx, 4, 11, 8, 2, p.tableEdge)
      px(ctx, 3, 13, TILE - 6, 1, p.shadow)
      break

    case 'counter':
      px(ctx, 0, 4, TILE, 9, p.metal)
      px(ctx, 0, 4, TILE, 2, p.metalDark)
      px(ctx, 0, 13, TILE, 2, p.metalDark)
      px(ctx, 3, 7, 4, 3, p.glassFrame)
      break

    case 'fridge':
      px(ctx, 2, 1, 12, 13, p.metal)
      px(ctx, 2, 1, 12, 1, p.metalDark)
      px(ctx, 2, 6, 12, 1, p.metalDark)
      px(ctx, 11, 3, 1, 2, p.metalDark)
      px(ctx, 11, 8, 1, 2, p.metalDark)
      break

    case 'shelf':
      px(ctx, 1, 2, TILE - 2, 12, p.deskEdge)
      px(ctx, 1, 6, TILE - 2, 1, p.deskLeg)
      px(ctx, 1, 10, TILE - 2, 1, p.deskLeg)
      px(ctx, 3, 3, 2, 3, p.paper)
      px(ctx, 6, 3, 2, 3, p.chairPink)
      px(ctx, 9, 7, 2, 3, p.glass)
      break

    case 'cooler':
      px(ctx, 5, 1, 6, 5, p.glass)
      px(ctx, 4, 6, 8, 8, p.metal)
      px(ctx, 4, 9, 8, 1, p.metalDark)
      px(ctx, 3, 14, 10, 1, p.shadow)
      break

    case 'plant':
      px(ctx, 5, 14, 6, 1, p.shadow)
      px(ctx, 6, 10, 4, 4, p.pot)
      px(ctx, 6, 10, 4, 1, p.metalDark)
      px(ctx, 5, 6, 6, 4, p.leaf)
      px(ctx, 7, 2, 2, 5, p.leafDark)
      px(ctx, 3, 7, 3, 2, p.leafDark)
      px(ctx, 10, 7, 3, 2, p.leaf)
      break
  }
}

/** A chair on a seat tile, drawn only where an agent actually sits. */
export function drawChair(ctx: CanvasRenderingContext2D, x: number, y: number, p: Palette): void {
  ctx.fillStyle = p.shadow
  ctx.fillRect(x + 3, y + 12, 10, 2)
  ctx.fillStyle = p.chair
  ctx.fillRect(x + 4, y + 4, 8, 6)
  ctx.fillStyle = p.tableEdge
  ctx.fillRect(x + 4, y + 10, 8, 2)
  ctx.fillRect(x + 7, y + 12, 2, 1)
}

const KINDS: Cell[] = [
  'tv',
  'wallLeft',
  'wallRight',
  'door',
  'deskBoss',
  'sofa',
  'coffee',
  'printer',
  'cabinet',
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

/**
 * Pre-render one tile of each kind, then blit. Redrawing the art for every one
 * of ~1500 cells every frame is the obvious way to make a 2D canvas feel slow;
 * this turns a frame into a pile of memcpys.
 */
export function buildAtlas(p: Palette): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = TILE * KINDS.length
  canvas.height = TILE
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false

  KINDS.forEach((kind, i) => {
    ctx.save()
    ctx.translate(i * TILE, 0)
    ctx.beginPath()
    ctx.rect(0, 0, TILE, TILE)
    ctx.clip()
    drawCell(ctx, kind, p)
    ctx.restore()
  })
  return canvas
}

export const ATLAS_INDEX = Object.fromEntries(KINDS.map((k, i) => [k, i])) as Record<Cell, number>
