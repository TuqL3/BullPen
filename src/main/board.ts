import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * `wait_test` is the column the test loop needed: a developer says it is built,
 * and that is not the same claim as "it works". Cards used to go from doing
 * straight to done on the developer's own word, which is the one report nobody
 * should take at face value.
 */
export type TaskStatus = 'todo' | 'doing' | 'wait_test' | 'blocked' | 'done'
export const TASK_STATUSES: TaskStatus[] = ['todo', 'doing', 'wait_test', 'blocked', 'done']

export type Task = {
  id: string
  /** Who the card is assigned to. Empty means unassigned. */
  agentId: string
  text: string
  status: TaskStatus
  /** Kept so boards written before statuses existed still load. */
  done: boolean
  createdAt: number
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
          status: TASK_STATUSES.includes(t?.status) ? t.status : t?.done ? 'done' : 'todo'
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

  tasks(agentId?: string): Task[] {
    return this.data.tasks.filter((t) => !agentId || t.agentId === agentId)
  }

  addTask(agentId: string, text: string, status: TaskStatus = 'todo'): Task | null {
    const clean = text.trim()
    if (!clean) return null
    const task: Task = {
      id: randomUUID(),
      agentId,
      text: clean,
      status,
      done: status === 'done',
      createdAt: Date.now()
    }
    this.data.tasks.push(task)
    this.save()
    return task
  }

  toggleTask(id: string): void {
    const t = this.data.tasks.find((x) => x.id === id)
    if (!t) return
    this.setTaskStatus(id, t.status === 'done' ? 'todo' : 'done')
  }

  setTaskStatus(id: string, status: TaskStatus): void {
    const t = this.data.tasks.find((x) => x.id === id)
    if (!t || !TASK_STATUSES.includes(status)) return
    t.status = status
    t.done = status === 'done'
    this.save()
  }

  assignTask(id: string, agentId: string): void {
    const t = this.data.tasks.find((x) => x.id === id)
    if (!t) return
    t.agentId = agentId
    this.save()
  }

  removeTask(id: string): void {
    this.data.tasks = this.data.tasks.filter((t) => t.id !== id)
    this.save()
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
