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
}

export type AgentState = {
  id: string
  cwd: string
  pid: number
  startedAt: number
  status: 'running' | 'exited'
  exitCode?: number
}

/**
 * One real pseudo-terminal per agent. Nothing is simulated: every agent is the
 * same `claude` process you would run by hand, just parented by Bullpen.
 */
export class PtyManager extends EventEmitter {
  private ptys = new Map<string, IPty>()
  private states = new Map<string, AgentState>()
  private trust = new Map<string, TrustWatch>()

  spawn(spec: AgentSpec): AgentState {
    if (this.ptys.has(spec.id)) throw new Error(`agent ${spec.id} already running`)

    const cmd = spec.cmd ?? (platform() === 'win32' ? 'claude.cmd' : 'claude')
    // Direct spawn. A /bin/sh wrapper that closes inherited descriptors was
    // tried and reverted - see defect B in OPEN-QUESTIONS.md for what it fixed,
    // how it broke, and why it is not worth a broken launcher.
    const pty = spawn(cmd, spec.args ?? [], {
      name: 'xterm-256color',
      cwd: spec.cwd,
      cols: spec.cols ?? 120,
      rows: spec.rows ?? 32,
      // cleanEnv strips CLAUDE_CODE_*: if Bullpen was itself launched from a
      // Claude Code session, the inherited child-session marker turns the
      // agent's transcript off, which removes the context and cost data.
      env: { ...cleanEnv(process.env), ...spec.env, BULLPEN_AGENT_ID: spec.id } as Record<string, string>
    })

    const state: AgentState = {
      id: spec.id,
      cwd: spec.cwd,
      pid: pty.pid,
      startedAt: Date.now(),
      status: 'running'
    }
    this.ptys.set(spec.id, pty)
    this.states.set(spec.id, state)
    this.trust.set(spec.id, newWatch(spec.cwd, state.startedAt))

    pty.onData((chunk) => {
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

  resize(id: string, cols: number, rows: number): void {
    try {
      this.ptys.get(id)?.resize(cols, rows)
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
  deliver(id: string, from: string, subject: string, body: string): void {
    if (!this.isRunning(id)) return
    const text = `[bullpen mail from ${from}] ${subject}: ${body}`
    this.write(id, text.replace(/\r?\n/g, ' ') + '\r')
  }
}
