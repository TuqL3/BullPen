import assert from 'node:assert/strict'
import { test } from 'node:test'
import { routeCard, type CardMove } from '../src/main/cards.ts'
import { DEFAULT_WORKFLOW, PRESETS } from './floors.ts'
import { PRESETS as SHIPPED } from '../src/main/presets.ts'
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

/**
 * A floor that is not a software team.
 *
 * Nothing in `content-floor` is called a developer or a tester: the capabilities
 * are `drafts` and `proofs`, the columns are a content calendar's. The router
 * has to move its cards exactly the same way, because it reads what each
 * capability behaves like and never the word - and if it did read the word, a
 * marketing floor would be a floor whose board never moved.
 */
test('a floor with its own words for the work moves cards the same way', () => {
  const content = PRESETS.find((w) => w.name === 'content-floor') as Workflow
  assert.ok(content, 'the preset that proves it must exist')
  const who = (id: string): string =>
    ({ chief: 'chief', editor: 'editor', wanda: 'writer', pat: 'proofreader' })[id] ?? 'writer'
  const step = (from: string, to: string, subject = 's'): CardMove =>
    routeCard(content, { from, to, subject, body: 'b' }, who, HUMAN)

  // Commissioned: a card for whoever it lands on.
  assert.deepEqual(step('editor', 'wanda', 'launch post'), {
    kind: 'open',
    agent: 'wanda',
    text: 'launch post — b',
    by: 'editor'
  })
  // A finished draft goes to this floor's own column, under its own key - not
  // to a `wait_test` that only a software team would have called it.
  assert.deepEqual(step('wanda', 'editor'), { kind: 'move', agent: 'wanda', status: 'in_review' })
  assert.equal(content.columns.find((c) => c.kind === 'waiting')?.key, 'in_review')

  // Corrections go straight back to the writer, and it is the writer's card
  // that reopens - the rule says so with "(their card)".
  assert.deepEqual(step('pat', 'wanda'), { kind: 'move', agent: 'wanda', status: 'drafting' })
  // Fixed, look again.
  assert.deepEqual(step('wanda', 'pat'), { kind: 'move', agent: 'wanda', status: 'in_review' })
  // The proofreader closes it, and the work it was reading with it.
  assert.deepEqual(step('pat', 'editor', 'passed: launch post'), {
    kind: 'checked',
    agent: 'pat',
    subject: 'passed: launch post'
  })
  // And the chief telling the human is the end of it.
  assert.deepEqual(step('chief', HUMAN), { kind: 'move', agent: 'chief', status: 'published' })
})

/**
 * The rules are the operator's, so a floor can be given a different one and the
 * board has to obey it rather than the one Bullpen ships.
 */
test('a card rule the operator wrote is the rule that runs', () => {
  const w: Workflow = {
    ...SOLO,
    // Same floor, one line changed: a builder reporting in goes to blocked
    // instead of done, because on this floor nothing is finished until read.
    cardRules: SOLO.cardRules.map((r) =>
      r.from === 'builds' && r.to === 'assigns' ? { ...r, status: 'blocked' } : r
    )
  }
  assert.deepEqual(routeCard(w, { from: 'dave', to: 'michael', subject: 's', body: 'b' }, roleOf, HUMAN), {
    kind: 'move',
    agent: 'dave',
    status: 'blocked'
  })
  // Unchanged, the same message is done: nobody checks on the solo floor.
  assert.deepEqual(routeCard(SOLO, { from: 'dave', to: 'michael', subject: 's', body: 'b' }, roleOf, HUMAN), {
    kind: 'move',
    agent: 'dave',
    status: 'done'
  })
})

/**
 * The operator is a party to the floor without being an agent on it. What their
 * hand-over does to the board used to be written into the dispatch handler; it
 * is a rule now, and a floor that does not write it gets no card.
 */
test('a rule can be written about the person running the floor', () => {
  const w = {
    ...CHAIN,
    cardRules: [{ from: CHAIN.human, to: 'god', status: 'open' }]
  } as Workflow
  const roleOf = (id: string): string => (id === 'michael' ? 'god' : '')

  const handed = routeCard(w, { from: w.human, to: 'michael', subject: '', body: 'ship it' }, roleOf, w.human)
  assert.deepEqual(handed, { kind: 'open', agent: 'michael', text: 'ship it', by: w.human })

  // And an agent's message does not fire it: the rule names the human.
  const agentSent = routeCard(w, { from: 'iris', to: 'michael', subject: 'x', body: 'y' }, () => 'ba', w.human)
  assert.equal(agentSent, null)

  // Nor does a rule about agents fire on what the human sent.
  const other = { ...w, cardRules: [{ from: 'assigns', to: 'builds', status: 'open' }] } as Workflow
  assert.equal(
    routeCard(other, { from: w.human, to: 'dev1', subject: '', body: 'z' }, () => 'dev', w.human),
    null
  )
})


test('a floor nobody has written a rule on still moves cards', () => {
  // Every shipped floor has an empty `cardRules`, and for a while that meant
  // the board never moved: work was handed over, done and reported, and nothing
  // appeared on it. Somebody drawing a floor had to write a rule on every line
  // before the app did anything visible.
  //
  // What each word behaves like is enough to say what a message does, so a
  // floor that has written nothing is read that way instead.
  for (const w of SHIPPED) {
    assert.deepEqual(w.cardRules, [], `"${w.name}" is expected to ship with none`)
    const roleOf = (id: string): string => id
    const names = Object.keys(w.roles)
    const moves = names.flatMap((from) =>
      [...names, w.human]
        .filter((to) => to !== from)
        .map((to) => routeCard(w, { from, to, subject: 'x', body: '' }, roleOf, w.human))
        .filter(Boolean)
    )
    assert.ok(moves.length > 0, `"${w.name}" moves no cards at all`)
    assert.ok(
      moves.some((m) => m?.kind === 'open'),
      `"${w.name}" never opens one`
    )
    assert.ok(
      moves.some((m) => m?.kind === 'move' || m?.kind === 'checked'),
      `"${w.name}" opens cards and never moves them`
    )
  }
})

test('a rule somebody wrote beats what the floor would have done', () => {
  // The default is what a floor means when it says nothing. One written line
  // takes over: the floors these tests run against write all eight, and the
  // router has always read exactly those.
  const w = { ...SOLO, cardRules: [{ from: 'god', to: 'dev', status: 'blocked' }] } as Workflow
  const move = routeCard(w, { from: 'god', to: 'dev', subject: 'x', body: '' }, (id) => id, HUMAN)
  assert.deepEqual(move, { kind: 'move', agent: 'god', status: 'blocked' })
})
