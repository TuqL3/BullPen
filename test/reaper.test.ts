import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { clearPid, forceKill, processCommand, reapOrphans, writePid } from '../src/main/reaper.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A harmless stand-in for an agent: idles until killed, carrying a marker. */
function decoy(marker: string): ChildProcess {
  return spawn(process.execPath, ['-e', `/*${marker}*/ setInterval(() => {}, 1000)`], {
    stdio: 'ignore'
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('kills an orphan whose command line carries its marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bullpen-reap-'))
  const marker = 'bullpen-marker-alpha'
  const child = decoy(marker)
  await sleep(300)
  assert.ok(alive(child.pid!), 'decoy should be running')

  writePid(join(root, 'michael'), {
    pid: child.pid!,
    marker,
    cwd: root,
    startedAt: Date.now()
  })

  const results = reapOrphans(root)
  await sleep(600)
  forceKill(results)
  await sleep(300)

  assert.deepEqual(
    results.map((r) => r.outcome),
    ['killed']
  )
  assert.equal(alive(child.pid!), false, 'orphan must be dead')
  assert.equal(existsSync(join(root, 'michael', 'pid.json')), false, 'pidfile must be cleared')
  rmSync(root, { recursive: true, force: true })
})

test('refuses to kill a live process whose marker does not match (pid reuse)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bullpen-reap-'))
  const bystander = decoy('some-unrelated-process')
  await sleep(300)

  // A stale pidfile from a previous boot, now pointing at a recycled pid.
  writePid(join(root, 'dwight'), {
    pid: bystander.pid!,
    marker: 'bullpen-marker-that-is-absent',
    cwd: root,
    startedAt: Date.now()
  })

  const results = reapOrphans(root)
  await sleep(400)
  forceKill(results)
  await sleep(200)

  assert.deepEqual(
    results.map((r) => r.outcome),
    ['not-ours'],
    'must classify as not-ours, never kill'
  )
  assert.ok(alive(bystander.pid!), 'an unrelated process must survive untouched')
  bystander.kill('SIGKILL')
  rmSync(root, { recursive: true, force: true })
})

test('a dead pid is reported and cleaned up, not killed again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bullpen-reap-'))
  const child = decoy('bullpen-marker-gone')
  const pid = child.pid!
  child.kill('SIGKILL')
  await sleep(400)

  writePid(join(root, 'jim'), { pid, marker: 'bullpen-marker-gone', cwd: root, startedAt: Date.now() })
  const results = reapOrphans(root)

  assert.deepEqual(
    results.map((r) => r.outcome),
    ['already-gone']
  )
  assert.equal(existsSync(join(root, 'jim', 'pid.json')), false)
  rmSync(root, { recursive: true, force: true })
})

test('agents with no pidfile, or a corrupt one, are skipped quietly', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullpen-reap-'))
  mkdirSync(join(root, 'pam'), { recursive: true })
  mkdirSync(join(root, 'oscar'), { recursive: true })
  writeFileSync(join(root, 'oscar', 'pid.json'), '{ not json')

  assert.deepEqual(reapOrphans(root), [])
  assert.equal(existsSync(join(root, 'oscar', 'pid.json')), true, 'unparseable file is left alone')
  rmSync(root, { recursive: true, force: true })
})

test('a pidfile with a nonsense pid is discarded without a kill attempt', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullpen-reap-'))
  writePid(join(root, 'kevin'), { pid: -1, marker: 'x', cwd: root, startedAt: Date.now() })
  writePid(join(root, 'angela'), { pid: 4242, marker: '', cwd: root, startedAt: Date.now() })

  assert.deepEqual(reapOrphans(root), [])
  assert.equal(existsSync(join(root, 'kevin', 'pid.json')), false)
  assert.equal(existsSync(join(root, 'angela', 'pid.json')), false)
  rmSync(root, { recursive: true, force: true })
})

test('clearPid removes the claim so the next startup reaps nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bullpen-reap-'))
  const child = decoy('bullpen-marker-clean-exit')
  await sleep(300)
  const home = join(root, 'stanley')

  writePid(home, { pid: child.pid!, marker: 'bullpen-marker-clean-exit', cwd: root, startedAt: Date.now() })
  clearPid(home)

  assert.deepEqual(reapOrphans(root), [], 'a cleanly exited agent leaves nothing to reap')
  assert.ok(alive(child.pid!), 'and its pid is never touched')
  child.kill('SIGKILL')
  rmSync(root, { recursive: true, force: true })
})

test('processCommand reads the live command line of our own process', () => {
  const cmd = processCommand(process.pid)
  assert.ok(cmd.length > 0, 'must read something for a process that certainly exists')
  assert.ok(cmd.includes('node') || cmd.includes(process.execPath), `unexpected cmdline: ${cmd}`)
})
