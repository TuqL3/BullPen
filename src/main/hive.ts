import { EventEmitter } from 'node:events'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type Message = {
  from: string
  to: string // agent id, or '*' to broadcast
  subject: string
  body: string
  ts: number
  /**
   * Only read on a message to `hire`, and only when the project is new: the
   * directory the first agent on it should work in. Starting a project is the
   * operator's call, so this is the field that carries their answer.
   */
  cwd?: string
}

export type Delivery = { to: string; msg: Message }

/**
 * Reserved recipient: mail addressed here is a question for the human, not for
 * another agent. It is not dead mail - it surfaces in the ask-me queue and the
 * human's reply is routed back into the asker's inbox like any other message.
 */
export const HUMAN = 'you'

/**
 * Reserved recipient: a request to hire. Michael has to be able to put someone
 * on a project that has nobody free, and the alternative - an IPC only the UI
 * can call - is a capability he could never reach.
 *
 * `subject` is the project, `body` is the briefing the new agent starts with,
 * and `cwd` names the directory when the project does not exist yet.
 */
export const HIRE = 'hire'

/**
 * File-based agent mailbox.
 *
 *   <root>/agents/<id>/outbox/*.json   agent writes here
 *   <root>/agents/<id>/inbox/*.json    router delivers here
 *   <root>/dead/*.json                 unroutable messages
 *
 * Agents talk by writing plain JSON files. No broker, no socket, no DB — an
 * agent that can use the Write tool can already send mail with zero extra
 * tooling, and the whole bus is inspectable with `ls`.
 */
export class Hive extends EventEmitter {
  private seq = 0
  private timer: NodeJS.Timeout | null = null
  readonly root: string

  // Plain assignment, not a constructor parameter property: `node
  // --experimental-strip-types` rejects parameter properties, and that is how
  // the router tests run without a build step.
  constructor(root: string) {
    super()
    this.root = root
    mkdirSync(join(root, 'agents'), { recursive: true })
    mkdirSync(join(root, 'dead'), { recursive: true })
  }

  agentDir(id: string): string {
    return join(this.root, 'agents', id)
  }

  register(id: string): void {
    mkdirSync(join(this.agentDir(id), 'inbox'), { recursive: true })
    mkdirSync(join(this.agentDir(id), 'outbox'), { recursive: true })
  }

  list(): string[] {
    return readdirSync(join(this.root, 'agents'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  }

  /** Write a message into `from`'s outbox. Router picks it up on the next tick. */
  send(msg: Omit<Message, 'ts'> & { ts?: number }): string {
    const full: Message = { ...msg, ts: msg.ts ?? Date.now() }
    this.register(full.from)
    const file = join(this.agentDir(full.from), 'outbox', this.nextName())
    writeFileSync(file, JSON.stringify(full, null, 2))
    return file
  }

  /** Read and REMOVE every message in an agent's inbox. */
  drainInbox(id: string): Message[] {
    const dir = join(this.agentDir(id), 'inbox')
    const out: Message[] = []
    for (const name of this.jsonFiles(dir)) {
      const path = join(dir, name)
      const msg = this.readJson(path)
      if (msg) out.push(msg)
      rmSync(path, { force: true })
    }
    return out
  }

  peekInbox(id: string): Message[] {
    const dir = join(this.agentDir(id), 'inbox')
    return this.jsonFiles(dir)
      .map((n) => this.readJson(join(dir, n)))
      .filter((m): m is Message => m !== null)
  }

  /**
   * Drain every outbox once and deliver. Returns the deliveries made.
   * Emits 'deliver' per delivery so the caller can nudge the receiving PTY.
   */
  route(): Delivery[] {
    const agents = this.list()
    const made: Delivery[] = []

    for (const from of agents) {
      const dir = join(this.agentDir(from), 'outbox')
      for (const name of this.jsonFiles(dir)) {
        const path = join(dir, name)
        const msg = this.readJson(path)
        rmSync(path, { force: true })

        if (!msg) continue

        if (msg.to === HUMAN) {
          this.emit('question', msg)
          continue
        }
        if (msg.to === HIRE) {
          this.emit('hire', msg)
          continue
        }

        const targets =
          msg.to === '*' ? agents.filter((a) => a !== from) : agents.includes(msg.to) ? [msg.to] : []

        if (targets.length === 0) {
          writeFileSync(join(this.root, 'dead', this.nextName()), JSON.stringify(msg, null, 2))
          this.emit('dead', msg)
          continue
        }
        for (const to of targets) {
          writeFileSync(
            join(this.agentDir(to), 'inbox', this.nextName()),
            JSON.stringify({ ...msg, to }, null, 2)
          )
          const d: Delivery = { to, msg: { ...msg, to } }
          made.push(d)
          this.emit('deliver', d)
        }
      }
    }
    return made
  }

  // ponytail: 500ms polling, not fs.watch. fs.watch is unreliable on WSL2 /mnt
  // and on network shares, and dedup/rename handling costs more code than the
  // whole poll loop. Ceiling: ~500ms added latency per hop, and a readdir per
  // agent per tick. Switch to fs.watch if agent count goes past ~50.
  start(intervalMs = 500): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      try {
        this.route()
      } catch (err) {
        this.emit('error', err)
      }
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private jsonFiles(dir: string): string[] {
    try {
      return readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
    } catch {
      return []
    }
  }

  private readJson(path: string): Message | null {
    try {
      const msg = JSON.parse(readFileSync(path, 'utf8')) as Message
      // A half-written file parses as garbage; a malformed one is agent error.
      // Either way it must not take the router down.
      if (typeof msg?.from !== 'string' || typeof msg?.to !== 'string') return null
      return msg
    } catch {
      return null
    }
  }

  /** Monotonic within a process; the counter breaks same-millisecond ties. */
  private nextName(): string {
    return `${Date.now()}-${String(this.seq++).padStart(6, '0')}.json`
  }
}
