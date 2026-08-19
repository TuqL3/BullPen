import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkWorkspace, configPath, mergeUi, readConfig, writeConfig } from '../src/main/config.ts'

const home = (): string => mkdtempSync(join(tmpdir(), 'bp-cfg-'))

test('a chosen workspace survives a restart', () => {
  const dir = home()
  try {
    assert.deepEqual(readConfig(dir), {})
    writeConfig(dir, { godCwd: '/srv/michael' })
    assert.equal(readConfig(dir).godCwd, '/srv/michael')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt or empty config falls back to the default rather than throwing', () => {
  const dir = home()
  try {
    writeFileSync(configPath(dir), '{ not json')
    assert.deepEqual(readConfig(dir), {})
    writeFileSync(configPath(dir), JSON.stringify({ godCwd: '   ' }))
    assert.deepEqual(readConfig(dir), {})
    writeFileSync(configPath(dir), JSON.stringify({ godCwd: 42 }))
    assert.deepEqual(readConfig(dir), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a resized window survives a restart, and a nonsense one does not', () => {
  const dir = home()
  try {
    writeConfig(dir, { window: { width: 1234, height: 987, x: 40, y: 80, maximized: true } })
    assert.deepEqual(readConfig(dir).window, {
      width: 1234,
      height: 987,
      x: 40,
      y: 80,
      maximized: true
    })

    // Position is all-or-nothing: half a coordinate cannot place a window.
    writeFileSync(configPath(dir), JSON.stringify({ window: { width: 1400, height: 900, x: 10 } }))
    assert.deepEqual(readConfig(dir).window, { width: 1400, height: 900 })

    // A window too small to use, or one whose size is not a number, is dropped
    // rather than restored - it would open unusable and look like a crash.
    for (const bad of [
      { width: 20, height: 20 },
      { width: '1400', height: 900 },
      { width: Number.NaN, height: 900 },
      null
    ]) {
      writeFileSync(configPath(dir), JSON.stringify({ window: bad }))
      assert.equal(readConfig(dir).window, undefined, JSON.stringify(bad))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the two directories that would make a sandbox meaningless are refused', () => {
  const dir = home()
  try {
    assert.match(checkWorkspace('/', dir) ?? '', /refusing/)
    assert.match(checkWorkspace(dir, dir) ?? '', /refusing/)
    // A directory that does not exist yet is fine - it gets created - but its
    // parent has to be real, or the pick was a typo.
    assert.equal(checkWorkspace(join(dir, 'michael'), dir), null)
    assert.match(checkWorkspace('/nope/nope/michael', dir) ?? '', /does not exist/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * `readConfig` is an allowlist, and a field missing from it is a setting that
 * saves and never comes back. That is exactly what happened to the workflow:
 * applied, written to disk, and dropped on the way in - so the floor survived a
 * reload of the window and not a restart of the app, with nothing to see.
 */
test('the settings that outlive a run actually come back', () => {
  const home = mkdtempSync(join(tmpdir(), 'bp-cfg-'))
  try {
    writeConfig(home, {
      godCwd: home,
      workflow: { name: 'mine', roles: { boss: {} } },
      ui: { fontSize: 16, floor: 'slate' },
      notify: false
    })
    const back = readConfig(home)
    assert.deepEqual(back.workflow, { name: 'mine', roles: { boss: {} } })
    assert.deepEqual(back.ui, { fontSize: 16, floor: 'slate' })
    assert.equal(back.notify, false)

    // Nonsense in either is dropped rather than handed on: a font size of "big"
    // would reach xterm, and a floor of 0 would reach the palette lookup.
    writeConfig(home, { ui: { fontSize: 'big', floor: '  ' } } as never)
    assert.equal(readConfig(home).ui, undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/**
 * The chart is panned and zoomed now, and where somebody left it is theirs -
 * reopening the dialog to find the drawing back at 1:1 in the corner is the
 * same complaint as finding the boxes re-laid-out.
 */
test('how the chart is being looked at survives a restart', () => {
  const home = mkdtempSync(join(tmpdir(), 'bullpen-view-'))
  writeConfig(home, {
    ui: {
      fontSize: 13,
      chart: { kitchen: { cook: { x: 10, y: 20 } } },
      view: { kitchen: { k: 1.4, tx: -30, ty: 12 } }
    }
  })
  const back = readConfig(home)
  assert.deepEqual(back.ui?.view, { kitchen: { k: 1.4, tx: -30, ty: 12 } })
  assert.deepEqual(back.ui?.chart, { kitchen: { cook: { x: 10, y: 20 } } })
  rmSync(home, { recursive: true, force: true })
})

/** A shipped floor has no file to delete, so "remove" is a note in the config. */
test('floors taken off the list survive a restart', () => {
  const home = mkdtempSync(join(tmpdir(), 'bullpen-hide-'))
  writeConfig(home, { ui: { hidden: ['solo', 'qa-lead'] } })
  assert.deepEqual(readConfig(home).ui?.hidden, ['solo', 'qa-lead'])

  // Junk in the list is dropped rather than carried into the UI.
  writeConfig(home, { ui: { hidden: ['solo', '', 42 as unknown as string] } })
  assert.deepEqual(readConfig(home).ui?.hidden, ['solo'])
  rmSync(home, { recursive: true, force: true })
})


test('a ui preference nobody named survives one that is set', () => {
  // Removing a shipped floor is a note in `ui.hidden` - it has no file to
  // delete. The prefs handler rebuilt `ui` from the four fields it knew about,
  // so changing the font size, or dragging one box on the chart, put every
  // removed floor back on the list without a word.
  const current = {
    fontSize: 12.5,
    floor: 'green',
    hidden: ['analyst-chain', 'solo'],
    chart: { 'floor-a': { boss: { x: 1, y: 2 } } },
    view: { 'floor-a': { k: 1, tx: 0, ty: 0 } }
  }

  const bigger = mergeUi(current, { fontSize: 16 })
  assert.deepEqual(bigger.hidden, ['analyst-chain', 'solo'], 'still removed')
  assert.equal(bigger.fontSize, 16)
  assert.equal(bigger.floor, 'green', 'and untouched fields keep their value')

  // One floor's chart saved does not wipe another's, and hidden still stands.
  const moved = mergeUi(current, { chart: { 'floor-b': { boss: { x: 9, y: 9 } } } })
  assert.deepEqual(Object.keys(moved.chart ?? {}).sort(), ['floor-a', 'floor-b'])
  assert.deepEqual(moved.hidden, ['analyst-chain', 'solo'])
  assert.deepEqual(moved.view, current.view)

  // Out-of-range font sizes are still clamped rather than trusted.
  assert.equal(mergeUi(current, { fontSize: 400 }).fontSize, 24)
  assert.equal(mergeUi(current, { fontSize: 1 }).fontSize, 9)
  assert.equal(mergeUi(undefined, {}).floor, 'green')
})
