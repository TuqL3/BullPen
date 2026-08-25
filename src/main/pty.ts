import { EventEmitter } from 'node:events'
import { spawn, type IPty } from 'node-pty'
import { platform } from 'node:os'
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
 * Say what a failed spawn actually means, when it means the CLI is not there.
 *
 * Every agent on the floor is a `claude` process, so a machine without the CLI
 * fails at the first one - and the operator meets it as the first-run dialog
 * refusing the directory they just picked. node-pty reports the missing binary
 * as `File not found: <path>`, and on Windows with the path blank: it walks
 * PATH looking for that exact filename and hands back an empty string. Neither
 * version names the directory, and neither names the one thing to do about it,
 * so the reading is "that folder is wrong" - which it is not.
 */
export function spawnFailure(cmd: string, err: unknown): Error {
  const why = err instanceof Error ? err.message : String(err)
  if (!/file not found|enoent/i.test(why)) return err instanceof Error ? err : new Error(why)
  return new Error(
    `${cmd} is not on PATH - install the Claude CLI first (npm i -g @anthropic-ai/claude-code), ` +
      `then pick the directory again. The directory itself is fine.`
  )
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

    const cmd = spec.cmd ?? (platform() === 'win32' ? 'claude.cmd' : 'claude')
    // Direct spawn. A /bin/sh wrapper that closes inherited descriptors was
    // tried and reverted - see defect B in OPEN-QUESTIONS.md for what it fixed,
    // how it broke, and why it is not worth a broken launcher.
    let pty: IPty
    try {
      pty = spawn(cmd, spec.args ?? [], {
        name: 'xterm-256color',
        cwd: spec.cwd,
        cols: spec.cols ?? 120,
        rows: spec.rows ?? 32,
        // cleanEnv strips CLAUDE_CODE_*: if Bullpen was itself launched from a
        // Claude Code session, the inherited child-session marker turns the
        // agent's transcript off, which removes the context and cost data.
        env: { ...cleanEnv(process.env), ...spec.env, BULLPEN_AGENT_ID: spec.id } as Record<string, string>
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
