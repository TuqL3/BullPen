import { EventEmitter } from 'node:events'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
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
  /**
   * Only read on a message to `hire`: what the new agent is for. A floor with
   * one kind of agent cannot have a test loop - somebody has to be the one who
   * checks the work rather than the one who wrote it.
   */
  role?: string
  /**
   * Which card on the board this message is about.
   *
   * Stamped by the app on work it hands out, and quoted back by the agent when
   * it reports. Without it the board had to guess, and the guess was "whoever
   * sent this, their newest open card" - so an agent holding two tasks closed
   * the wrong one every time it finished the older.
   *
   * The router does not read it. It rides along like `subject` does, and main
   * is what looks it up.
   */
  task?: string
  /**
   * The card this message's work was put on the reader's board as, when the app
   * opened one for them rather than handing the work straight over.
   *
   * Set by main on the way through, never written by an agent. A role is one
   * pair of hands and work arrives faster than hands finish: typed at a CLI
   * mid-turn, three hand-offs land as three interruptions of one turn and come
   * back as one confused answer. So the card is the queue, and this is what
   * tells the delivery it is already in a line rather than owed a prompt.
   *
   * The message is still written to the inbox either way - the queue decides
   * when somebody is *told*, not whether the mail exists.
   */
  queued?: string
}

export type Delivery = { to: string; msg: Message }

/**
 * How long a file may be unreadable before it counts as broken rather than busy.
 *
 * An agent writes its mail with a shell heredoc, and for a moment the file on
 * disk is half a JSON object. Several poll ticks: a message worth sending is
 * worth waiting a couple of seconds for.
 */
const HALF_WRITTEN_MS = 3000

/**
 * Reserved recipient: mail addressed here is a question for the human, not for
 * another agent. It is not dead mail - it surfaces in the ask-me queue and the
 * human's reply is routed back into the asker's inbox like any other message.
 */
export const HUMAN = 'you'

/**
 * What those two are called on this floor.
 *
 * `you` and `hire` are the defaults and what every brief Bullpen ships uses,
 * but they are words in a message rather than mechanism: a floor that addresses
 * its operator as `boss` says so in its workflow, and the router has to answer
 * to that instead. Set by main whenever a workflow is applied.
 */
export type Reserved = { human: string; hire: string; board: string }

/**
 * Reserved recipient: a request to hire. Michael has to be able to put someone
 * on a project that has nobody free, and the alternative - an IPC only the UI
 * can call - is a capability he could never reach.
 *
 * `subject` is the project, `body` is the briefing the new agent starts with,
 * and `cwd` names the directory when the project does not exist yet.
 */
const HIRE = 'hire'

/**
 * Reserved recipient: the task list itself.
 *
 * Agents read `$BULLPEN_TASKS` directly - it is a file - but nothing may write
 * to it except main, or two agents reading the same list at the same moment
 * both come away holding the same card. So a change to the board is a message
 * like any other, and main is the only writer.
 */
