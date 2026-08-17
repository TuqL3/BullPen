/**
 * What the monitor says about a floor, as plain functions.
 *
 * Kept out of the component so the rules that decide "stuck" and "quiet" are
 * testable: they are the only part of the monitor that can be wrong rather than
 * merely ugly, and a wrong one either cries wolf or hides an agent that died
 * mid-turn.
 */

/** Only what these rules read - the store's Agent satisfies it structurally. */
export type FleetAgent = {
  id: string
  status: 'running' | 'exited'
  activity: 'idle' | 'working' | 'blocked'
  asked?: string | null
}

/**
 * How long a working agent may produce nothing before it is worth a second look.
 *
 * Long turns are normal: the model thinks, a build runs, a test suite grinds.
 * Three minutes of complete silence is not proof of a hang - it is the point
 * where a human should be told, which is all the flag claims.
 */
export const QUIET_AFTER_MS = 3 * 60_000

/**
 * A working agent that has printed nothing for a while.
 *
 * Deliberately not called "stuck": Bullpen cannot know that. `lastOutput` of 0
 * means nothing has ever been seen from it, which is normal in the first
 * seconds of a spawn, so it is measured from `startedAt` instead.
 */
export function isQuiet(
  a: FleetAgent,
  lastOutput: number,
  startedAt: number,
  now: number,
  after = QUIET_AFTER_MS
): boolean {
  if (a.status !== 'running' || a.activity !== 'working') return false
  const since = lastOutput || startedAt
  if (!since) return false
  return now - since >= after
}

export type Summary = {
  hired: number
  working: number
  waiting: number
  quiet: number
  stopped: number
}

/**
 * The counts across a floor. `waiting` counts agents, not questions: two
 * questions from one agent is still one person to go and talk to.
 */
export function summarise(
  agents: FleetAgent[],
  lastSeen: Record<string, number>,
  startedAt: Record<string, number>,
  now: number
): Summary {
  const running = agents.filter((a) => a.status === 'running')
  return {
    hired: agents.length,
    working: running.filter((a) => a.activity === 'working').length,
    waiting: agents.filter((a) => a.activity === 'blocked' || a.asked).length,
    quiet: running.filter((a) => isQuiet(a, lastSeen[a.id] ?? 0, startedAt[a.id] ?? 0, now)).length,
    stopped: agents.filter((a) => a.status === 'exited').length
  }
}

/** `4m 12s`, `2h 06m`, and `—` for a timestamp nobody ever set. */
export function ago(ts: number, now: number): string {
  if (!ts) return '—'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}
