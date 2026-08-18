import assert from 'node:assert/strict'
import { test } from 'node:test'
import { useStore } from '../src/renderer/src/store.ts'

const hire = (id: string, role: 'god' | 'ba' | 'dev' = 'dev'): void =>
  useStore.getState().upsertAgent({ id, name: id, role })

const reset = (): void => {
  useStore.setState({ agents: [], approvals: [], selected: null })
}

test('firing an agent takes it off the roster whether or not it is still running', () => {
  reset()
  hire('michael')
  hire('iris')
  useStore.getState().upsertAgent({ id: 'iris', status: 'exited' })

  useStore.getState().removeAgent('iris')
  assert.deepEqual(
    useStore.getState().agents.map((a) => a.id),
    ['michael'],
    'an exited agent must be removable - leaving it stranded is the bug this fixes'
  )
})

test('firing the selected agent hands the seat to someone still on the floor', () => {
  reset()
  hire('michael')
  hire('iris')
  useStore.getState().select('iris')

  useStore.getState().removeAgent('iris')
  assert.equal(useStore.getState().selected, 'michael', 'the command centre must not point at a fired agent')
})

test('firing the last agent leaves nobody selected rather than a ghost id', () => {
  reset()
  hire('michael')
  useStore.getState().select('michael')

  useStore.getState().removeAgent('michael')
  assert.equal(useStore.getState().selected, null)
})

test('a fired agent takes its pending approvals with it', () => {
  reset()
  hire('iris')
  useStore.getState().addApproval({
    id: 'a1',
    agentId: 'iris',
    toolName: 'Bash',
    detail: 'rm -rf',
    reason: 'destructive',
    createdAt: 0
  })

  useStore.getState().removeAgent('iris')
  assert.deepEqual(useStore.getState().approvals, [], 'an approval nobody can answer would sit in ask-me forever')
})

test('Michael and the analyst cannot be fired - the floor needs both', () => {
  reset()
  hire('michael', 'god')
  hire('iris', 'ba')
  hire('dave')

  useStore.getState().removeAgent('michael')
  useStore.getState().removeAgent('iris')
  assert.deepEqual(
    useStore.getState().agents.map((a) => a.id),
    ['michael', 'iris', 'dave'],
    'dispatch routes through Michael and every hire reports to Iris; neither has a re-hire path'
  )

  useStore.getState().removeAgent('dave')
  assert.deepEqual(
    useStore.getState().agents.map((a) => a.id),
    ['michael', 'iris'],
    'a worker must still be dismissable'
  )
})

test('the seat never lands on a fired agent even when core agents are present', () => {
  reset()
  hire('michael', 'god')
  hire('dave')
  useStore.getState().select('dave')

  useStore.getState().removeAgent('dave')
  assert.equal(useStore.getState().selected, 'michael')
})
