import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConfig, writeConfig } from '../src/main/config.ts'
import { adopt, bundle, isBundle, newer, sharedOf, withShared, type Bundle } from '../src/main/sync.ts'

const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-sync-'))
  mkdirSync(join(dir, 'workflows'))
  return dir
}

const floor = (dir: string, name: string, text: string): void =>
  writeFileSync(join(dir, 'workflows', name), text, 'utf8')

/**
 * The split is the feature. A machine that took the other one's `godCwd` spawns
 * agents into a directory that does not exist on it, and a `webhook.token` in a
 * gist is a secret in a gist.
 */
test('only the settings that mean the same thing anywhere are shared', () => {
  const c = {
    godCwd: '/Users/lukas/Projects/seo',
    layout: { columns: 3 },
    window: { width: 1400, height: 900 },
    webhook: { enabled: true, port: 4319, token: 'a-real-secret-token' },
    mode: 'dark' as const,
    notify: false,
    workflow: { name: 'default' },
    ui: { fontSize: 13, floor: 'green', chart: { default: { boss: { x: 1, y: 2 } } }, view: { default: { k: 2, tx: 0, ty: 0 } } }
  } as Parameters<typeof sharedOf>[0]

  const s = sharedOf(c)
  assert.deepEqual(Object.keys(s).sort(), ['mode', 'notify', 'ui'])
  assert.deepEqual(Object.keys(s.ui ?? {}).sort(), ['chart', 'floor', 'fontSize'])
  const flat = JSON.stringify(s)
  for (const secret of ['a-real-secret-token', '/Users/lukas/Projects/seo', '4319', '1400']) {
    assert.ok(!flat.includes(secret), `${secret} does not go over the wire`)
  }

  // And folding it back keeps everything this machine said about itself.
  const back = withShared({ ...c, mode: 'light' }, s)
  assert.equal(back.godCwd, '/Users/lukas/Projects/seo')
  assert.equal(back.webhook?.token, 'a-real-secret-token')
  assert.equal(back.mode, 'dark', 'the shared half wins where they overlap')
  assert.deepEqual(back.ui?.view, c.ui?.view, 'where this screen was looking is not touched')
  assert.equal(back.ui?.fontSize, 13)
})

/** Last write wins, and a tie is not a write. */
test('the newer bundle is the one to keep, and a tie changes nothing', () => {
  const b = (at: number): Bundle => ({ at, from: 'x', floors: {}, shared: {} })
  assert.equal(newer(b(10), b(20)), 'there')
  assert.equal(newer(b(20), b(10)), 'here')
  assert.equal(newer(b(10), b(10)), 'here')
})

test('a floor written here goes into the bundle, and one from there lands on disk', () => {
  const dir = home()
  try {
    writeConfig(dir, { mode: 'dark', ui: { fontSize: 14 } })
    floor(dir, 'mine.md', '# mine\n')

    const out = bundle(dir, 'laptop')
    assert.equal(out.from, 'laptop')
    assert.ok(out.at > 0, 'the newest thing this machine has')
    assert.deepEqual(Object.keys(out.floors), ['mine.md'])
    assert.equal(out.shared.mode, 'dark')

    // The other machine's set replaces this one's, deletions included.
    const there: Bundle = {
      at: out.at + 1000,
      from: 'desktop',
      floors: { 'theirs.md': '# theirs\n' },
      shared: { mode: 'light', ui: { fontSize: 11 } }
    }
    const done = adopt(dir, there)
    assert.deepEqual(done, { floors: 1, dropped: ['mine.md'] })
    assert.ok(!existsSync(join(dir, 'workflows', 'mine.md')))
    assert.equal(readFileSync(join(dir, 'workflows', 'theirs.md'), 'utf8'), '# theirs\n')
    assert.equal(readConfig(dir).mode, 'light')
    assert.equal(readConfig(dir).ui?.fontSize, 11)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The names arrive over the network. One of them being `../../.ssh/config` is a
 * write anywhere on the disk, done by a machine that only asked to sync.
 */
test('a floor name that is not a floor name is not written', () => {
  const dir = home()
  try {
    writeConfig(dir, {})
    adopt(dir, {
      at: 1,
      from: 'somebody',
      floors: {
        '../escaped.md': '# no\n',
        'ok.md': '# yes\n',
        'not-markdown.txt': 'no',
        'sub/dir.md': '# no\n'
      },
      shared: {}
    })
    assert.deepEqual([...Object.keys(bundle(dir, 'x').floors)], ['ok.md'])
    assert.ok(!existsSync(join(dir, 'escaped.md')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** What comes back is JSON somebody else wrote. */
test('what is not a bundle is refused before it is read', () => {
  assert.equal(isBundle({ at: 1, from: 'x', floors: {}, shared: {} }), true)
  assert.equal(isBundle(null), false)
  assert.equal(isBundle({ at: 'soon', from: 'x', floors: {}, shared: {} }), false)
  assert.equal(isBundle({ at: 1, from: 'x', shared: {} }), false)
  assert.equal(isBundle({ at: 1, from: 'x', floors: { 'a.md': 3 }, shared: {} }), false)
})
