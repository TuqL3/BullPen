import assert from 'node:assert/strict'
import { test } from 'node:test'
import { useStore } from '../src/renderer/src/store.ts'
import { setShape } from '../src/renderer/src/shape.ts'
import type { WorkflowInfo } from '../src/preload/index.ts'

/**
 * Who cannot be fired is the workflow's answer, not a name in the source, so
 * the store has to be told the shape before it can refuse anything.
 */
const FLOOR = {
  name: 'test-floor',
  description: '',
  dispatch: 'god',
  entry: 'ba',
  hireAbovePct: 70,
  roles: {
    god: { can: ['speaksToHuman'], label: 'the boss', fixed: { id: 'michael', name: 'Michael' }, brief: '' },
    ba: { can: ['assigns'], label: 'the analyst', fixed: { id: 'ba', name: 'Iris' }, brief: '' },
    dev: { can: ['builds'], label: 'a developer', hireable: true, brief: '' }
  },
  talksTo: { god: ['ba', 'you'], ba: ['god', 'dev', 'hire'], dev: ['ba'] }
} as unknown as WorkflowInfo

setShape(FLOOR)

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

test('the floor\'s own agents cannot be fired - a workflow says which those are', () => {
  reset()
  hire('michael', 'god')
  hire('iris', 'ba')
  hire('dave')

  useStore.getState().removeAgent('michael')
  useStore.getState().removeAgent('iris')
  assert.deepEqual(
    useStore.getState().agents.map((a) => a.id),
    ['michael', 'iris', 'dave'],
    'dispatch routes through one and every hire reports to the other; neither has a re-hire path'
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

test('a late event about a fired agent does not put it back on the roster', () => {
  // `kill` returns when the signal is sent; the exit event, and any status,
  // context or cost reading still in flight, arrive after that - by which time
  // the row is gone. Fed through `upsertAgent` every one of them treated the
  // partial as a new agent and the fired row came straight back, nameless and
  // with no workspace.
  reset()
  hire('michael')
  hire('quinn')
  useStore.getState().removeAgent('quinn')
  assert.deepEqual(useStore.getState().agents.map((a) => a.id), ['michael'])

  const late = useStore.getState().patchAgent
  late({ id: 'quinn', status: 'exited', exitCode: 0, activity: 'idle' })
  late({ id: 'quinn', activity: 'working' })
  late({ id: 'quinn', ctx: { used: 1, limit: 2, pct: 50, model: 'claude-opus-5' } })
  assert.deepEqual(
    useStore.getState().agents.map((a) => a.id),
    ['michael'],
    'a fired agent stays fired'
  )

  // And it is still an update for anyone who is on the roster.
  late({ id: 'michael', activity: 'working' })
  assert.equal(useStore.getState().agents[0].activity, 'working')
})

test('the mail list is a window, and what has been seen is not its length', () => {
  // The office floor walks an agent across the room for each new message, and
  // tracked "how many have I seen" as an index into this list. The list keeps
  // only the last 200, so once it filled its length stopped growing, the index
  // sat on the end, and every message after the two-hundredth was skipped: the
  // floor stopped moving for the rest of the session. `seq` only goes up.
  useStore.setState({ mail: [] })
  const add = useStore.getState().addMail
  for (let n = 1; n <= 260; n++) add({ from: 'a', to: 'b', subject: `msg ${n}`, ts: n })

  const mail = useStore.getState().mail
  assert.equal(mail.length, 200, 'still a window')
  assert.equal(mail.at(-1)?.seq, 260, 'and the newest knows it is the 260th')
  assert.equal(mail[0].seq, 61, 'the oldest 60 fell off the front')

  // What the floor does: take everything past the last one it walked.
  let seen = 0
  let walked = 0
  for (const m of mail) {
    if (m.seq <= seen) continue
    walked++
  }
  seen = mail.at(-1)?.seq ?? 0
  assert.equal(walked, 200, 'every message still in the window is new to a fresh floor')

  add({ from: 'a', to: 'b', subject: 'one more', ts: 261 })
  const after = useStore.getState().mail.filter((m) => m.seq > seen)
  assert.deepEqual(after.map((m) => m.subject), ['one more'], 'and the next one is not skipped')
})
