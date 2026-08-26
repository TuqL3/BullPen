import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  anyoneChecks,
  assignerAgent,
  assignerRole,
  buildRole,
  dispatchAgent,
  dispatchRole,
  entryRole,
  isCore,
  roleName,
  roleTag,
  rolesWith,
  setShape
} from '../src/renderer/src/shape.ts'
import type { WorkflowInfo } from '../src/preload/index.ts'

/** A chain floor: a boss who only speaks up, an analyst, builders and checkers. */
const CHAIN = {
  name: 'analyst-chain',
  description: 'boss to analyst to developer to tester',
  dispatch: 'god',
  entry: 'ba',
  hireAbovePct: 70,
  roles: {
    god: { can: ['speaksToHuman'], label: 'the boss', fixed: { id: 'michael', name: 'Michael' }, brief: '' },
    ba: { can: ['assigns'], label: 'the analyst', fixed: { id: 'ba', name: 'Iris' }, brief: '' },
    dev: { can: ['builds'], label: 'a developer', hireable: true, brief: '' },
    tester: { can: ['checks'], label: 'a tester', hireable: true, brief: '' }
  },
  talksTo: { god: ['ba', 'you'], ba: ['god', 'dev', 'tester', 'hire'], dev: ['ba', 'tester'], tester: ['ba', 'dev'] },
  human: 'you',
  hire: 'hire',
  capabilities: [
    { name: 'speaksToHuman', what: '' },
    { name: 'assigns', what: '' },
    { name: 'builds', what: '' },
    { name: 'checks', what: '' }
  ],
  columns: [
    { key: 'todo', label: 'todo', bar: '#7fc7e8', kind: 'start' },
    { key: 'wait_test', label: 'wait to test', bar: '#c9a2e8', kind: 'waiting' },
    { key: 'done', label: 'done', bar: '#7fd8a0', kind: 'done' }
  ],
  cardRules: [
    { from: 'assigns', to: 'staff', status: 'open' },
    { from: 'builds', to: 'assigns', status: 'wait_test' },
    { from: 'checks', to: 'assigns', status: 'closes' },
    { from: 'speaksToHuman', to: 'you', status: 'done' }
  ]
} as unknown as WorkflowInfo

/** One boss who does everything but the building, and nobody who checks. */
const SOLO = {
  name: 'solo',
  description: 'one boss, hired hands',
  dispatch: 'god',
  entry: 'god',
  hireAbovePct: 70,
  roles: {
    god: {
      can: ['speaksToHuman', 'assigns'],
      label: 'the boss',
      fixed: { id: 'michael', name: 'Michael' },
      brief: ''
    },
    hand: { can: ['builds'], label: 'a builder', hireable: true, brief: '' }
  },
  talksTo: { god: ['hand', 'you', 'hire'], hand: ['god'] },
  human: 'you',
  hire: 'hire',
  capabilities: [
    { name: 'speaksToHuman', what: '' },
    { name: 'assigns', what: '' },
    { name: 'builds', what: '' }
  ],
  columns: [
    { key: 'todo', label: 'todo', bar: '#7fc7e8', kind: 'start' },
    { key: 'done', label: 'done', bar: '#7fd8a0', kind: 'done' }
  ],
  cardRules: [
    { from: 'assigns', to: 'staff', status: 'open' },
    { from: 'builds', to: 'assigns', status: 'done' },
    { from: 'speaksToHuman', to: 'you', status: 'done' }
  ]
} as unknown as WorkflowInfo

test('the UI reads who is who off the workflow, not off a name', () => {
  setShape(CHAIN)
  assert.equal(dispatchRole(), 'god')
  assert.equal(entryRole(), 'ba')
  // Work is handed on to whoever assigns and is not the one it arrived at.
  assert.equal(assignerRole(), 'ba')
  assert.equal(buildRole(), 'dev')
  assert.equal(anyoneChecks(), true)
  assert.deepEqual(rolesWith('checks'), ['tester'])
  // A fixed agent is the floor; a hired one is staff and can be fired.
  assert.equal(isCore('god'), true)
  assert.equal(isCore('dev'), false)
  assert.equal(roleName('god'), 'Michael')
  // A hired role has no one name, so it answers with what it is called.
  assert.equal(roleName('dev'), 'a developer')
})

test('a floor with nobody checking says so, and hands out its own work', () => {
  setShape(SOLO)
  // The boss assigns directly: there is no second party to name, and every
  // caller falls back to dispatch rather than inventing an analyst.
  assert.equal(assignerRole(), 'god')
  assert.equal(anyoneChecks(), false)
  assert.equal(buildRole(), 'hand')
  assert.equal(entryRole(), 'god')
})

test('every role on the floor has a tag, and nothing else does', () => {
  setShape(CHAIN)
  // The article comes off: it reads mid-sentence in a refusal, not on a row.
  assert.equal(roleTag('god'), 'boss')
  assert.equal(roleTag('tester'), 'tester')
  // Whoever builds used to be left blank, on the grounds that most of a floor
  // builds. On a chain four deep that left the developer's row saying only
  // which directory it was in - which is the one thing every row on that
  // project already says.
  assert.equal(roleTag('dev'), 'developer')
  assert.equal(roleTag('nobody'), null, 'a role this floor does not have has no tag')
})

test('the floor is found by role, and an absent one is undefined not a guess', () => {
  const agents = [
    { id: 'michael', role: 'god' },
    { id: 'ba', role: 'ba' },
    { id: 'sam', role: 'dev' }
  ]
  setShape(CHAIN)
  assert.equal(dispatchAgent(agents)?.id, 'michael')
  assert.equal(assignerAgent(agents)?.id, 'ba')

  setShape(SOLO)
  // Dispatch assigns here, so there is no separate agent to point at - and
  // pointing at dispatch again would have the monitor say "hands it to
  // themselves".
  assert.equal(assignerAgent(agents), undefined)

  // Before the workflow arrives nothing is known, and nothing is invented.
  setShape(null)
  assert.equal(dispatchRole(), '')
  assert.equal(dispatchAgent(agents), undefined)
  assert.equal(isCore('god'), false)
})
