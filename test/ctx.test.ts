import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { TAIL_BYTES, cleanEnv, limitForModel, loginShellPath, mergePath, pathFromShell, readCtx, usageFromLine } from '../src/main/ctx.ts'

const assistant = (model: string, u: Record<string, unknown>): string =>
  JSON.stringify({ type: 'assistant', message: { model, usage: u } })

// Shape taken from a real transcript, not invented.
const REAL = {
  input_tokens: 2,
  cache_creation_input_tokens: 136,
  cache_read_input_tokens: 84548,
  output_tokens: 929,
  output_tokens_details: { thinking_tokens: 40 },
  service_tier: 'standard'
}

test('context is the prompt the model read, not what it wrote', () => {
  const ctx = usageFromLine(assistant('claude-opus-5', REAL))!
  // 2 + 136 + 84548. Output tokens must not inflate it.
  assert.equal(ctx.used, 84686)
  assert.equal(ctx.limit, 1_000_000)
  assert.equal(ctx.pct, 8)
})

test('the 1M variant is recognised from the model id', () => {
  // A 1M session records the plain id, so keying off the [1m] suffix reported
  // 200k for a window five times that - every percentage five times too high.
  assert.equal(limitForModel('claude-opus-5'), 1_000_000)
  assert.equal(limitForModel('claude-opus-5[1m]'), 1_000_000)
  assert.equal(limitForModel('claude-sonnet-5'), 1_000_000)
  assert.equal(limitForModel('claude-opus-4-6'), 1_000_000)
  // Dated releases land on the same row as the alias.
  assert.equal(limitForModel('claude-opus-5-20260101'), 1_000_000)
  // Haiku is the small window, and must not be caught by a 4.x rule.
  assert.equal(limitForModel('claude-haiku-4-5-20251001'), 200_000)
  // Unknown under-reports the window, which overstates the pressure.
  assert.equal(limitForModel('some-other-model'), 200_000)
  assert.equal(limitForModel(''), 200_000)
  const ctx = usageFromLine(assistant('claude-opus-5', REAL))!
  assert.equal(ctx.limit, 1_000_000)
  assert.equal(ctx.pct, 8)
})

test('non-assistant lines and junk are ignored, not guessed at', () => {
  for (const line of [
    '',
    'not json',
    JSON.stringify({ type: 'user', message: { usage: REAL } }),
    JSON.stringify({ type: 'assistant', message: { model: 'x' } }),
    JSON.stringify({ type: 'assistant', message: { model: 'x', usage: {} } })
  ]) {
    assert.equal(usageFromLine(line), null, JSON.stringify(line).slice(0, 40))
  }
})

test('readCtx returns the newest turn, not the first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullpen-ctx-'))
  const file = join(dir, 't.jsonl')
  writeFileSync(
    file,
    [
      assistant('claude-opus-5', { ...REAL, cache_read_input_tokens: 1000 }),
      JSON.stringify({ type: 'user', message: {} }),
      assistant('claude-opus-5', { ...REAL, cache_read_input_tokens: 50_000 }),
      ''
    ].join('\n')
  )
  assert.equal(readCtx(file)!.used, 50_138)
  rmSync(dir, { recursive: true, force: true })
})

test('a huge transcript is read from its tail without loading it all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullpen-ctx-'))
  const file = join(dir, 'big.jsonl')
  const filler = JSON.stringify({ type: 'user', message: { text: 'x'.repeat(400) } })
  const lines: string[] = []
  // Comfortably past the tail window, so the early records are unreachable.
  while (lines.join('\n').length < TAIL_BYTES * 1.5) lines.push(filler)
  lines.push(assistant('claude-opus-5', { ...REAL, cache_read_input_tokens: 77_000 }))
  writeFileSync(file, lines.join('\n') + '\n')

  const ctx = readCtx(file)!
  assert.equal(ctx.used, 77_138, 'the last turn must still be found in a large file')
  rmSync(dir, { recursive: true, force: true })
})

test('a missing or empty transcript is null, never a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullpen-ctx-'))
  const empty = join(dir, 'empty.jsonl')
  writeFileSync(empty, '')
  assert.equal(readCtx(empty), null)
  assert.equal(readCtx(join(dir, 'does-not-exist.jsonl')), null)
  rmSync(dir, { recursive: true, force: true })
})

test('the child-session marker never reaches an agent', () => {
  // Inheriting it turns transcript saving off, which silently removes the only
  // structured source of context and cost data.
  const env = cleanEnv({
    PATH: '/usr/bin',
    HOME: '/home/lukas',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDECODE: '1',
    CLAUDE_CONFIG_DIR: '/home/lukas/.claude'
  })
  assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined)
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined)
  assert.equal(env.CLAUDECODE, undefined)
  assert.equal(env.PATH, '/usr/bin', 'the rest of the environment must survive')
  assert.equal(env.HOME, '/home/lukas')
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/lukas/.claude', 'only the CLAUDE_CODE_ prefix is stripped')
})

/**
 * PATH, as a packaged mac app gets it.
 *
 * launchd hands a GUI process four system directories, `claude` is in none of
 * them, and the failure that produces is invisible: the pty is real, the child
 * exits 1 without printing, and the terminal tab is blank. So the parsing that
 * recovers the real PATH is worth a test - it runs once, at launch, and there
 * is nothing downstream that would notice it had gone wrong.
 */

test('PATH is read from between the markers, not from the last line', () => {
  const M = '__BULLPEN_PATH__'
  assert.equal(pathFromShell(`${M}/usr/local/bin:/usr/bin${M}`), '/usr/local/bin:/usr/bin')
  // An interactive shell prints whatever the rc file wants to print, before
  // and after. That is the whole reason for the markers.
  assert.equal(
    pathFromShell(`nvm: v22\n${M}/opt/homebrew/bin:/usr/bin${M}\nWelcome back!\n`),
    '/opt/homebrew/bin:/usr/bin'
  )
  assert.equal(pathFromShell('no markers here'), null)
  assert.equal(pathFromShell(`${M}only one marker`), null)
  // A shell that answers with something that is not a path is not answering.
  assert.equal(pathFromShell(`${M}${M}`), null)
  assert.equal(pathFromShell(`${M}command not found${M}`), null)
})

test('the shell PATH wins, and nothing already on PATH is dropped', () => {
  assert.equal(
    mergePath('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin:/usr/sbin'),
    '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin'
  )
  // Duplicates collapse to their first appearance, so order stays meaningful.
  assert.equal(mergePath('/a:/b:/a', '/b:/c'), '/a:/b:/c')
  assert.equal(mergePath('/a', ''), '/a')
  // Empty segments from a trailing colon are not directories.
  assert.equal(mergePath('/a:', ':/b'), '/a:/b')
})

test('a shell that cannot answer leaves the PATH alone', () => {
  const boom = (): string => {
    throw new Error('timed out')
  }
  assert.equal(loginShellPath(boom, '/bin/zsh'), null)
  assert.equal(loginShellPath(() => 'nothing useful', '/bin/zsh'), null)
  // No $SHELL at all - which is how a process launched by launchd can arrive.
  assert.equal(loginShellPath(() => 'unused', undefined), null)
})

test('the real login shell can be asked, and answers with this PATH', () => {
  // Not a mock: the one thing worth knowing is that the flags and the printf
  // survive a real shell. Skipped where there is no shell to ask.
  const shell = process.env.SHELL
  if (!shell || process.platform === 'win32') return
  const got = loginShellPath(
    (cmd, args) =>
      execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }),
    shell
  )
  assert.ok(got && got.includes('/'), `login shell gave back: ${got}`)
})