const BOARD = 'board'

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

  /**
   * Who is allowed to write to whom. Return a reason to refuse, null to deliver.
   *
   * The router is the only place this can be enforced: an agent writes a file
   * and the file is the message, so a rule that lives anywhere else is a rule
   * the sender can decline to follow. Unset means the old behaviour - anyone
   * may write to anyone.
   */
  gate: ((from: string, to: string, msg: Message) => string | null) | null = null

  /**
   * Whether an id is an agent that is up right now, rather than a folder.
   *
   * A mailbox outlives its agent on purpose - `forget` empties it and leaves
   * the directory standing, because the directory is what `list()` walks. So
   * `agents` is a list of everyone who has ever been here, and reading it as
   * "is this an id" is what broke a floor that later named a role after a dead
   * agent: `ba` was a leftover folder, so mail to the analyst was delivered
   * into it instead of reaching `staff`, no card was opened, nobody read it,
   * and the sender was told off for writing to its own role.
   *
   * Unset means the old behaviour - a router with no app behind it has no
   * better answer than the directory listing.
   */
  live: ((id: string) => boolean) | null = null

  /**
   * Turn an address that is not an agent id into one.
   *
   * A message to `dev` used to die: `dev` is a role, not somebody, and an agent
   * handing work down had to know who was on the floor, whether they were free,
   * and how full their window was - before it could address the envelope. This
   * asks the app to answer all three, which may mean hiring somebody. Returning
   * null keeps the old behaviour: the message is dead and the sender is told.
   */
  staff: ((to: string, from: string, msg: Message) => string | null) | null = null

  /**
   * The two addresses that are not agents, under this floor's names for them.
   *
   * Defaults to `you` and `hire`, which is what they were when they were
   * constants - a floor that never renames them cannot tell the difference.
   */
  reserved: Reserved = { human: HUMAN, hire: HIRE, board: BOARD }

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

  /**
   * Empty an id's mailbox, both ways, and hand back how much was in it.
   *
   * Delivered mail is not consumed - the briefs tell every agent its mail is in
   * `$BULLPEN_MAILBOX/inbox`, so it stays there to be read. A name is free the
   * moment its agent stops, though, and the next hire on the next project is
   * given that name: it came up standing in front of nine messages about work
   * it had never done, on a floor whose roles had since changed, and its brief
   * told it to go and read them.
   *
   * The directory itself stays. `list()` is what the router walks, and an id it
   * cannot see is an id nothing can be addressed to.
   */
  forget(id: string): number {
    let gone = 0
    for (const box of ['inbox', 'outbox']) {
      const dir = join(this.agentDir(id), box)
      for (const name of this.jsonFiles(dir)) {
        rmSync(join(dir, name), { force: true })
        gone++
      }
    }
    return gone
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

        // Unreadable is not the same as unroutable. This used to delete the
        // file first and check afterwards, so a message caught mid-write was
        // gone: no delivery, no ack, no dead letter - indistinguishable to the
        // sender from a request nobody acted on. That is what silently ate a
        // round of hires. Left where it is until it has been broken long
        // enough to be broken rather than busy, and then it is dead mail with
        // its contents kept, not a file that never existed.
        if (!msg) {
          let age = 0
          try {
            age = Date.now() - statSync(path).mtimeMs
          } catch {
            continue
          }
          if (age < HALF_WRITTEN_MS) continue
          try {
            renameSync(path, join(this.root, 'dead', this.nextName()))
          } catch {
            rmSync(path, { force: true })
          }
          this.emit('dead', {
            from,
            to: '?',
            subject: `unreadable message ${name}`,
            body: 'The file did not parse as a message. It is in dead/ as it was written.',
            ts: Date.now()
          } satisfies Message)
          continue
        }
        rmSync(path, { force: true })

        // Refused mail is kept and answered, never dropped: the sender is a
        // model that will otherwise sit waiting for a reply to a message
        // nobody told it was against the rules.
        const refuse = (why: string): void => {
          writeFileSync(join(this.root, 'dead', this.nextName()), JSON.stringify(msg, null, 2))
          this.emit('blocked', msg, why)
        }

        const reserved = (
          [
            [this.reserved.human, 'question'],
            [this.reserved.hire, 'hire'],
            // Not gated. `talksTo` says who may write to whom, and the board is
            // not a whom - a floor that had to draw a line to it before anybody
            // could say they had finished would be a floor where forgetting that
            // line silently froze every card on it.
            [this.reserved.board, 'board']
          ] as const
        ).find(([name]) => name === msg.to)
        if (reserved) {
          const [, event] = reserved
          const why = event === 'board' ? null : (this.gate?.(msg.from, msg.to, msg) ?? null)
          if (why) {
            refuse(why)
            continue
          }
          this.emit(event, msg)
          continue
        }

        // An id if it is one, otherwise whoever the app puts in that role.
        // "Is one" is a running process where the app can say - see `live`. A
        // bare directory is not somebody, and reading it as one is what silently
        // ate every message addressed to a role whose name a dead agent had.
        const isAgent = this.live ? this.live(msg.to) : agents.includes(msg.to)
        const named =
          msg.to === '*' || isAgent ? msg.to : (this.staff?.(msg.to, from, msg) ?? msg.to)
        // `agents` is the snapshot this sweep opened with, and `staff` is
        // allowed to hire - so the one name it is most likely to return is the
        // one name that snapshot cannot contain. Asking it anyway is what made
        // a hire swallow the message that caused it: somebody was hired, given
        // a card, and never told what the work was, which reads from every
        // angle as an agent that is simply slow.
        //
        // Re-listed only when the snapshot misses, so the ordinary path is
        // still one readdir per sweep rather than one per message.
        const known = (id: string): boolean => agents.includes(id) || this.list().includes(id)
        const addressed =
          named === '*' ? agents.filter((a) => a !== from) : known(named) ? [named] : []
        // Per target, so a broadcast reaches the part of the floor it is
        // allowed to reach rather than being refused whole.
        const blocked = addressed
          .map((to) => [to, this.gate?.(msg.from, to, msg) ?? null] as const)
          .filter((pair): pair is readonly [string, string] => pair[1] !== null)
        const targets = addressed.filter((to) => !blocked.some(([id]) => id === to))
        if (targets.length === 0 && blocked.length > 0) {
          refuse(blocked[0][1])
          continue
        }

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
