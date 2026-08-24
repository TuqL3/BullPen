import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * A column key, which is the workflow's word rather than this file's.
 *
 * It was a union of five: `todo | doing | wait_test | blocked | done`. Those
 * are still what a board written before columns were configurable has in it,
 * and still the default names - but a floor that calls its columns `briefed`
 * and `in_review` stores those, and a board that refused to save them would be
 * a board that silently disagreed with the one on screen.
 *
 * `done` is the one word this file still knows: a card in it is finished, which
 * is what "the card an agent is on" is the absence of. A workflow that renames
 * that column says so with `(done)`, and main resolves it before it gets here.
 */
export type TaskStatus = string

export type Task = {
  id: string
  /** Who the card is assigned to. Empty means unassigned. */
  agentId: string
  text: string
  status: TaskStatus
  /** Kept so boards written before statuses existed still load. */
  done: boolean
  createdAt: number
  /**
   * Who handed it over, when somebody did.
   *
   * Absent on a card typed in by hand, which nobody handed over. It is here
   * rather than only in the activity log because a card is the thing an agent
   * reads back later, and "who is waiting on this" is the first question it
   * has - the log answers that for a person watching, not for an agent.
   */
  by?: string
  /**
   * The role this is work for.
   *
   * Set when the card was opened for a role rather than for a person, which is
   * how anything unassigned can be found by somebody able to do it. A card
   * opened by name does not need one: the name already says who.
   */
  role?: string
  /**
   * The card this one is a check of.
   *
   * A checker's card is not work of its own - it is somebody else's build,
   * being looked at. Without the link the only way to find that build was
   * "every card waiting, on this project", so one pass closed every feature
   * under test at once. The link is set where the check is handed over,
   * because that is the one moment both cards are in hand.
   */
  checks?: string
}

export type Trigger = {
  id: string
  agentId: string
  prompt: string
  everyMinutes: number
  enabled: boolean
  lastRun: number
}

/**
 * What to do when an agent's context fills up.
 *
 * One per agent, because "compact at 80%" is a property of the agent rather
 * than a list of things to do. `armed` is what stops it firing on every read
 * while the window sits above the line: it re-arms once usage drops back under.
 */
export type ContextRule = {
  agentId: string
  atPct: number
  action: 'compact' | 'clear'
  enabled: boolean
  lastRun: number
  armed: boolean
}

type Data = { tasks: Task[]; triggers: Trigger[]; rules: ContextRule[] }

const EMPTY: Data = { tasks: [], triggers: [], rules: [] }

/**
 * Tasks and scheduled prompts, in one small JSON file.
 *
 * Deliberately not SQLite: this is a few dozen rows a human typed, and `cat
 * board.json` beats a query tool for everything that has been needed so far.
 */
export class Board extends EventEmitter {
  readonly file: string
  private data: Data = { tasks: [], triggers: [], rules: [] }
  private timer: NodeJS.Timeout | null = null

