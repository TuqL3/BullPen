import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { regPath, resolveCli, spawnFailure, trimTail, winSearchPath, withPath } from '../src/main/pty.ts'

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
  const BIN = 'C:\\Users\\x\\.local\\bin'
  const PATH = `C:\\Windows\\System32;${BIN}`
  const only = (installed: string) => (p: string) => p === join(BIN, installed)

  // Native installer: a real image, spawned directly, no interpreter.
  assert.deepEqual(resolveCli(undefined, [], 'win32', PATH, only('claude.exe')), {
    // The full path, never the bare name. node-pty resolves a relative
    // filename against `GetEnvironmentVariableW(L"Path")` - this process's own
    // environment, not the env handed to spawn - so a bare name throws away
    // everything found here and asks the stale PATH again.
    file: join(BIN, 'claude.exe'),
    args: []
  })

  // Global npm install: a batch shim, which needs cmd.exe or it dies at
  // CreateProcessW. `/d` so a machine with an AutoRun key does not run it.
  assert.deepEqual(resolveCli(undefined, ['--foo'], 'win32', PATH, only('claude.cmd')), {
    file: 'cmd.exe',
    args: ['/d', '/c', join(BIN, 'claude.cmd'), '--foo']
  })

  // .exe wins when both are there: it is one process instead of two.
  assert.equal(resolveCli(undefined, [], 'win32', PATH, () => true)?.file, join('C:\\Windows\\System32', 'claude.exe'))

  // The first directory on PATH wins, not the first that happens to be probed.
  assert.equal(resolveCli(undefined, [], 'win32', PATH, only('claude.exe'))?.file, join(BIN, 'claude.exe'))

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

/**
 * The bug this exists for: the operator installs the CLI, the installer writes
 * PATH correctly, and Bullpen still refuses the directory - because the app
 * inherited its environment from Explorer, which took its own snapshot at
 * login. Nothing on the machine is wrong; the running process is just old.
 *
 * The registry is the answer rather than a list of likely directories: it is
 * where the installer wrote and where a new shell reads, so it holds for an
 * install anywhere, not only the two paths the default installers use.
 */
test('the search path is read where installers write it, not where the app was born', () => {
  const env = { USERPROFILE: 'C:\\Users\\Admin', SystemRoot: 'C:\\Windows' }

  // What `reg query HKCU\Environment /v Path` prints. The value runs to the
  // end of its line and may hold spaces, so the type is the anchor.
  const out = [
    '',
    'HKEY_CURRENT_USER\\Environment',
    '    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Program Files\\Git\\cmd',
    ''
  ].join('\r\n')
  assert.equal(regPath(out, env), 'C:\\Users\\Admin\\.local\\bin;C:\\Program Files\\Git\\cmd')

  // REG_SZ as well as REG_EXPAND_SZ - the machine key is often the plain one.
  assert.equal(regPath('    Path    REG_SZ    C:\\Windows\\System32', env), 'C:\\Windows\\System32')

  // A variable nothing defines is left standing, which is what Windows does
  // with one. Swallowing it would silently shorten PATH by a directory.
  assert.equal(regPath('    Path    REG_EXPAND_SZ    %NOPE%\\bin', env), '%NOPE%\\bin')

  // No value, no key, no reg.exe at all: the caller keeps the PATH it had. A
  // registry that cannot be read must never be worse than not looking.
  assert.equal(regPath('ERROR: The system was unable to find the specified registry key', env), '')
  assert.equal(regPath(null, env), '')

  // Another value whose name merely starts with Path is not this one.
  assert.equal(regPath('    PathExt    REG_SZ    .COM;.EXE', env), '')
})

/**
 * Several sources, one PATH: whoever came first keeps the position, so an
 * operator who launched Bullpen from a shell holding a particular claude still
 * gets that one, and the registry only ever adds.
 */
test('the sources are merged in order, without repeats', () => {
  const stale = 'C:\\Windows\\System32'
  const fresh = 'C:\\Windows\\System32;C:\\Users\\Admin\\.local\\bin'

  assert.equal(winSearchPath([stale, fresh]), fresh)
  assert.equal(winSearchPath(['a;b', 'c'], ), 'a;b;c')

  // Trailing separators and case are the same directory, not two.
  assert.equal(winSearchPath(['C:\\bin', 'C:\\bin\\', 'c:\\BIN']), 'C:\\bin')

  // Empty sources vanish rather than leaving `;;`, which Windows reads as the
  // working directory - a claude.exe dropped next to a project would win.
  assert.equal(winSearchPath(['', stale, '', '']), stale)
  assert.equal(winSearchPath([]), '')

  // And the CLI the registry knows about is now found, where the inherited
  // PATH alone missed it.
  const at = (p: string) => p === join('C:\\Users\\Admin\\.local\\bin', 'claude.exe')
  assert.equal(resolveCli(undefined, [], 'win32', stale, at), null)
  assert.equal(
    resolveCli(undefined, [], 'win32', winSearchPath([stale, fresh]), at)?.file,
    join('C:\\Users\\Admin\\.local\\bin', 'claude.exe')
  )
})

/**
 * Windows spells it `Path`. Spread `process.env` into a plain object and that
 * literal key survives, so writing `PATH` beside it hands the child two.
 */
test('the search path is written under the name the environment already uses', () => {
  assert.deepEqual(withPath({ Path: 'a', HOME: 'h' }, 'b'), { Path: 'b', HOME: 'h' })
  assert.deepEqual(withPath({ PATH: 'a' }, 'b'), { PATH: 'b' })
  assert.deepEqual(withPath({ HOME: 'h' }, 'b'), { HOME: 'h', PATH: 'b' })
})
