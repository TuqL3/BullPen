import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  addLine,
  emptyTotals,
  newMeter,
  priceOf,
  priceTotals,
  update
} from '../src/main/cost.ts'

/** Shaped like a real transcript entry, including the per-TTL cache split. */
const turn = (
  model: string,
  u: Partial<{
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    w5m: number
    w1h: number
  }> = {}
): string =>
  JSON.stringify({
    type: 'assistant',
    message: {
      model,
      usage: {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: (u.w5m ?? 0) + (u.w1h ?? 0),
        cache_creation: {
          ephemeral_5m_input_tokens: u.w5m ?? 0,
          ephemeral_1h_input_tokens: u.w1h ?? 0
        }
      }
    }
  })

test('prices each token class at its published multiple of the input rate', () => {
  const t = emptyTotals()
  // 1M of each class on Opus 5: $5 in, $25 out, 1.25x/2x writes, 0.1x read.
  addLine(t, turn('claude-opus-5', { input_tokens: 1_000_000 }))
  addLine(t, turn('claude-opus-5', { output_tokens: 1_000_000 }))
  addLine(t, turn('claude-opus-5', { w5m: 1_000_000 }))
  addLine(t, turn('claude-opus-5', { w1h: 1_000_000 }))
  addLine(t, turn('claude-opus-5', { cache_read_input_tokens: 1_000_000 }))

  const cost = priceTotals(t)
  assert.equal(cost.turns, 5)
  // 5 + 25 + 6.25 + 10 + 0.50
  assert.equal(Number(cost.usd.toFixed(2)), 46.75)
  assert.equal(cost.complete, true)
})

test('per-model rates differ and are applied, not assumed', () => {
  for (const [model, expected] of [
    ['claude-opus-5', 5 + 25],
    ['claude-sonnet-5', 3 + 15],
    ['claude-haiku-4-5', 1 + 5]
  ] as const) {
    const t = emptyTotals()
    addLine(t, turn(model, { input_tokens: 1_000_000, output_tokens: 1_000_000 }))
    assert.equal(Number(priceTotals(t).usd.toFixed(2)), expected, model)
  }
})

test('the 1M-context variant bills at the base rate', () => {
  // A long-context premium would silently inflate every figure if assumed.
  assert.deepEqual(priceOf('claude-opus-5[1m]'), priceOf('claude-opus-5'))
  const t = emptyTotals()
  addLine(t, turn('claude-opus-5[1m]', { input_tokens: 1_000_000 }))
  assert.equal(priceTotals(t).usd, 5)
})

test('an unknown model is counted but never silently priced', () => {
  const t = emptyTotals()
  addLine(t, turn('some-future-model', { input_tokens: 500_000, output_tokens: 10_000 }))
  const cost = priceTotals(t)
  assert.equal(cost.input, 500_000, 'tokens still counted')
  assert.equal(cost.unpricedTokens, 510_000)
  assert.equal(cost.complete, false, 'must not claim a complete figure')
  assert.equal(cost.usd, 0, 'a guessed price is worse than no price')
})

test('non-assistant lines, junk, and empty usage are ignored', () => {
  const t = emptyTotals()
  for (const line of [
    '',
    'not json',
    JSON.stringify({ type: 'user', message: { usage: { input_tokens: 999 } } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } }),
    turn('claude-opus-5')
  ]) {
    addLine(t, line)
  }
  assert.equal(t.turns, 0)
  assert.equal(t.input, 0)
})

test('incremental reads match a single full read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullpen-cost-'))
  const file = join(dir, 't.jsonl')
  const lines = [
    turn('claude-opus-5', { input_tokens: 100, output_tokens: 200, w5m: 300 }),
    turn('claude-opus-5', { cache_read_input_tokens: 4000 }),
    turn('claude-opus-5', { output_tokens: 50, w1h: 60 })
  ]

  writeFileSync(file, lines[0] + '\n')
  const meter = newMeter()
  update(meter, file)
  appendFileSync(file, lines[1] + '\n')
  update(meter, file)
  appendFileSync(file, lines[2] + '\n')
  const incremental = update(meter, file)

  const oneShot = newMeter()
  const full = update(oneShot, file)

  assert.deepEqual(
    { ...incremental, models: [...incremental.models] },
    { ...full, models: [...full.models] },
    'reading in chunks must total the same as reading once'
  )
  assert.equal(incremental.turns, 3)
  rmSync(dir, { recursive: true, force: true })
})

test('a half-written final line is not double counted when it completes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullpen-cost-'))
  const file = join(dir, 't.jsonl')
  const line = turn('claude-opus-5', { output_tokens: 1000 })
  const cut = Math.floor(line.length / 2)

  writeFileSync(file, line.slice(0, cut))
  const meter = newMeter()
  assert.equal(update(meter, file).turns, 0, 'a partial record must not be parsed')

  appendFileSync(file, line.slice(cut) + '\n')
  const cost = update(meter, file)
  assert.equal(cost.turns, 1, 'and must be counted exactly once when complete')
  assert.equal(cost.output, 1000)
  rmSync(dir, { recursive: true, force: true })
})

test('a rotated or truncated transcript restarts instead of mis-parsing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullpen-cost-'))
  const file = join(dir, 't.jsonl')
  writeFileSync(file, turn('claude-opus-5', { output_tokens: 900 }) + '\n')
  const meter = newMeter()
  assert.equal(update(meter, file).output, 900)

  // Replaced by a shorter file: reading from the old offset would land
  // mid-record and quietly produce nonsense.
  writeFileSync(file, turn('claude-opus-5', { output_tokens: 7 }) + '\n')
  const cost = update(meter, file)
  assert.equal(cost.output, 7)
  assert.equal(cost.turns, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('a missing transcript yields zeroes, never a throw', () => {
  const meter = newMeter()
  const cost = update(meter, '/nonexistent/transcript.jsonl')
  assert.equal(cost.turns, 0)
  assert.equal(cost.usd, 0)
})

test('cache reads are an order of magnitude cheaper than fresh input', () => {
  // The whole point of caching; a sign error here would make caching look bad.
  const fresh = emptyTotals()
  addLine(fresh, turn('claude-opus-5', { input_tokens: 1_000_000 }))
  const cached = emptyTotals()
  addLine(cached, turn('claude-opus-5', { cache_read_input_tokens: 1_000_000 }))
  assert.equal(priceTotals(fresh).usd / priceTotals(cached).usd, 10)
})