  constructor(file: string) {
    super()
    this.file = file
    mkdirSync(dirname(file), { recursive: true })
    this.load()
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Data>
      this.data = {
        // Boards written before statuses existed carry only `done`; derive the
        // column from it rather than dropping the card into an unknown state.
        tasks: (Array.isArray(parsed.tasks) ? parsed.tasks : []).map((t) => ({
          ...t,
          status:
            typeof t?.status === 'string' && t.status.trim()
              ? t.status
              : t?.done
                ? 'done'
                : 'todo'
        })),
        triggers: Array.isArray(parsed.triggers) ? parsed.triggers : [],
        rules: Array.isArray(parsed.rules) ? parsed.rules : []
      }
    } catch {
      // Missing or corrupt: start clean rather than refuse to boot. Losing a
      // scratch task list is not worth blocking the whole app over.
      this.data = { ...EMPTY, tasks: [], triggers: [], rules: [] }
    }
  }

  private save(): void {
    // Write-then-rename: a crash mid-write leaves the previous file intact
    // instead of a truncated one that would fail to parse on next boot.
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
  }

  /**
   * Every card, or one agent's.
   *
   * `undefined` means all of them; `''` means the ones nobody holds. That used
   * to be one answer - `!agentId` is true for both - which was harmless while
   * an unheld card could not exist, and a trap the moment one could: asking for
   * the unclaimed pile handed back the whole board, and `openCard('')` would
   * have picked the newest card on the floor and called it somebody's.
   */
  tasks(agentId?: string): Task[] {
    if (agentId === undefined) return [...this.data.tasks]
    return this.data.tasks.filter((t) => t.agentId === agentId)
  }

  /**
   * `status` defaults to `todo` for callers with no floor in hand - the tests,
   * and nothing else. Anything in main knows which floor is running and must
   * pass its starting column: `todo` is one board's word, not every board's,
   * and storing it on a floor without that column loses the card.
   */
  addTask(
    agentId: string,
    text: string,
    status: TaskStatus = 'todo',
    meta: { by?: string; role?: string; checks?: string } = {}
  ): Task | null {
    const clean = text.trim()
    if (!clean) return null
    const task: Task = {
      id: randomUUID(),
      agentId,
      text: clean,
      status,
      done: status === 'done',
      createdAt: Date.now(),
      ...(meta.by ? { by: meta.by } : {}),
      ...(meta.role ? { role: meta.role } : {}),
      ...(meta.checks ? { checks: meta.checks } : {})
    }
    this.data.tasks.push(task)
    this.save()
    return task
  }

  /** One card by id, or undefined. The lookup a message carrying an id needs. */
  task(id: string): Task | undefined {
    return this.data.tasks.find((t) => t.id === id)
  }

  /**
   * Put a name on a card that has none.
   *
   * Refused when somebody already holds it, and that refusal is the whole
   * point: two agents reading the same list at the same moment both see it
   * free, and only one of them may come away with it.
   */
  claim(id: string, agentId: string): boolean {
    const t = this.task(id)
    if (!t || !agentId.trim() || t.agentId) return false
    t.agentId = agentId
    this.save()
    return true
  }

  setTaskStatus(id: string, status: TaskStatus): void {
    const t = this.data.tasks.find((x) => x.id === id)
    // No vocabulary check here: the columns are the workflow's, and this file
    // is not given one. Main only ever passes a key it read off the board.
    if (!t || !status.trim()) return
    t.status = status
    // Kept for boards written before columns had names, and for nothing else:
    // whether a card is finished is the workflow's answer now, and main asks it
    // by key. A floor that calls its last column `published` leaves this false,
    // which is only ever read by a board old enough to have no status at all.
    t.done = status === 'done'
    this.save()
  }

  removeTask(id: string): void {
    this.data.tasks = this.data.tasks.filter((t) => t.id !== id)
    this.save()
  }

  /**
   * Everything this board holds under one agent id, gone.
   *
   * A name is only taken while its agent is running: fire the developer called
   * `morgan` and the next hire on any project can be called `morgan` too. The
   * board is keyed by id, so that new agent opened onto eight cards from a
   * project it had never been near - work it had not been given, in columns the
   * floor no longer had. The schedules and the context rule go with them for
   * the same reason: both fire at an id, and neither was meant for whoever is
   * standing under that name now.
   */
  forget(agentId: string): number {
    const held = (d: Data): number => d.tasks.length + d.triggers.length + d.rules.length
    const before = held(this.data)
    this.data.tasks = this.data.tasks.filter((t) => t.agentId !== agentId)
    this.data.triggers = this.data.triggers.filter((t) => t.agentId !== agentId)
    this.data.rules = this.data.rules.filter((r) => r.agentId !== agentId)
    const gone = before - held(this.data)
    if (gone) this.save()
    return gone
  }

  /**
   * Every card, gone. The schedules and rules stay.
   *
   * Applying a floor replaces the columns a card can be in, and a card carries
   * the key of a column that may not exist on the new one - so what was on the
   * board is not merely stale, it is unreachable: not in any column, and not
   * shown anywhere. Schedules and context rules are the operator's own setup
   * rather than the floor's work, and an agent that survives the switch keeps
   * both.
   */
  clearTasks(): number {
    const gone = this.data.tasks.length
    if (!gone) return 0
    this.data.tasks = []
    this.save()
    return gone
  }

  triggers(agentId?: string): Trigger[] {
    return this.data.triggers.filter((t) => !agentId || t.agentId === agentId)
  }

  addTrigger(agentId: string, prompt: string, everyMinutes: number): Trigger | null {
    const clean = prompt.trim()
    // A zero or negative interval would fire on every tick forever, which with
    // a paid CLI behind it is a way to burn money in a loop.
    if (!clean || !Number.isFinite(everyMinutes) || everyMinutes < 1) return null
    const trigger: Trigger = {
      id: randomUUID(),
      agentId,
      prompt: clean,
      everyMinutes: Math.floor(everyMinutes),
      enabled: true,
      lastRun: 0
    }
    this.data.triggers.push(trigger)
    this.save()
    return trigger
  }

  toggleTrigger(id: string): void {
    const t = this.data.triggers.find((x) => x.id === id)
    if (!t) return
    t.enabled = !t.enabled
    this.save()
  }

  removeTrigger(id: string): void {
    this.data.triggers = this.data.triggers.filter((t) => t.id !== id)
    this.save()
  }

  /**
   * Triggers whose interval has elapsed. Marks them run in the same step, so a
   * slow tick cannot fire the same trigger twice.
   */
  /**
   * Which schedules are ready, without claiming them.
   *
   * Stamping here was wrong: a trigger for a busy agent is not delivered - the
   * caller drops it - and stamping it anyway spent the interval on a prompt
   * nobody received, so an hourly trigger silently skipped the hour whenever
   * the agent happened to be mid-turn. The caller stamps what it delivers.
   */
  due(now: number): Trigger[] {
    return this.data.triggers.filter(
      (t) => t.enabled && now - t.lastRun >= t.everyMinutes * 60_000
    )
  }

  /** Say a schedule was delivered, which is what starts its next interval. */
  markRun(id: string, now = Date.now()): void {
    const t = this.data.triggers.find((x) => x.id === id)
    if (!t) return
    t.lastRun = now
    this.save()
  }

  rules(agentId?: string): ContextRule[] {
    return this.data.rules.filter((r) => !agentId || r.agentId === agentId)
  }

  /**
   * Set (or replace) an agent's context rule.
   *
   * Refused below 10% or above 99: a rule that fires at 5% compacts a fresh
   * session on its second turn, and one at 100 never fires at all.
   */
  setRule(agentId: string, atPct: number, action: ContextRule['action']): ContextRule | null {
    if (!agentId || !Number.isFinite(atPct) || atPct < 10 || atPct > 99) return null
    if (action !== 'compact' && action !== 'clear') return null
    const rule: ContextRule = {
      agentId,
      atPct: Math.floor(atPct),
      action,
      enabled: true,
      lastRun: this.data.rules.find((r) => r.agentId === agentId)?.lastRun ?? 0,
      armed: true
    }
    this.data.rules = [...this.data.rules.filter((r) => r.agentId !== agentId), rule]
    this.save()
    return rule
  }

  toggleRule(agentId: string): void {
    const r = this.data.rules.find((x) => x.agentId === agentId)
    if (!r) return
    r.enabled = !r.enabled
    // Coming back on with the window already full should act, not wait for it
    // to empty first.
    if (r.enabled) r.armed = true
    this.save()
  }

  removeRule(agentId: string): void {
    this.data.rules = this.data.rules.filter((r) => r.agentId !== agentId)
    this.save()
  }

  /**
   * Whether this reading should fire the agent's rule, arming it as it goes.
   *
   * Hysteresis of 5 points: a window sitting on the line would otherwise
   * compact, read a percent under, and compact again on the next turn.
   */
  ruleDue(agentId: string, pct: number): ContextRule | null {
    const r = this.data.rules.find((x) => x.agentId === agentId)
    if (!r || !r.enabled) return null
    if (!r.armed) {
      if (pct < r.atPct - 5) {
        r.armed = true
        this.save()
      }
      return null
    }
    if (pct < r.atPct) return null
    r.armed = false
    r.lastRun = Date.now()
    this.save()
    return r
  }

  /**
   * Poll for due triggers. `fire` decides whether the agent can take it, and
   * says so by returning true - anything else leaves the trigger due.
   */
  start(fire: (t: Trigger) => boolean | void, intervalMs = 30_000): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      try {
        const now = Date.now()
        for (const t of this.due(now)) if (fire(t) !== false) this.markRun(t.id, now)
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
}

export const boardPath = (root: string): string => join(root, 'board.json')
