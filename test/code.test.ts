import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inside, list, read, search, write } from '../src/main/code.ts'

const workspace = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-code-'))
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'node_modules'))
  writeFileSync(join(dir, 'src/main.ts'), 'export const x = 1\n')
  writeFileSync(join(dir, 'README.md'), '# hi\n')
  writeFileSync(join(dir, 'node_modules/junk.js'), 'nope')
  mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, '.git/HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(dir, '.claude'))
  writeFileSync(join(dir, '.claude/notes.md'), 'plans\n')
  writeFileSync(join(dir, '.env'), 'TOKEN=x\n')
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
    // Dotfiles are listed - they are edited, and the review panel reports
    // changes to them, so a tree that hid them could not open what it showed.
    // `.git` and node_modules are not: machinery and other people's code.
    assert.deepEqual(names, ['.claude', 'src', '.env', 'README.md'])
    assert.deepEqual(list(dir, '.claude').map((e) => e.name), ['notes.md'])
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

test('search finds every line, in every file, and says how many files that was', () => {
  const dir = workspace()
  try {
    writeFileSync(join(dir, 'src/api.ts'), 'const api = 1\n// API again\nconst other = 2\n')
    writeFileSync(join(dir, 'node_modules/junk.js'), 'api api api')

    const r = search(dir, 'api')
    // Case-insensitive by default, and node_modules is not the agent's code.
    assert.deepEqual(
      r.hits.map((h) => [h.path, h.line]),
      [['src/api.ts', 1], ['src/api.ts', 2]]
    )
    assert.equal(r.files, 1)
    assert.equal(r.total, 2, 'every match is counted, not just the ones returned')
    assert.equal(r.capped, false)
    assert.equal(r.timedOut, false)

    assert.equal(search(dir, 'API', { caseSensitive: true }).hits.length, 1)
    assert.deepEqual(search(dir, '   ').hits, [], 'a blank query searches nothing')
    assert.deepEqual(search(dir, 'nothinghere').hits, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search skips binaries and reports the line, not the file', () => {
  const dir = workspace()
  try {
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x61, 0x70, 0x69]))
    writeFileSync(join(dir, 'long.txt'), 'x'.repeat(900) + 'api\n')

    const r = search(dir, 'api')
    assert.equal(r.hits.some((h) => h.path === 'logo.png'), false, 'a NUL byte means not text')
    const long = r.hits.find((h) => h.path === 'long.txt')!
    assert.ok(long.text.length <= 300, 'a minified line is one line, and it is not shown whole')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('regex mode matches patterns, and says when the pattern is broken', () => {
  const dir = workspace()
  try {
    writeFileSync(join(dir, 'src/api.ts'), 'getUser()\ngetOrder()\nsetUser()\n')

    const r = search(dir, 'get[A-Z]\\w+', { regex: true })
    assert.deepEqual(r.hits.map((h) => h.line), [1, 2])
    // Case still folds unless asked otherwise, in regex mode too.
    assert.equal(search(dir, 'GETUSER', { regex: true }).hits.length, 1)
    assert.equal(search(dir, 'GETUSER', { regex: true, caseSensitive: true }).hits.length, 0)

    // A half-typed pattern is the normal state of a regex box.
    const bad = search(dir, 'get(', { regex: true })
    assert.ok(bad.error)
    assert.deepEqual(bad.hits, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a hit carries where it matched, so the panel highlights the right characters', () => {
  const dir = workspace()
  try {
    writeFileSync(join(dir, 'src/api.ts'), 'const api = apiClient(API_KEY)\n')

    const [hit] = search(dir, 'api').hits
    // Every occurrence on the line, case folded, in order.
    assert.deepEqual(hit.ranges, [[6, 9], [12, 15], [22, 25]])
    for (const [a, b] of hit.ranges) {
      assert.equal(hit.text.slice(a, b).toLowerCase(), 'api')
    }

    const [rx] = search(dir, 'api\\w*', { regex: true }).hits
    assert.equal(rx.text.slice(rx.ranges[1][0], rx.ranges[1][1]), 'apiClient')

    // A pattern that can match nothing must not spin on the same index.
    const empty = search(dir, 'x*', { regex: true })
    assert.ok(empty.hits.length >= 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('past the display cap the count keeps going - a short list is not a wrong number', () => {
  const dir = workspace()
  try {
    // More matches than the panel is handed rows for.
    writeFileSync(join(dir, 'src/many.ts'), Array.from({ length: 1500 }, () => 'api').join('\n'))

    const r = search(dir, 'api')
    assert.equal(r.hits.length, 1000, 'the rows stop')
    assert.equal(r.total, 1500, 'the counting does not')
    assert.equal(r.capped, true)
    assert.equal(r.files, 1)
    // The file list is complete even when the rows are not, and each entry
    // carries its own count - that is what the panel lists.
    assert.deepEqual(r.matched, [{ path: 'src/many.ts', count: 1500 }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file too big for the editor is still searched', () => {
  const dir = workspace()
  try {
    // Lock files and bundles are exactly what a workspace search is for, and
    // they are exactly what the editor refuses to open. One limit for both
    // silently dropped two thirds of the matches in a real repo.
    writeFileSync(join(dir, 'yarn.lock'), 'x'.repeat(1_200_000) + '\napi\n')
    const r = search(dir, 'api')
    assert.equal(r.hits.some((h) => h.path === 'yarn.lock'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one file can be searched on its own, with the same matcher', () => {
  const dir = workspace()
  try {
    writeFileSync(join(dir, 'src/a.ts'), 'api one\napi two\n')
    writeFileSync(join(dir, 'src/b.ts'), 'api three\n')

    // How the panel fetches the lines of a file whose rows fell past the cap.
    const one = search(dir, 'api', { only: ['src/b.ts'] })
    assert.deepEqual(one.hits.map((h) => [h.path, h.line]), [['src/b.ts', 1]])
    assert.equal(one.files, 1)
    assert.deepEqual(one.matched, [{ path: 'src/b.ts', count: 1 }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
