import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inside, list, read, write } from '../src/main/code.ts'

const workspace = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-code-'))
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'node_modules'))
  writeFileSync(join(dir, 'src/main.ts'), 'export const x = 1\n')
  writeFileSync(join(dir, 'README.md'), '# hi\n')
  writeFileSync(join(dir, 'node_modules/junk.js'), 'nope')
  return dir
}

test('a path from the renderer cannot reach outside the workspace', () => {
  const dir = workspace()
  try {
    assert.throws(() => inside(dir, '../../etc/passwd'), /outside the workspace/)
    assert.throws(() => inside(dir, '/etc/passwd'), /outside the workspace/)
    assert.throws(() => read(dir, '../..'), /outside the workspace/)
    // A path that merely looks like an escape but stays inside is fine.
    assert.equal(inside(dir, 'src/../README.md'), join(dir, 'README.md'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listing skips what nobody opens a code panel to read', () => {
  const dir = workspace()
  try {
    const names = list(dir).map((e) => e.name)
    assert.deepEqual(names, ['src', 'README.md'])
    assert.equal(list(dir, 'src')[0].path, 'src/main.ts')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a binary file reports itself instead of arriving as mojibake', () => {
  const dir = workspace()
  try {
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    const png = read(dir, 'logo.png')
    assert.equal(png.binary, true)
    assert.equal(png.text, '')
    assert.equal(read(dir, 'README.md').binary, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a save lands in the file that was opened, and nowhere else', () => {
  const dir = workspace()
  try {
    write(dir, 'src/main.ts', 'export const x = 2\n')
    assert.equal(read(dir, 'src/main.ts').text, 'export const x = 2\n')
    assert.throws(() => write(dir, '../escape.ts', 'nope'), /outside the workspace/)
    assert.throws(() => write(dir, 'src', 'nope'), /is a directory/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
