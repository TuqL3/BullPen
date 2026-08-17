import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blockPatch, blocks, parseDiff } from '../src/diff.ts'

const SAMPLE = `diff --git a/src/app.ts b/src/app.ts
index 6fd87da..6c7e577 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -20,6 +20,7 @@ export default {
   'write_files',
   'read_publications',
   'read_locales',
+  'read_markets_home',
   'write_locales',
-  'read_markets',
   'write_markets',
`

test('the plumbing is dropped and only the change is left', () => {
  const d = parseDiff(SAMPLE)
  assert.equal(d.hunks.length, 1)
  assert.equal(d.adds, 1)
  assert.equal(d.dels, 1)
  // Nothing from `diff --git`, `index`, `---` or `+++` may reach a row: they
  // are the parts of git's output that say nothing about what changed.
  const text = d.hunks[0].lines.map((l) => l.text).join('\n')
  assert.equal(/diff --git|^index |^--- |^\+\+\+ /m.test(text), false)
})

test('every row carries the line number it has in the file', () => {
  const [h] = parseDiff(SAMPLE).hunks
  assert.equal(h.context, 'export default {')
  // Kept verbatim so a single-hunk discard can be checked against a fresh diff
  // before anything is reverted.
  assert.equal(h.marker, '@@ -20,6 +20,7 @@')
  assert.deepEqual(
    h.lines.map((l) => [l.kind, l.old, l.new, l.text.trim()]),
    [
      ['ctx', 20, 20, `'write_files',`],
      ['ctx', 21, 21, `'read_publications',`],
      ['ctx', 22, 22, `'read_locales',`],
      // An added line has no number in the old file, a deleted one none in the
      // new: numbering both would put the reader on a line that is not there.
      ['add', undefined, 23, `'read_markets_home',`],
      ['ctx', 23, 24, `'write_locales',`],
      ['del', 24, undefined, `'read_markets',`],
      ['ctx', 25, 25, `'write_markets',`]
    ]
  )
})

test('the gap between hunks is counted, so the panel can say what it skipped', () => {
  const two = `--- a/x
+++ b/x
@@ -1,2 +1,2 @@
 one
-two
+TWO
@@ -40,2 +40,2 @@ fn main
 forty
-forty one
+FORTY ONE
`
  const d = parseDiff(two)
  assert.equal(d.hunks.length, 2)
  assert.equal(d.hunks[0].skipped, 0, 'the first hunk starts at the top of the file')
  assert.equal(d.hunks[1].skipped, 37, 'lines 3..39 are not shown')
  assert.equal(d.hunks[1].context, 'fn main')
})

test('an empty or header-only diff parses to nothing rather than throwing', () => {
  assert.deepEqual(parseDiff(''), { hunks: [], adds: 0, dels: 0 })
  assert.deepEqual(parseDiff('diff --git a/x b/x\nindex 1..2 100644\n'), {
    hunks: [],
    adds: 0,
    dels: 0
  })
  // A binary file has no lines to show, and must not be reported as a change.
  assert.equal(parseDiff('Binary files a/logo.png and b/logo.png differ').hunks.length, 0)
})

test('a line that is empty in the file stays a line', () => {
  const d = parseDiff(`@@ -1,3 +1,3 @@\n a\n\n-b\n+B\n`)
  assert.deepEqual(
    d.hunks[0].lines.map((l) => [l.kind, l.text]),
    [
      ['ctx', 'a'],
      ['ctx', ''],
      ['del', 'b'],
      ['add', 'B']
    ]
  )
})

/** One hunk holding two separate runs of changed lines. */
const TWO_BLOCKS = `--- a/f.js
+++ b/f.js
@@ -20,8 +20,10 @@ export default {
   'read_publications',
   'read_locales',
+  'read_markets_home',
   'write_locales',
   'read_markets',
   'write_markets',
+  'write_translations',
+  'test'
 ]
`

test('a hunk is split into the runs of lines that actually touch', () => {
  const d = parseDiff(TWO_BLOCKS)
  assert.equal(d.hunks.length, 1, 'git put both changes in one hunk')
  const bs = blocks(d)
  assert.deepEqual(
    bs.map((b) => b.lines),
    [1, 2],
    'one line in the first run, two in the second'
  )
  assert.deepEqual(bs.map((b) => b.hunk), [0, 0])
})

test('a block patch removes that run and nothing else', () => {
  const d = parseDiff(TWO_BLOCKS)
  const patch = blockPatch(d, blocks(d)[0], 'f.js')!
  const body = patch.split('\n')

  // Written against the file as it is now and applied forwards: the added line
  // becomes a deletion, everything else in range is context.
  assert.equal(body.filter((l) => l.startsWith('-') && !l.startsWith('---')).length, 1)
  assert.match(patch, /^-  'read_markets_home',$/m)
  assert.equal(/write_translations/.test(patch), false, 'the far block is out of range entirely')
})

test('a change close enough to be in range is carried as context, not reverted', () => {
  // Two runs three lines apart, so the second falls inside the first patch's
  // context. Its lines are in the file already, so they must go in as context -
  // marking them for deletion would revert work nobody pointed at.
  const near = `--- a/f.js
+++ b/f.js
@@ -1,5 +1,7 @@
 a
+ADDED ONE
 b
-OLD c
+NEW c
 d
`
  const d = parseDiff(near)
  const bs = blocks(d)
  assert.equal(bs.length, 2)
  const patch = blockPatch(d, bs[0], 'f.js')!
  assert.match(patch, /^-ADDED ONE$/m, 'the block being reverted')
  assert.match(patch, /^ NEW c$/m, 'the other block, as it is in the file now')
  assert.equal(/^[-+]NEW c$/m.test(patch), false)
  assert.equal(/OLD c/.test(patch), false, 'a line that is not in the file cannot be context')
})

test('a block patch counts its own lines, or git refuses it', () => {
  const d = parseDiff(TWO_BLOCKS)
  for (const b of blocks(d)) {
    const patch = blockPatch(d, b, 'f.js')!
    const m = /@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(patch)!
    const body = patch.split('\n').slice(3).filter((l) => l !== '')
    assert.equal(Number(m[2]), body.filter((l) => l.startsWith(' ') || l.startsWith('-')).length)
    assert.equal(Number(m[4]), body.filter((l) => l.startsWith(' ') || l.startsWith('+')).length)
    assert.equal(m[1], m[3], 'both sides start at the same line of the current file')
  }
})
