import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { changes, diff, discard, discardBlock, discardHunk, isRepo, stats } from '../src/main/git.ts'
import { blocks, parseDiff } from '../src/diff.ts'

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

/** A repo with one commit, then a modified file, a new file and a deleted one. */
const repo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-git-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'bullpen@test')
  git(dir, 'config', 'user.name', 'Bullpen')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/keep.ts'), 'export const a = 1\n')
  writeFileSync(join(dir, 'src/gone.ts'), 'export const b = 2\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'first')

  writeFileSync(join(dir, 'src/keep.ts'), 'export const a = 2\n')
  writeFileSync(join(dir, 'src/new.ts'), 'export const c = 3\n')
  rmSync(join(dir, 'src/gone.ts'))
  return dir
}

test('a directory that is not a repository says so instead of failing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-nogit-'))
  try {
    assert.equal(await isRepo(dir), false)
    assert.deepEqual(await changes(dir), { repo: false, changes: [] })
    assert.match((await diff(dir, 'anything')).error ?? '', /not a git repository/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('modified, added and deleted files all show up', async () => {
  const dir = repo()
  try {
    const res = await changes(dir)
    assert.equal(res.repo, true)
    const byPath = Object.fromEntries(res.changes.map((c) => [c.path, c.code]))
    assert.equal(byPath['src/keep.ts'], ' M')
    assert.equal(byPath['src/gone.ts'], ' D')
    assert.equal(byPath['src/new.ts'], '??')
    assert.equal(res.changes.find((c) => c.path === 'src/new.ts')?.untracked, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a staged change is still a change, and is marked as staged', async () => {
  const dir = repo()
  try {
    git(dir, 'add', 'src/keep.ts')
    const res = await changes(dir)
    const keep = res.changes.find((c) => c.path === 'src/keep.ts')!
    assert.equal(keep.code, 'M ')
    assert.equal(keep.staged, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the diff shows the change, staged or not', async () => {
  const dir = repo()
  try {
    const unstaged = await diff(dir, 'src/keep.ts')
    assert.match(unstaged.text, /-export const a = 1/)
    assert.match(unstaged.text, /\+export const a = 2/)

    // Staging it must not empty the diff: it is still different from HEAD.
    git(dir, 'add', 'src/keep.ts')
    assert.match((await diff(dir, 'src/keep.ts')).text, /\+export const a = 2/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a brand new file diffs as all-added rather than as nothing', async () => {
  // The file an agent just created is the case that matters most, and it has
  // no HEAD version to compare against.
  const dir = repo()
  try {
    const res = await diff(dir, 'src/new.ts')
    assert.match(res.text, /\+export const c = 3/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a path from the renderer cannot diff outside the workspace', async () => {
  const dir = repo()
  try {
    assert.match((await diff(dir, '../../etc/passwd')).error ?? '', /outside the workspace/)
    assert.match((await diff(dir, '/etc/passwd')).error ?? '', /outside the workspace/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('discarding a tracked file puts it back to HEAD, staged or not', async () => {
  const dir = repo()
  try {
    // Staged as well as unstaged: restoring only the worktree leaves the change
    // in the index, which reads as discarded in the panel and commits anyway.
    git(dir, 'add', 'src/keep.ts')
    writeFileSync(join(dir, 'src/keep.ts'), 'export const a = 3\n')

    assert.deepEqual(await discard(dir, 'src/keep.ts'), { ok: true })
    assert.equal(readFileSync(join(dir, 'src/keep.ts'), 'utf8'), 'export const a = 1\n')
    const after = await changes(dir)
    assert.equal(after.changes.some((c) => c.path === 'src/keep.ts'), false)
    // Nothing else in the workspace may be touched by discarding one file.
    assert.equal(after.changes.some((c) => c.path === 'src/new.ts'), true)
    assert.equal(after.changes.some((c) => c.path === 'src/gone.ts'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('discarding an untracked file deletes it - there is nothing to restore', async () => {
  const dir = repo()
  try {
    assert.deepEqual(await discard(dir, 'src/new.ts'), { ok: true })
    assert.equal(existsSync(join(dir, 'src/new.ts')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a deleted file comes back, and a path outside the workspace is refused', async () => {
  const dir = repo()
  try {
    assert.deepEqual(await discard(dir, 'src/gone.ts'), { ok: true })
    assert.equal(readFileSync(join(dir, 'src/gone.ts'), 'utf8'), 'export const b = 2\n')

    // The renderer supplies the path; escaping the workspace must not be a way
    // to run `git clean` somewhere else.
    const out = await discard(dir, '../../etc/hosts')
    assert.equal(out.ok, undefined)
    assert.ok(out.error)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A file with two changes far enough apart that git emits two hunks. */
const twoHunks = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-hunk-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'bullpen@test')
  git(dir, 'config', 'user.name', 'Bullpen')
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
  writeFileSync(join(dir, 'f.txt'), lines.join('\n') + '\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'first')
  lines[2] = 'CHANGED TOP'
  lines[35] = 'CHANGED BOTTOM'
  writeFileSync(join(dir, 'f.txt'), lines.join('\n') + '\n')
  return dir
}

test('one hunk can be discarded while the rest of the file keeps its changes', async () => {
  const dir = twoHunks()
  try {
    const before = parseDiff((await diff(dir, 'f.txt')).text)
    assert.equal(before.hunks.length, 2, 'the fixture must produce two hunks')

    assert.deepEqual(await discardHunk(dir, 'f.txt', 0, before.hunks[0].marker), { ok: true })

    const text = readFileSync(join(dir, 'f.txt'), 'utf8')
    assert.match(text, /^line 3$/m, 'the discarded hunk went back to HEAD')
    assert.match(text, /CHANGED BOTTOM/, 'the hunk nobody touched is still there')
    assert.equal(parseDiff((await diff(dir, 'f.txt')).text).hunks.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a hunk discard is refused when the panel is out of date', async () => {
  const dir = twoHunks()
  try {
    // The marker the panel is showing no longer matches the hunk at that index:
    // applying anyway would revert some other part of the file.
    const stale = await discardHunk(dir, 'f.txt', 0, '@@ -999,1 +999,1 @@')
    assert.equal(stale.ok, undefined)
    assert.match(stale.error ?? '', /changed under the panel/)
    assert.match(readFileSync(join(dir, 'f.txt'), 'utf8'), /CHANGED TOP/, 'nothing was reverted')

    const gone = await discardHunk(dir, 'f.txt', 9, '@@ -1,1 +1,1 @@')
    assert.match(gone.error ?? '', /hunk is gone/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an untracked file has no hunk to revert to, and says so', async () => {
  const dir = repo()
  try {
    const out = await discardHunk(dir, 'src/new.ts', 0, '@@ -0,0 +1,1 @@')
    assert.equal(out.ok, undefined)
    assert.match(out.error ?? '', /not tracked/)
    assert.equal(existsSync(join(dir, 'src/new.ts')), true, 'and it is left alone')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('per-file counts change when a file does - that is what the panel polls', async () => {
  const dir = repo()
  try {
    const before = await stats(dir)
    // Tracked and modified: the review panel compares this to decide whether the
    // diff it is showing is still the truth.
    assert.equal(before['src/keep.ts'], '1-1')
    // Untracked files have no numstat, which is why the panel always re-reads
    // them rather than trusting a comparison it cannot make.
    assert.equal('src/new.ts' in before, false)

    writeFileSync(join(dir, 'src/keep.ts'), 'export const a = 2\nexport const d = 4\n')
    const after = await stats(dir)
    assert.notEqual(after['src/keep.ts'], before['src/keep.ts'])

    assert.deepEqual(await stats(mkdtempSync(join(tmpdir(), 'bp-norepo-'))), {}, 'no repo, no counts')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Two edits three lines apart: git puts them in ONE hunk. */
const oneHunkTwoBlocks = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-block-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'bullpen@test')
  git(dir, 'config', 'user.name', 'Bullpen')
  writeFileSync(join(dir, 'f.txt'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n') + '\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'first')
  writeFileSync(
    join(dir, 'f.txt'),
    ['a', 'KEEP ME', 'b', 'c', 'd', 'e', 'DROP ME', 'f', 'g', 'h'].join('\n') + '\n'
  )
  return dir
}

test('one block goes back while the other, in the same hunk, stays', async () => {
  const dir = oneHunkTwoBlocks()
  try {
    const parsed = parseDiff((await diff(dir, 'f.txt')).text)
    assert.equal(parsed.hunks.length, 1, 'git merged both edits into one hunk')
    const runs = blocks(parsed)
    assert.equal(runs.length, 2, 'but they are two runs of touching lines')

    // Discard the second run only. Reverting the hunk would take both, which is
    // what "I clicked one line and lost the file" looked like.
    assert.deepEqual(await discardBlock(dir, 'f.txt', 0, 1, parsed.hunks[0].marker), { ok: true })

    const text = readFileSync(join(dir, 'f.txt'), 'utf8')
    assert.match(text, /KEEP ME/, 'the run nobody pointed at is untouched')
    assert.equal(/DROP ME/.test(text), false, 'the run that was pointed at is gone')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale panel cannot revert a block, and an untracked file has none', async () => {
  const dir = oneHunkTwoBlocks()
  try {
    const stale = await discardBlock(dir, 'f.txt', 0, 0, '@@ -999,1 +999,1 @@')
    assert.match(stale.error ?? '', /changed under the panel/)
    assert.match(readFileSync(join(dir, 'f.txt'), 'utf8'), /KEEP ME/, 'nothing was applied')

    const gone = await discardBlock(dir, 'f.txt', 0, 9, parseDiff((await diff(dir, 'f.txt')).text).hunks[0].marker)
    assert.match(gone.error ?? '', /block is gone/)

    writeFileSync(join(dir, 'fresh.txt'), 'new\n')
    const untracked = await discardBlock(dir, 'fresh.txt', 0, 0, '@@ -0,0 +1,1 @@')
    assert.match(untracked.error ?? '', /not tracked/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
