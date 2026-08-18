import assert from 'node:assert/strict'
import { test } from 'node:test'
import { routeCard, type CardMove } from '../src/main/cards.ts'
import { DEFAULT_WORKFLOW, PRESETS } from '../src/main/presets.ts'
import type { Workflow } from '../src/main/workflow.ts'

const HUMAN = 'you'
const CHAIN = DEFAULT_WORKFLOW
const SOLO = PRESETS.find((w) => w.name === 'solo') as Workflow

/** Who is who on the analyst chain, for a router that only knows ids. */
const roleOf = (id: string): string =>
  ({ michael: 'god', ba: 'ba', dave: 'dev', quinn: 'tester' })[id] ?? 'dev'

const move = (w: Workflow, from: string, to: string, subject = 's', body = 'b'): CardMove =>
  routeCard(w, { from, to, subject, body }, roleOf, HUMAN)

/**
 * The board is what the operator watches, so every step of a task's life has to
 * land on it: given out, worked, checked, closed. A gap does not read as a gap -
 * it reads as a floor that is not doing anything.
 */
test('a task is on the board from the moment it is handed over to the moment it closes', () => {
  // The operator's request reaches the boss, who hands it to the analyst.
  assert.deepEqual(move(CHAIN, 'michael', 'ba', 'ship the parser'), {
    kind: 'open',
    agent: 'ba',
    text: 'ship the parser — b',
    by: 'michael'
  })

  // She puts a developer on it. That is a card for the developer.
  assert.deepEqual(move(CHAIN, 'ba', 'dave', 'parser'), {
    kind: 'open',
    agent: 'dave',
    text: 'parser — b',
    by: 'ba'
  })

  // Built is not finished: it waits for someone who did not write it.
  assert.deepEqual(move(CHAIN, 'dave', 'ba', 'done: parser'), {
    kind: 'move',
    agent: 'dave',
    status: 'wait_test'
  })

  // A bug goes straight back to the author, and that is work again.
  assert.deepEqual(move(CHAIN, 'quinn', 'dave', 'bug: crash'), {
    kind: 'move',
    agent: 'dave',
    status: 'doing'
  })

  // "Fixed, look again" puts it back in front of the checker, not the analyst.
  assert.deepEqual(move(CHAIN, 'dave', 'quinn', 'fixed'), {
    kind: 'move',
    agent: 'dave',
    status: 'wait_test'
  })

  // The checker's word is what closes it.
  assert.deepEqual(move(CHAIN, 'quinn', 'ba', 'pass: parser'), {
    kind: 'checked',
    agent: 'quinn',
    subject: 'pass: parser'
  })

  // She passes it up, which finishes her own card.
  assert.deepEqual(move(CHAIN, 'ba', 'michael', 'report: parser'), {
    kind: 'move',
    agent: 'ba',
    status: 'done'
  })

  // And he tells the operator, which finishes his.
  assert.deepEqual(move(CHAIN, 'michael', HUMAN, 'report'), {
    kind: 'move',
    agent: 'michael',
    status: 'done'
  })
})

/**
 * The analyst's board used to be empty by construction while she was the
 * busiest agent on the floor: whoever assigns was excluded from being assigned.
 */
test('whoever assigns work is themselves given work', () => {
  const m = move(CHAIN, 'michael', 'ba')
  assert.equal(m?.kind, 'open', 'the analyst gets a card of her own')
  if (m?.kind === 'open') assert.equal(m.agent, 'ba')
})

test('a report to the human is not a new task for the human', () => {
  // Only the floor's voice closes on reaching the operator; anyone else writing
  // there is refused by the router long before this, and must not move a card.
  assert.deepEqual(move(CHAIN, 'michael', HUMAN), { kind: 'move', agent: 'michael', status: 'done' })
  assert.equal(move(CHAIN, 'dave', HUMAN), null)
})

/**
 * With nobody to check the work, "built" is as far as a task goes. Parking it
 * in wait_test on such a floor leaves it there for the life of the run.
 */
test('a floor with no checker closes a task when it is built', () => {
  const soloRole = (id: string): string => (id === 'michael' ? 'god' : 'dev')
  const m = routeCard(SOLO, { from: 'dave', to: 'michael', subject: 'done', body: '' }, soloRole, HUMAN)
  assert.deepEqual(m, { kind: 'move', agent: 'dave', status: 'done' })

  // And the same message on a floor that does check waits instead.
  assert.deepEqual(move(CHAIN, 'dave', 'ba', 'done'), {
    kind: 'move',
    agent: 'dave',
    status: 'wait_test'
  })
})

test('a message that is not an assignment moves nothing', () => {
  // Two developers talking, on a floor where that is even allowed.
  assert.equal(routeCard(CHAIN, { from: 'dave', to: 'dave2', subject: 'x', body: '' }, roleOf, HUMAN), null)
  // The boss writing to himself is not handing anything over.
  assert.equal(move(CHAIN, 'michael', 'michael'), null)
})

/**
 * The router reads capabilities, so a floor that reviews instead of testing
 * needs no case of its own. If this ever fails, the names have crept back in.
 */
test('a reviewer moves cards exactly like a tester', () => {
  const review = PRESETS.find((w) => w.name === 'review') as Workflow
  const who = (id: string): string =>
    ({ michael: 'god', ba: 'ba', dave: 'dev', robin: 'reviewer' })[id] ?? 'dev'
  assert.deepEqual(
    routeCard(review, { from: 'robin', to: 'dave', subject: 'change: x', body: '' }, who, HUMAN),
    { kind: 'move', agent: 'dave', status: 'doing' }
  )
  assert.deepEqual(
    routeCard(review, { from: 'robin', to: 'ba', subject: 'pass: x', body: '' }, who, HUMAN),
    { kind: 'checked', agent: 'robin', subject: 'pass: x' }
  )
})
