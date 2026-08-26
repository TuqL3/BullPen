/**
 * Generate build/icon.png - the app icon, from the same procedural bust the
 * roster draws.
 *
 * Generated rather than drawn for the reason in roster.ts: no bundled art means
 * no licence to honour. Run it again after changing the palette:
 *
 *   node --experimental-strip-types scripts/make-icon.ts
 *
 * electron-builder picks up build/icon.png on its own (buildResources: build)
 * and derives the .ico from it. The .icns is NOT derived - it is committed as
 * build/icon.icns and pinned in electron-builder.config.mjs, because the
 * converter fills two of the retina slots wrong. Regenerate it alongside this
 * file with the iconutil recipe in that config's `mac.icon` comment.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { faceFor } from '../src/renderer/src/roster.ts'

const SIZE = 1024
/** 3 pad + 12 bust + 2 gutter + 12 bust + 3 pad, so every cell is a whole 32px. */
const GRID = 32
const CELL = SIZE / GRID
/** macOS rounds its own icons off at roughly this fraction of the side. */
const RADIUS = SIZE * 0.22

const BG = [0xf4, 0xef, 0xe4]

/**
 * Four agents, not one: the app is a roster, and a single bust reads as a
 * profile picture. Seeds chosen for contrast at dock size - hair, skin and
 * shirt all differ, because at 32px that is all anyone can tell apart.
 */
const CREW: { seed: string; x: number; y: number }[] = [
  { seed: 'agent', x: 3, y: 3 },
  { seed: 'floor', x: 17, y: 3 },
  { seed: 'dwight', x: 3, y: 17 },
  { seed: 'jim', x: 17, y: 17 }
]

const rgb = (hex: string): number[] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
]

/** Inside the rounded square? Corners fall outside and stay transparent. */
function opaque(x: number, y: number): boolean {
  const cx = x < RADIUS ? RADIUS : x > SIZE - RADIUS ? SIZE - RADIUS : x
  const cy = y < RADIUS ? RADIUS : y > SIZE - RADIUS ? SIZE - RADIUS : y
  return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2
}

function render(): Buffer {
  const crew = CREW.map((c) => ({ ...c, ...faceFor(c.seed) }))
  const px = Buffer.alloc(SIZE * (SIZE * 4 + 1))

  /** Whichever bust covers this cell, if any. */
  const cellColour = (gx: number, gy: number): number[] => {
    for (const c of crew) {
      const ch = c.grid[gy - c.y]?.[gx - c.x] ?? '.'
      if (ch !== '.') return rgb(c.colors[ch])
    }
    return BG
  }

  for (let y = 0; y < SIZE; y++) {
    const row = y * (SIZE * 4 + 1)
    px[row] = 0 // filter: none
    const gy = Math.floor(y / CELL)
    for (let x = 0; x < SIZE; x++) {
      const colour = cellColour(Math.floor(x / CELL), gy)
      const i = row + 1 + x * 4
      px[i] = colour[0]
      px[i + 1] = colour[1]
      px[i + 2] = colour[2]
      px[i + 3] = opaque(x + 0.5, y + 0.5) ? 255 : 0
    }
  }
  return px
}

const CRC = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})

function crc32(buf: Buffer): number {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}

function png(pixels: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const out = join(import.meta.dirname, '../build/icon.png')
mkdirSync(join(import.meta.dirname, '../build'), { recursive: true })
writeFileSync(out, png(render()))
console.log(`wrote ${out} (${SIZE}x${SIZE})`)
