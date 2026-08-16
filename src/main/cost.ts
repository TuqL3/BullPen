import { openSync, readSync, closeSync, statSync } from 'node:fs'

/**
 * List prices per million tokens, from the Anthropic pricing table.
 *
 * These are API list rates. On a Claude Max or Pro subscription no per-token
 * charge is made at all, so everything derived from these numbers is an
 * API-equivalent figure, not money spent - see `Cost.notional`.
 *
 * Cache multipliers are the published ones: a 5-minute write costs 1.25x input,
 * a 1-hour write 2x, and a read 0.1x.
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 }
}

export const CACHE_WRITE_5M = 1.25
export const CACHE_WRITE_1H = 2
export const CACHE_READ = 0.1

export type Totals = {
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  turns: number
  /** Models seen in this transcript, in first-seen order. */
  models: string[]
  /** Tokens whose model has no published price, so they are counted but unpriced. */
  unpricedTokens: number
}

export type Cost = Totals & {
  /** API-equivalent dollars. Not money spent on a subscription plan. */
  usd: number
  /** True when every token seen had a known price. */
  complete: boolean
}

export const emptyTotals = (): Totals => ({
  input: 0,
  output: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  turns: 0,
  models: [],
  unpricedTokens: 0
})

/** Strip the context-window suffix: the 1M variant is billed at the same rate. */
export const priceKey = (model: string): string => model.replace(/\[1m\]$/i, '')

export function priceOf(model: string): { input: number; output: number } | null {
  return PRICES[priceKey(model)] ?? null
}

const num = (o: Record<string, unknown> | undefined, k: string): number =>
  o && typeof o[k] === 'number' ? (o[k] as number) : 0

/** Fold one transcript line into the running totals. Unknown lines are ignored. */
export function addLine(totals: Totals, line: string): void {
  let entry: { type?: string; message?: { model?: string; usage?: Record<string, unknown> } }
  try {
    entry = JSON.parse(line)
  } catch {
    return
  }
  const usage = entry.message?.usage
  if (entry.type !== 'assistant' || !usage) return

  const model = entry.message?.model ?? ''
  const creation = usage.cache_creation as Record<string, unknown> | undefined

  const input = num(usage, 'input_tokens')
  const output = num(usage, 'output_tokens')
  const read = num(usage, 'cache_read_input_tokens')
  // Prefer the per-TTL split; fall back to the flat total, charged as 5m.
  const w1h = num(creation, 'ephemeral_1h_input_tokens')
  const w5m = creation
    ? num(creation, 'ephemeral_5m_input_tokens')
    : num(usage, 'cache_creation_input_tokens')

  if (input + output + read + w5m + w1h === 0) return

  totals.turns += 1
  totals.input += input
  totals.output += output
  totals.cacheRead += read
  totals.cacheWrite5m += w5m
  totals.cacheWrite1h += w1h
  if (model && !totals.models.includes(model)) totals.models.push(model)
  if (!priceOf(model)) totals.unpricedTokens += input + output + read + w5m + w1h
}

/**
 * Price the totals. Mixed-model transcripts are charged at the newest model's
 * rate, which is stated in the result rather than hidden: splitting per model
 * would need per-turn accounting, and the mix is rare enough not to justify it.
 */
export function priceTotals(totals: Totals): Cost {
  const priced = totals.models.map(priceOf).filter(Boolean) as { input: number; output: number }[]
  const rate = priced.at(-1) ?? null
  const per = (tokens: number, dollarsPerMillion: number) => (tokens / 1_000_000) * dollarsPerMillion

  const usd = rate
    ? per(totals.input, rate.input) +
      per(totals.output, rate.output) +
      per(totals.cacheWrite5m, rate.input * CACHE_WRITE_5M) +
      per(totals.cacheWrite1h, rate.input * CACHE_WRITE_1H) +
      per(totals.cacheRead, rate.input * CACHE_READ)
    : 0

  return { ...totals, usd, complete: totals.unpricedTokens === 0 && rate !== null }
}

/**
 * Per-agent reader state. Holds the byte offset already consumed so a growing
 * transcript is parsed once rather than re-read on every turn - these files
 * reach tens of megabytes over a session.
 */
export type Meter = {
  offset: number
  /** Bytes after the last newline, carried into the next read. */
  partial: string
  totals: Totals
}

export const newMeter = (): Meter => ({ offset: 0, partial: '', totals: emptyTotals() })

/**
 * Consume everything appended since the last call and return the running cost.
 *
 * A file that shrank was rotated or replaced, so the meter restarts rather than
 * reading from a stale offset and mis-parsing the middle of a record.
 */
export function update(meter: Meter, path: string): Cost {
  let fd: number | null = null
  try {
    const size = statSync(path).size
    if (size < meter.offset) {
      meter.offset = 0
      meter.partial = ''
      meter.totals = emptyTotals()
    }
    if (size > meter.offset) {
      const length = size - meter.offset
      const buf = Buffer.alloc(length)
      fd = openSync(path, 'r')
      readSync(fd, buf, 0, length, meter.offset)
      meter.offset = size

      const text = meter.partial + buf.toString('utf8')
      const lines = text.split('\n')
      // The last element is whatever follows the final newline - possibly a
      // half-written record, so it waits for the rest of its bytes.
      meter.partial = lines.pop() ?? ''
      for (const line of lines) addLine(meter.totals, line)
    }
  } catch {
    // Missing or unreadable transcript: report what has been counted so far.
  } finally {
    if (fd !== null) closeSync(fd)
  }
  return priceTotals(meter.totals)
}
