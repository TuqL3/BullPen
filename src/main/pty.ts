import { EventEmitter } from 'node:events'
import { spawn, type IPty } from 'node-pty'
import { platform } from 'node:os'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { cleanEnv } from './ctx.ts'
import { feed, newWatch, type TrustWatch } from './trust.ts'

export type AgentSpec = {
  id: string
  /** Working directory. Also the sandbox the approvals layer enforces. */
  cwd: string
  /** Defaults to the `claude` CLI. */
  cmd?: string
  args?: string[]
  env?: Record<string, string>
  cols?: number
  rows?: number
  /** Who this agent reports to when it finishes. Defaults to the god agent. */
  reportTo?: string
}

export type AgentState = {
  id: string
  cwd: string
  pid: number
  startedAt: number
  status: 'running' | 'exited'
  /** Live pty dimensions. A mismatch with the renderer's xterm garbles output,
   *  so they are reported rather than left invisible. */
  cols: number
  rows: number
  exitCode?: number
}

/** How much of each agent's output is kept to fill a fresh window back in. */
const TAIL = 200_000

/**
 * Keep the last `max` characters, cut at a line boundary.
 *
 * A blind `slice(-max)` can land inside an escape sequence, and half a sequence
 * replayed into a terminal is a pane painted in whatever colour the other half
 * would have ended. Cutting at the first newline past the limit costs at most
 * one line and hands back something a terminal can read from the top.
 */
export function trimTail(past: string, chunk: string, max = TAIL): string {
  const all = past + chunk
  if (all.length <= max) return all
  const cut = all.length - max
  const nl = all.indexOf('\n', cut)
  return all.slice(nl >= 0 ? nl + 1 : cut)
}

/**
 * The names the Claude CLI is installed under on Windows, best first.
 *
 * The native installer writes `claude.exe`; a global npm install writes
 * `claude.cmd` and `claude.ps1` and no `.exe` at all. Neither is wrong, and a
 * machine has one or the other.
 */
const WIN_CLI = ['claude.exe', 'claude.cmd', 'claude.bat']

/**
 * Where Windows keeps the PATH a shell started right now would see.
 *
 * Machine first, then user: that is the order Windows itself composes them in,
 * and a duplicate later in the list never wins anyway.
 */
const PATH_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment'
]

/**
 * The PATH out of one `reg query <key> /v Path`.
 *
 * A process holds the environment it was handed at start, and Bullpen is
 * launched from Explorer - whose own environment is a snapshot taken at login.
 * So a CLI installed after login is invisible to the app however correctly the
 * installer wrote PATH, and the first-run dialog prints "install the Claude CLI
 * first" at an operator who has just done exactly that. Signing out fixes it,
 * which is not something a dialog can ask for.
 *
 * The registry is where every installer writes and every new shell reads, so
 * it answers for any install directory rather than the two the default
 * installers happen to use. This is the Windows half of what
 * `pathFromLoginShell` does on macOS, and for the same reason.
 *
 * The value is usually `REG_EXPAND_SZ` and holds `%USERPROFILE%` unexpanded -
 * a literal `%USERPROFILE%\.local\bin` on PATH matches no directory at all.
 * An unset variable is left standing, which is what Windows does with one too.
 *
 * Pure, and told the output rather than running `reg` itself: a parser that
 * can only be exercised on Windows is a parser nobody exercises.
 */
export function regPath(out: string | null, env: NodeJS.ProcessEnv): string {
  // `Path` is one line, its value runs to the end of it, and reg pads the
  // columns with spaces - so the type is the anchor, not the whitespace.
  const line = (out ?? '').split(/\r?\n/).find((l) => /^\s*Path\s+REG_(EXPAND_)?SZ\s/i.test(l))
  if (!line) return ''
  const value = line.replace(/^\s*Path\s+REG_(EXPAND_)?SZ\s+/i, '').trimEnd()
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const hit = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
    return hit && env[hit] ? env[hit] : whole
  })
}

/**
 * Ask the registry what PATH is, and take silence for an answer.
 *
 * `reg.exe` ships with Windows, so this is a lookup rather than a dependency.
 * It exits non-zero when the value is not there, which lands here as a throw
 * and leaves the caller with the inherited PATH it already had - a registry
 * that cannot be read must never be worse than not looking.
 *
 * ponytail: read on every spawn rather than cached. Two `reg` calls cost a few
 * tens of milliseconds against a process launch that is already happening, and
 * a cache would hold exactly the stale answer this function exists to avoid.
 */
export function registryPath(env: NodeJS.ProcessEnv): string {
  return PATH_KEYS.map((key) => {
    try {
      return regPath(
        execFileSync('reg.exe', ['query', key, '/v', 'Path'], {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore']
        }),
        env
      )
    } catch {
      return ''
    }
  })
    .filter(Boolean)
    .join(';')
}

/**
 * One search path out of several, in the order given, without repeats.
 *
 * Earlier wins: the PATH Bullpen was launched with comes first, so an operator
 * who started it from a shell holding a particular claude still gets that one.
 * The registry follows, then the two directories the default installers use -
 * a net for an installer that writes a directory into PATH and gets no further.
 *
 * Trailing separators and case are normalised for the comparison only. A
 * duplicated directory is another `existsSync` on every spawn and a PATH that
 * grows each time something reads and rewrites it.
 */
