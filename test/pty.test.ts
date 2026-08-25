import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveCli, spawnFailure, trimTail } from '../src/main/pty.ts'

/**
 * Applying a floor reloads the window and leaves the agents that have a place
 * on the new one running, so the renderer comes back with an empty terminal
 * attached to a pty that has already printed everything it had to say. This is
 * what fills it back in - bounded, because an agent that has been up all day
 * has printed more than anybody wants held in memory.
 */
test('the backlog keeps the end of what was printed, cut at a line', () => {
  // Under the limit, nothing is thrown away.
  assert.equal(trimTail('one\n', 'two\n', 100), 'one\ntwo\n')
  assert.equal(trimTail('', '', 100), '')

  // Over it, the oldest goes. What is left starts at a line boundary rather
  // than mid-line: a cut that lands inside an escape sequence replays half of
  // one, and half a sequence is a pane painted in whatever colour the rest of
  // it would have ended.
  const kept = trimTail('aaaa\nbbbb\ncccc\n', 'dddd\n', 12)
  assert.equal(kept, 'cccc\ndddd\n')
  assert.ok(kept.length <= 12)

  // A cut with no newline after it has no boundary to find. Keeping exactly
  // the last `max` is still better than keeping nothing.
  assert.equal(trimTail('', 'abcdefghij', 4), 'ghij')

  // The limit is a ceiling that holds however many chunks it takes to reach it.
  let tail = ''
  for (let i = 0; i < 500; i++) tail = trimTail(tail, `line ${i}\n`, 200)
  assert.ok(tail.length <= 200, `grew to ${tail.length}`)
  assert.ok(tail.endsWith('line 499\n'), 'and the newest is the part that is kept')
  assert.ok(!tail.includes('line 0\n'), 'the oldest is gone')
})

/**
 * A machine with no `claude` on PATH meets this as the first-run dialog: the
 * operator picks a directory and gets `File not found:` back, with nothing
 * after the colon on Windows, printed under the box they just typed a path
 * into. Every reading of that message blames the directory.
 */
test('a missing CLI is reported as a missing CLI, not as a bad directory', () => {
  // What node-pty's Windows path actually throws: it searches PATH for the
  // exact filename, finds nothing, and interpolates the empty string.
  const win = spawnFailure('claude.cmd', new Error('File not found: '))
  assert.match(win.message, /claude\.cmd is not on PATH/)
  assert.match(win.message, /install the Claude CLI first/i)
  assert.match(win.message, /directory itself is fine/)

  // The Unix wording of the same thing.
  assert.match(spawnFailure('claude', new Error('spawn claude ENOENT')).message, /not on PATH/)
  assert.match(spawnFailure('claude', 'File not found: /usr/bin/claude').message, /not on PATH/)

  // Anything else is somebody else's problem and is handed back untouched -
  // rewriting an unrelated failure as "install the CLI" sends the operator off
  // installing something they already have.
  const other = new Error('cwd does not exist')
  assert.equal(spawnFailure('claude', other), other)
  assert.match(spawnFailure('claude', 'Cannot launch conpty').message, /conpty/)
})

/**
 * Windows installs the CLI two ways, and node-pty can only spawn one of them.
 * `CreateProcessW` is handed the command line with `lpApplicationName` NULL and
 * loads images; a `.cmd` is not an image, so it reaches the call only to fail
 * there. Getting this wrong is invisible on the machine it is written on.
 */
test('the CLI is launched by whichever name Windows has it under', () => {
  const PATH = 'C:\\Windows\\System32;C:\\Users\\x\\.local\\bin'
  const only = (installed: string) => (p: string) => p.endsWith(installed)

  // Native installer: a real image, spawned directly, no interpreter.
  assert.deepEqual(resolveCli(undefined, [], 'win32', PATH, only('claude.exe')), {
    // The bare name, not the resolved path: node-pty looks it up again itself,
    // and two lookups that can disagree is one too many.
    file: 'claude.exe',
    args: []
  })

  // Global npm install: a batch shim, which needs cmd.exe or it dies at
  // CreateProcessW. `/d` so a machine with an AutoRun key does not run it.
  assert.deepEqual(resolveCli(undefined, ['--foo'], 'win32', PATH, only('claude.cmd')), {
    file: 'cmd.exe',
    args: ['/d', '/c', 'claude.cmd', '--foo']
  })

  // .exe wins when both are there: it is one process instead of two.
  assert.equal(resolveCli(undefined, [], 'win32', PATH, () => true)?.file, 'claude.exe')

  // Nothing installed is null, not a guess. `cmd.exe /d /c claude.cmd` would
  // spawn happily - cmd.exe is always there - and paint `is not recognized`
  // inside an agent pane, where the app cannot see it to explain it.
  assert.equal(resolveCli(undefined, [], 'win32', PATH, () => false), null)
  assert.equal(resolveCli(undefined, [], 'win32', '', () => true), null)

  // An explicit command is taken as given, and still wrapped if it is a script.
  assert.deepEqual(resolveCli('pwsh.exe', ['-v'], 'win32', PATH, () => false), {
    file: 'pwsh.exe',
    args: ['-v']
  })
  assert.deepEqual(resolveCli('other.BAT', [], 'win32', PATH, () => false), {
    file: 'cmd.exe',
    args: ['/d', '/c', 'other.BAT']
  })

  // Unix is left to execvp, which does its own lookup and reports a miss as
  // ENOENT - which spawnFailure already reads. A second lookup here could only
  // disagree with it.
  assert.deepEqual(resolveCli(undefined, [], 'linux', '/usr/bin:/bin', () => false), {
    file: 'claude',
    args: []
  })
  assert.deepEqual(resolveCli(undefined, [], 'darwin', '', () => false), { file: 'claude', args: [] })
})
