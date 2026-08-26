import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * One thing an agent put to the human, and what came back.
 *
 * `answeredAt` absent means it is still waiting. It is the same record either
 * way rather than two lists, because the question and its answer are the thing
 * worth reading back: an answer with no question above it says nothing, and a
 * question whose answer is gone is the state this file was written to end.
 */
export type Ask = {
  id: string
  /** The agent that asked. */
  from: string
  subject: string
  body: string
  ts: number
  answeredAt?: number
  answer?: string
  /** Waved away rather than answered. Still worth having been asked. */
  dismissedAt?: number
}

/**
 * The ask-me queue, on disk.
 *
 * It was a `Map` in main, and answering deleted the entry - so the question,
 * the wording of it and what was said back all went the moment they were dealt
 * with. What the human had already decided was then unknowable to them: two
 * agents could ask the same thing a day apart and there was no way to see the
 * first, or what it was told.
 *
 * Bounded, and the oldest answered go first: a question still waiting is never
 * dropped to make room, because dropping it is dropping an agent that is
 * blocked on it.
 *
 * ponytail: the cap is a file-size backstop, not a policy. 300 was low enough
 * that a floor left running for a week lost what it had been asked on Monday,
 * which is the whole reason this list is on disk. Raise it further, or page the
 * file, if a floor ever gets near 5000 questions in a session.
 */
export class Asks {
  private file: string
  private cap: number
  private data: Ask[] = []

  constructor(file: string, cap = 5000) {
    this.file = file
    this.cap = cap
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (Array.isArray(parsed)) this.data = parsed.filter((a): a is Ask => isAsk(a))
    } catch {
      // Missing or corrupt: an empty queue is a working app. Refusing to boot
      // over a history file would be the history costing more than it is worth.
      this.data = []
    }
  }

  private save(): void {
    // Write-then-rename, as everything else here does: a crash mid-write leaves
    // the previous file rather than a truncated one that reads as loss.
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
  }

  add(ask: Ask): Ask {
    this.data.push(ask)
    this.trim()
    this.save()
    return ask
  }

  /** Stamp the reply on it. Null if there is no such question, or it is answered. */
  answer(id: string, text: string): Ask | null {
    const ask = this.data.find((a) => a.id === id)
    if (!ask || ask.answeredAt || ask.dismissedAt) return null
    ask.answer = text
    ask.answeredAt = Date.now()
    this.save()
    return ask
  }

  dismiss(id: string): Ask | null {
    const ask = this.data.find((a) => a.id === id)
    if (!ask || ask.answeredAt || ask.dismissedAt) return null
    ask.dismissedAt = Date.now()
    this.save()
    return ask
  }

  /** Still waiting on a human. What the tab's badge counts. */
  pending(): Ask[] {
    return this.data.filter((a) => !a.answeredAt && !a.dismissedAt)
  }

  /** Everything, newest first - which is the order it is read in. */
  all(): Ask[] {
    return [...this.data].reverse()
  }

  /**
   * Oldest dealt-with first, and a question still waiting is never dropped.
   *
   * A floor left running overnight asks a great many things; the cap is about
   * the file, not about the queue. Trimming by age alone would eventually drop
   * the one question an agent is sitting blocked on.
   */
  private trim(): void {
    let over = this.data.length - this.cap
    if (over <= 0) return
    this.data = this.data.filter((a) => {
      if (over <= 0) return true
      if (!a.answeredAt && !a.dismissedAt) return true
      over--
      return false
    })
  }
}

function isAsk(a: unknown): a is Ask {
  const o = a as Partial<Ask> | null
  return Boolean(o && typeof o.id === 'string' && typeof o.from === 'string')
}

export const asksPath = (root: string): string => join(root, 'asks.json')

/**
 * A message to the human that is work being reported, not a thing being asked.
 *
 * Ask-me is the queue of things stopped on a person, and a floor that finishes
 * a task puts that in front of them the same way it puts a question - through
 * the same address, on the same line. So `done: the export` sat in the queue
 * looking like something to answer, and the queue stopped meaning "you are
 * holding somebody up". A report belongs on the monitor, which is where the
 * last one is already shown.
 *
 * `blocked` and `stuck` are deliberately not here. A worker saying it is stuck
 * is asking for a decision, which is the one thing this queue is for.
 */
export const REPORTING = /^\s*(re|report|done|fail|finished|shipped|delivered|update|status)\b/i