export function winSearchPath(paths: string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of paths.flatMap((p) => p.split(';'))) {
    if (!dir) continue
    const key = dir.replace(/\\+$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(dir)
  }
  return out.join(';')
}

/**
 * Set PATH on an environment under the name that environment already uses.
 *
 * Windows spells it `Path`, and `process.env` only looks case-insensitive
 * because Node proxies it - spread it into a plain object and the literal key
 * is what survives. Adding `PATH` next to an existing `Path` hands the child
 * two of them, and which one wins is the child's business, not ours.
 */
export function withPath(env: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  return { ...env, [key]: path }
}

/**
 * What to hand node-pty for the CLI on this platform.
 *
 * Only one of the two Windows installs can be spawned directly. node-pty calls
 * `CreateProcessW` with `lpApplicationName` NULL and the command line in
 * `lpCommandLine` (`src/win/conpty.cc:413`), and `CreateProcessW` loads
 * images - a batch file is not one. So `claude.cmd` gets past node-pty's own
 * PATH check only to die at the call itself, with `Cannot create process`. A
 * batch file needs an interpreter, so it gets one.
 *
 * Null means nothing is installed, and it has to be null rather than a best
 * guess: `cmd.exe /d /c claude.cmd` spawns perfectly well on a machine with no
 * CLI, because cmd.exe is always there. The operator would get
 * `'claude.cmd' is not recognized` painted inside an agent pane - a pty that
 * came up, so nothing above here would know to say anything.
 *
 * Pure, and told the platform, the PATH and the existence check rather than
 * reading them: the machine this is wrong on is never the one it is written on.
 */
export function resolveCli(
  cmd: string | undefined,
  args: string[],
  os: string,
  path: string,
  exists: (p: string) => boolean
): { file: string; args: string[] } | null {
  // execvp does this lookup itself, and reports a miss as ENOENT, which
  // spawnFailure already reads. Probing here would only disagree with it.
  if (os !== 'win32') return { file: cmd ?? 'claude', args }
  const dirs = path.split(';').filter(Boolean)
  const file = cmd ?? WIN_CLI.find((name) => dirs.some((dir) => exists(join(dir, name))))
  if (!file) return null
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args }
  // ponytail: `/d` skips whatever AutoRun the registry holds. Ceiling - cmd.exe
  // re-parses the line, so a `%` or a `^` inside an argument means something to
  // it. Every caller passes `args: []`; the day one does not, quote it there.
  return { file: 'cmd.exe', args: ['/d', '/c', file, ...args] }
}

/**
 * The one sentence worth printing when the CLI is not installed.
 *
 * Every agent on the floor is a `claude` process, so a machine without the CLI
 * fails at the first one - and the operator meets it as the first-run dialog
 * refusing the directory they just picked. Naming the directory is what the
 * underlying errors do not do, and under a box someone has just typed a path
 * into, anything else reads as "that folder is wrong".
 */
export function missingCli(cmd: string): Error {
  return new Error(
    `${cmd} is not on PATH - install the Claude CLI first (npm i -g @anthropic-ai/claude-code), ` +
      `then pick the directory again. The directory itself is fine.`
  )
}

/**
 * Say what a failed spawn actually means, when it means the CLI is not there.
 *
 * node-pty reports a missing binary as `File not found: <path>`, and on Windows
 * with the path blank: it walks PATH for that exact filename and hands back an
 * empty string. Anything else is somebody else's failure and goes back
 * untouched - rewriting one as "install the CLI" sends the operator off
 * installing something they already have.
 */
export function spawnFailure(cmd: string, err: unknown): Error {
  const why = err instanceof Error ? err.message : String(err)
  if (!/file not found|enoent/i.test(why)) return err instanceof Error ? err : new Error(why)
  return missingCli(cmd)
}

/**
 * One real pseudo-terminal per agent. Nothing is simulated: every agent is the
 * same `claude` process you would run by hand, just parented by Bullpen.
 */
export class PtyManager extends EventEmitter {
  private ptys = new Map<string, IPty>()
  private states = new Map<string, AgentState>()
  /**
   * What each agent has printed, bounded.
   *
   * The window reloads whenever a floor is applied, and an agent whose role
   * survives the switch is not restarted - so the renderer came back with an
   * empty xterm attached to a pty that had already said everything it was
   * going to say. An idle agent prints nothing, and the pane stayed black for
   * as long as it stayed idle: the floor was running, the agent was up, and
   * the one screen that shows it was blank.
   *
   * Kept past exit as well. The last thing a dead agent printed is the reason
   * it died, and that is exactly when somebody goes looking for it.
   */
  private tail = new Map<string, string>()
  private trust = new Map<string, TrustWatch>()

