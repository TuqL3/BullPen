import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QUIET_AFTER_MS, ago, isQuiet, summarise, type FleetAgent } from '../src/renderer/src/fleet.ts'

const NOW = 1_700_000_000_000
const agent = (over: Partial<FleetAgent> = {}): FleetAgent => ({
  id: 'dwight',
  status: 'running',
  activity: 'working',
  ...over
})

test('a working agent that has said nothing for a while is flagged', () => {
  const long = NOW - QUIET_AFTER_MS - 1
  assert.equal(isQuiet(agent(), long, long, NOW), true)
  assert.equal(isQuiet(agent(), NOW - 5_000, long, NOW), false, 'it just printed something')
})

test('quiet is only ever said about an agent that should be producing output', () => {
  const long = NOW - QUIET_AFTER_MS - 1
  // An idle agent is silent by definition, and a blocked one is silent because
  // it is waiting on a human. Flagging either would make the badge meaningless.
  assert.equal(isQuiet(agent({ activity: 'idle' }), long, long, NOW), false)
  assert.equal(isQuiet(agent({ activity: 'blocked' }), long, long, NOW), false)
  assert.equal(isQuiet(agent({ status: 'exited' }), long, long, NOW), false)
})

test('a freshly spawned agent is measured from its spawn, not from never', () => {
  // lastOutput 0 means nothing has been seen yet - which is the normal state
  // for the first seconds of a turn, not evidence of a hang.
  assert.equal(isQuiet(agent(), 0, NOW - 1_000, NOW), false)
  assert.equal(isQuiet(agent(), 0, NOW - QUIET_AFTER_MS - 1, NOW), true)
  assert.equal(isQuiet(agent(), 0, 0, NOW), false, 'nothing known at all is not a claim')
})

test('the summary counts people, not events', () => {
  const long = NOW - QUIET_AFTER_MS - 1
  const agents: FleetAgent[] = [
    agent({ id: 'a', activity: 'working' }),
    agent({ id: 'b', activity: 'working' }),
    agent({ id: 'c', activity: 'blocked' }),
    agent({ id: 'd', activity: 'idle', asked: 'where is seo?' }),
    agent({ id: 'e', status: 'exited', activity: 'idle' })
  ]
  const s = summarise(agents, { a: NOW - 1_000, b: long }, { a: long, b: long }, NOW)
  assert.deepEqual(s, { hired: 5, working: 2, waiting: 2, quiet: 1, stopped: 1 })
})

test('elapsed time reads as a duration, and says so when it knows nothing', () => {
  assert.equal(ago(0, NOW), '—')
  assert.equal(ago(NOW - 5_000, NOW), '5s')
  assert.equal(ago(NOW - 125_000, NOW), '2m 05s')
  assert.equal(ago(NOW - 7_560_000, NOW), '2h 06m')
})
