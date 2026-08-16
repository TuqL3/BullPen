import assert from 'node:assert/strict'
import { test } from 'node:test'
import { useStore } from '../src/renderer/src/store.ts'

const reset = () => useStore.setState({ agents: [], approvals: [], mail: [], queue: {}, steers: {}, selected: null })

test('queue is FIFO and shift consumes exactly one', () => {
  reset()
  const s = useStore.getState()
  s.enqueue('michael', 'first')
  s.enqueue('michael', 'second')

  assert.equal(useStore.getState().shift('michael'), 'first')
  assert.deepEqual(useStore.getState().queue.michael, ['second'])
  assert.equal(useStore.getState().shift('michael'), 'second')
  assert.equal(useStore.getState().shift('michael'), null, 'draining an empty queue is not an error')
})

test('a second idle event cannot resend the same message', () => {
  // The bug this guards: if shift() read without removing, two Stop hooks in
  // quick succession would both send message #1.
  reset()
  useStore.getState().enqueue('michael', 'only once')
  const a = useStore.getState().shift('michael')
  const b = useStore.getState().shift('michael')
  assert.equal(a, 'only once')
  assert.equal(b, null)
})

test('queues are per agent and do not bleed', () => {
  reset()
  const s = useStore.getState()
  s.enqueue('michael', 'for michael')
  s.enqueue('dwight', 'for dwight')
  assert.equal(useStore.getState().shift('dwight'), 'for dwight')
  assert.deepEqual(useStore.getState().queue.michael, ['for michael'])
})

test('removing by index and clearing leave the other agents alone', () => {
  reset()
  const s = useStore.getState()
  for (const t of ['a', 'b', 'c']) s.enqueue('michael', t)
  s.enqueue('dwight', 'keep me')

  useStore.getState().removeQueued('michael', 1)
  assert.deepEqual(useStore.getState().queue.michael, ['a', 'c'])

  useStore.getState().clearQueue('michael')
  assert.deepEqual(useStore.getState().queue.michael, [])
  assert.deepEqual(useStore.getState().queue.dwight, ['keep me'])
})
