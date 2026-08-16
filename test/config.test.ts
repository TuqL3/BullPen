import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkWorkspace, configPath, readConfig, writeConfig } from '../src/main/config.ts'

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