  spawn(spec: AgentSpec): AgentState {
    if (this.ptys.has(spec.id)) throw new Error(`agent ${spec.id} already running`)

    // Direct spawn on Unix. A /bin/sh wrapper that closes inherited descriptors
    // was tried and reverted - see defect B in OPEN-QUESTIONS.md for what it
    // fixed, how it broke, and why it is not worth a broken launcher. The
    // cmd.exe on the Windows side is not that: a .cmd has no other way to run.
    // The same search path decides what is found and what the child can find:
    // resolving against one PATH and spawning with another is how a CLI passes
    // the check here and reports itself missing one process down.
    const os = platform()
    const home = process.env.USERPROFILE ?? ''
    const appdata = process.env.APPDATA ?? ''
    const search =
      os === 'win32'
        ? winSearchPath([
            process.env.PATH ?? '',
            registryPath(process.env),
            // Last, and only as a net: an empty root would join to a relative
            // `.local\bin`, which probes against whatever directory the app
            // happens to be sitting in.
            home ? join(home, '.local', 'bin') : '',
            appdata ? join(appdata, 'npm') : ''
          ])
        : (process.env.PATH ?? '')
    const target = resolveCli(spec.cmd, spec.args ?? [], os, search, existsSync)
    if (!target) throw missingCli('claude')
    const cmd = target.file
    let pty: IPty
    try {
      pty = spawn(cmd, target.args, {
        name: 'xterm-256color',
        cwd: spec.cwd,
        cols: spec.cols ?? 120,
        rows: spec.rows ?? 32,
        // cleanEnv strips CLAUDE_CODE_*: if Bullpen was itself launched from a
        // Claude Code session, the inherited child-session marker turns the
        // agent's transcript off, which removes the context and cost data.
        env: {
          ...(search ? withPath(cleanEnv(process.env), search) : cleanEnv(process.env)),
          ...spec.env,
          BULLPEN_AGENT_ID: spec.id
        } as Record<string, string>
      })
    } catch (err) {
      throw spawnFailure(cmd, err)
    }

    const cols = spec.cols ?? 120
    const rows = spec.rows ?? 32
    const state: AgentState = {
      id: spec.id,
      cwd: spec.cwd,
      pid: pty.pid,
      startedAt: Date.now(),
      status: 'running',
      cols,
      rows
    }
    this.ptys.set(spec.id, pty)
    this.states.set(spec.id, state)
    this.trust.set(spec.id, newWatch(spec.cwd, state.startedAt))
    // A respawn under the same id is a new conversation, not a continuation of
    // whatever the last one printed.
    this.tail.set(spec.id, '')

    pty.onData((chunk) => {
      this.tail.set(spec.id, trimTail(this.tail.get(spec.id) ?? '', chunk))
      this.emit('data', spec.id, chunk)

      // Answer Claude Code's workspace-trust prompt, once, only for the
      // directory the human designated as this agent's sandbox. See trust.ts
      // for why this is narrow on purpose.
      const watch = this.trust.get(spec.id)
      if (watch && feed(watch, chunk, Date.now())) {
        this.write(spec.id, '\r')
        this.emit('trust', spec.id, watch.sandbox)
      }
    })
    pty.onExit(({ exitCode }) => {
      this.ptys.delete(spec.id)
      this.trust.delete(spec.id)
      const s = this.states.get(spec.id)
      if (s) {
        s.status = 'exited'
        s.exitCode = exitCode
      }
      this.emit('exit', spec.id, exitCode)
    })
    return state
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.write(data)
  }

  /** What this agent has printed lately, for a terminal that has just opened. */
  backlog(id: string): string {
    return this.tail.get(id) ?? ''
  }

  resize(id: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return
    try {
      this.ptys.get(id)?.resize(cols, rows)
      const state = this.states.get(id)
      if (state) {
        state.cols = cols
        state.rows = rows
      }
    } catch {
      // A pty that exited mid-resize is not an error worth surfacing.
    }
  }

  kill(id: string): void {
    this.ptys.get(id)?.kill()
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }

  list(): AgentState[] {
    return [...this.states.values()]
  }

  isRunning(id: string): boolean {
    return this.ptys.has(id)
  }

  /**
   * Nudge a running agent with an inbox message.
   *
   * ponytail: types the mail straight into the agent's prompt and hits enter.
   * Ceiling — if the agent is mid-turn the text lands in the middle of its
   * work, and there is no delivery receipt. Upgrade path when that bites: stop
   * typing, and have agents poll their own inbox/ files as a tool call instead.
   */
  /** False when the recipient is not running - the caller has to say so. */
  deliver(id: string, from: string, subject: string, body: string): boolean {
    return this.submit(id, `[bullpen mail from ${from}] ${subject}: ${body}`)
  }

  /**
   * Type a prompt and submit it.
   *
   * The Enter must be a write of its own. Claude Code treats a line that lands
   * in one burst as a paste, and Enter inside a paste is a newline - so
   * `text + '\r'` left the message sitting on the prompt, never sent. Every
   * path that puts words in an agent's mouth goes through here: hive mail,
   * dispatch, scheduled triggers, the first briefing.
   */
  submit(id: string, text: string): boolean {
    if (!this.isRunning(id)) return false
    this.write(id, text.replace(/\r?\n/g, ' '))
    setTimeout(() => this.write(id, '\r'), 150).unref?.()
    return true
  }
}
