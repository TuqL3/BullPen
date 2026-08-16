import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { changes, diff, isRepo } from '../src/main/git.ts'

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
