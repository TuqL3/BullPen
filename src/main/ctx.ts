import { openSync, readSync, closeSync, statSync } from 'node:fs'

export type Ctx = {
  used: number
  limit: number
  pct: number
  model: string
}

const ONE_MILLION = 1_000_000
const TWO_HUNDRED_K = 200_000

/**
 * The context window a model actually has.
 *
 * This used to key off the `[1m]` suffix, which is a Claude Code selector and
 * not part of the model's identity: a transcript written by a 1M session still
 * records `claude-opus-5`, so the meter reported 200k for a window five times
 * that and every percentage was five times too high.
 *
 * Matched on the family rather than the exact id, so a dated release
 * (`claude-opus-5-20260101`) lands on the same row as the alias.
 */
const WINDOWS: { test: RegExp; limit: number }[] = [
  // Haiku is the small window; check it before the generic 4.x rule below.
  { test: /haiku/i, limit: TWO_HUNDRED_K },
  { test: /opus-?5|sonnet-?5|fable-?5|mythos-?5/i, limit: ONE_MILLION },
  { test: /opus-?4[-.]?[678]|sonnet-?4[-.]?6/i, limit: ONE_MILLION }
]

/** Anything unrecognised. Under-reporting the window overstates the pressure,
 *  which is the safer way to be wrong about how much room is left. */
const DEFAULT_LIMIT = TWO_HUNDRED_K

export function limitForModel(model: string): number {
  // An explicit [1m] still wins: it is only ever set on a 1M session.
  if (/\[1m\]/i.test(model)) return ONE_MILLION
  return WINDOWS.find((w) => w.test.test(model))?.limit ?? DEFAULT_LIMIT
}

/**
 * Context used by the most recent assistant turn.
 *
 * The prompt the model saw is everything it read: fresh input, plus whatever
 * came from cache. Output tokens are not part of the window on the next turn's
 * way in, so they are deliberately excluded - counting them would drift high.
 */
export function usageFromLine(line: string): Ctx | null {
  let entry: {
    type?: string
    message?: { model?: string; usage?: Record<string, unknown> }
  }
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  const usage = entry.message?.usage
  if (entry.type !== 'assistant' || !usage) return null

  const n = (k: string): number => (typeof usage[k] === 'number' ? (usage[k] as number) : 0)
  const used = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens')
  if (used <= 0) return null

  const model = entry.message?.model ?? ''
  const limit = limitForModel(model)
  return { used, limit, pct: Math.min(100, Math.round((used / limit) * 100)), model }
}

/** How much of a transcript to look at. Only the tail can hold the last turn. */
export const TAIL_BYTES = 512 * 1024

/**
 * Read the tail of a transcript and return the newest usable usage record.
 *
 * ponytail: reads a fixed tail rather than streaming the file. A long session
 * transcript reaches tens of megabytes and re-reading it on every turn would be
 * the most expensive thing this app does. Ceiling: a single turn whose JSON line
 * is larger than the tail is invisible - it reports the previous turn instead of
 * lying, which is the right failure.
 */
export function readCtx(path: string): Ctx | null {
  let fd: number | null = null
  try {
    const size = statSync(path).size
    if (size === 0) return null
    const start = Math.max(0, size - TAIL_BYTES)
    const length = size - start
    const buf = Buffer.alloc(length)
    fd = openSync(path, 'r')
    readSync(fd, buf, 0, length, start)

    const text = buf.toString('utf8')
    const lines = text.split('\n')
    // A partial first line is expected when the tail cuts mid-record.
    for (let i = lines.length - 1; i >= 1; i--) {
      const ctx = usageFromLine(lines[i])
      if (ctx) return ctx
    }
    // Only trust line 0 when the whole file fit in the tail.
    return start === 0 ? usageFromLine(lines[0]) : null
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * Environment variables that must not reach a spawned agent.
 *
 * Bullpen may itself be launched from inside a Claude Code session, and the
 * child-session marker it exports turns transcript saving OFF in any `claude`
 * that inherits it - which silently removes the only structured source of
 * context and cost data. Stripping the whole CLAUDE_CODE_ prefix also stops an
 * agent inheriting session identity that is not its own.
 */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('CLAUDE_CODE_')) continue
    if (k === 'CLAUDECODE') continue
    out[k] = v
  }
  return out
}
