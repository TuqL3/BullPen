import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The pixel size macOS reads out of each PNG-carrying icns slot. */
const SLOT_SIZE: Record<string, number> = {
  icp4: 16,
  icp5: 32,
  icp6: 64,
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
  ic11: 32,
  ic12: 64,
  ic13: 256,
  ic14: 512
}

/** Every element in the icns, with the real size of the PNG inside it. */
function slots(icns: Buffer): { type: string; png: number | null }[] {
  const out: { type: string; png: number | null }[] = []
  let p = 8 // 4-byte magic + 4-byte file length
  while (p + 8 <= icns.length) {
    const type = icns.toString('ascii', p, p + 4)
    const len = icns.readUInt32BE(p + 4)
    if (len < 8) break
    const data = icns.subarray(p + 8, p + len)
    // IHDR width sits 16 bytes in: 8-byte signature + 8-byte chunk header.
    const png = data.subarray(0, 8).equals(PNG_MAGIC) ? data.readUInt32BE(16) : null
    out.push({ type, png })
    p += len
  }
  return out
}

/**
 * electron-builder's converter wrote 512px into ic13 and 1024px into ic14 -
 * slots macOS reads as 256 and 512 - and the Dock drew those as RGB noise. The
 * committed icns is built by iconutil instead; this is what says it still is.
 */
test('every icns slot holds a PNG of the size macOS expects there', () => {
  const icns = readFileSync(join(import.meta.dirname, '../build/icon.icns'))
  assert.equal(icns.toString('ascii', 0, 4), 'icns')

  const found = slots(icns)
  for (const { type, png } of found) {
    const expected = SLOT_SIZE[type]
    if (expected == null || png == null) continue
    assert.equal(png, expected, `${type} holds a ${png}px PNG, macOS reads it as ${expected}px`)
  }

  // A file that carried no PNG slots at all would pass the loop above vacuously.
  const retina = found.filter((s) => s.type === 'ic13' || s.type === 'ic14')
  assert.equal(retina.length, 2, 'the two slots that were wrong must both be present')
})
