import { EventEmitter } from 'node:events'

export type ActivityKind =
  | 'spawn'
  | 'exit'
  | 'message'
  | 'question'
  | 'answer'
  | 'trust'
  | 'steer'
  | 'trigger'
  | 'approval'
  /** An agent finished a turn it was working on, and what it said. */
  | 'done'
  | 'dead'

export type Activity = {
  id: number
  ts: number
  kind: ActivityKind
  /** Who acted. The god agent's own id, an agent id, or 'you'. */
  actor: string
  text: string
}

/**
 * One append-only stream of everything the floor did.
 *
 * Bullpen already emitted each of these as its own IPC channel, but a channel
 * per kind cannot answer "what happened, in order" - which is the only question
 * the activity view exists to answer.
 */
export class ActivityLog extends EventEmitter {
  private items: Activity[] = []
  private nextId = 1
  private readonly cap: number

  constructor(cap = 2000) {
    super()
    this.cap = cap
  }

  push(kind: ActivityKind, actor: string, text: string): Activity {
    const item: Activity = { id: this.nextId++, ts: Date.now(), kind, actor, text }
    this.items.push(item)
    // Bounded: an overnight run must not grow this without limit.
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap)
    this.emit('activity', item)
    return item
  }

  /** Newest first, which is the order the view reads in. */
  list(limit = 500): Activity[] {
    return this.items.slice(-limit).reverse()
  }

  clear(): void {
    this.items = []
  }
}
