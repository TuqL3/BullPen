import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

export type Task = {
  id: string
  agentId: string
  text: string
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

type Data = { tasks: Task[]; triggers: Trigger[] }

const EMPTY: Data = { tasks: [], triggers: [] }

/**
 * Tasks and scheduled prompts, in one small JSON file.
 *
 * Deliberately not SQLite: this is a few dozen rows a human typed, and `cat
 * board.json` beats a query tool for everything that has been needed so far.
 */
export class Board extends EventEmitter {
  readonly file: string
  private data: Data = { tasks: [], triggers: [] }
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
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        triggers: Array.isArray(parsed.triggers) ? parsed.triggers : []
      }
    } catch {
      // Missing or corrupt: start clean rather than refuse to boot. Losing a
      // scratch task list is not worth blocking the whole app over.
      this.data = { ...EMPTY, tasks: [], triggers: [] }
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

  addTask(agentId: string, text: string): Task | null {
    const clean = text.trim()
    if (!clean) return null
    const task: Task = { id: randomUUID(), agentId, text: clean, done: false, createdAt: Date.now() }
    this.data.tasks.push(task)
    this.save()
    return task
  }

  toggleTask(id: string): void {
    const t = this.data.tasks.find((x) => x.id === id)
    if (!t) return
    t.done = !t.done
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
  due(now: number): Trigger[] {
    const ready = this.data.triggers.filter(
      (t) => t.enabled && now - t.lastRun >= t.everyMinutes * 60_000
    )
    if (ready.length === 0) return []
    for (const t of ready) t.lastRun = now
    this.save()
    return ready
  }

  /** Poll for due triggers. `fire` decides whether the agent can take it. */
  start(fire: (t: Trigger) => void, intervalMs = 30_000): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      try {
        for (const t of this.due(Date.now())) fire(t)
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
