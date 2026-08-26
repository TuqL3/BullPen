import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hive } from '../src/main/hive.ts'

function fresh(): { hive: Hive; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'bullpen-test-'))
  return { hive: new Hive(root), root }
}

test('direct message reaches exactly one inbox', () => {
  const { hive, root } = fresh()
  hive.register('michael')
  hive.register('dwight')
  hive.register('jim')

  hive.send({ from: 'michael', to: 'dwight', subject: 'sales', body: 'call the client' })
  const made = hive.route()

  assert.equal(made.length, 1)
  assert.equal(hive.peekInbox('jim').length, 0, 'must not leak to third party')
  const got = hive.drainInbox('dwight')
  assert.equal(got.length, 1)
  assert.equal(got[0].body, 'call the client')
  assert.equal(hive.drainInbox('dwight').length, 0, 'drain must consume')
  rmSync(root, { recursive: true, force: true })
})

test('broadcast hits everyone but the sender', () => {
  const { hive, root } = fresh()
  for (const id of ['michael', 'dwight', 'jim']) hive.register(id)

  hive.send({ from: 'michael', to: '*', subject: 'meeting', body: 'conference room' })
  hive.route()

  assert.equal(hive.drainInbox('michael').length, 0, 'sender must not receive own broadcast')
  assert.equal(hive.drainInbox('dwight').length, 1)
  assert.equal(hive.drainInbox('jim').length, 1)
  rmSync(root, { recursive: true, force: true })
})

test('unknown recipient goes to dead, does not throw', () => {
  const { hive, root } = fresh()
  hive.register('michael')

  const dead: unknown[] = []
  hive.on('dead', (m) => dead.push(m))
  hive.send({ from: 'michael', to: 'nobody', subject: 'x', body: 'y' })
  const made = hive.route()

  assert.equal(made.length, 0)
  assert.equal(dead.length, 1)
  rmSync(root, { recursive: true, force: true })
})

test('malformed file is dropped, router keeps going', () => {
  const { hive, root } = fresh()
  hive.register('michael')
  hive.register('dwight')

  writeFileSync(join(hive.agentDir('michael'), 'outbox', '0-bad.json'), '{ not json')
  hive.send({ from: 'michael', to: 'dwight', subject: 'ok', body: 'still delivered' })

  const made = hive.route()
  assert.equal(made.length, 1, 'good message must survive a bad sibling')
  assert.equal(hive.drainInbox('dwight')[0].body, 'still delivered')
  rmSync(root, { recursive: true, force: true })
})

test('route is idempotent - a delivered message is not re-delivered', () => {
  const { hive, root } = fresh()
  hive.register('michael')
  hive.register('dwight')

  hive.send({ from: 'michael', to: 'dwight', subject: 'once', body: 'only once' })
  hive.route()
  hive.route()
  hive.route()

  assert.equal(hive.peekInbox('dwight').length, 1, 'must not duplicate on re-route')
  rmSync(root, { recursive: true, force: true })
})

test('mail to the human is a question, not dead mail', () => {
  // The ask-me queue is built on this: an agent addresses `you`, and the
  // message must not be dead-lettered just because no such agent exists.
  const { hive, root } = fresh()
  hive.register('michael')

  const questions: unknown[] = []
  const dead: unknown[] = []
  hive.on('question', (m) => questions.push(m))
  hive.on('dead', (m) => dead.push(m))

  hive.send({ from: 'michael', to: 'you', subject: 'which variant?', body: 'a, b or c' })
  const made = hive.route()

  assert.equal(made.length, 0, 'nothing is delivered to an agent')
  assert.equal(dead.length, 0, 'and it is not dead mail')
  assert.equal(questions.length, 1)
  rmSync(root, { recursive: true, force: true })
})

test('an answer routes back to the asker like any other message', () => {
  const { hive, root } = fresh()
  hive.register('michael')
  hive.send({ from: 'you', to: 'michael', subject: 'answer', body: 'pick b' })
  hive.route()
  assert.equal(hive.drainInbox('michael')[0].body, 'pick b')
  rmSync(root, { recursive: true, force: true })
})

test('a half-written message waits instead of vanishing', () => {
  // The router used to delete the file and check afterwards whether it parsed,
  // so a message caught mid-write was gone with no delivery, no ack and no dead
  // letter. A whole round of hires disappeared that way, and nothing on either
  // side could tell "refused" from "lost".
  const { hive, root } = fresh()
  hive.register('michael')
  const path = join(root, 'agents', 'michael', 'outbox', 'half.json')
  writeFileSync(path, '{"from":"michael","to":"hire","subject":"seo","bo')

  const dead: unknown[] = []
  hive.on('dead', (m) => dead.push(m))

  hive.route()
  assert.ok(existsSync(path), 'a file still being written must be left alone')
  assert.equal(dead.length, 0, 'and it is not dead mail yet')

  // Finished a moment later: the same file, now valid, routes normally.
  writeFileSync(path, JSON.stringify({ from: 'michael', to: 'hire', subject: 'seo', body: 'go' }))
  const hires: { subject: string }[] = []
  hive.on('hire', (m) => hires.push(m as { subject: string }))
  hive.route()
  assert.equal(hires.length, 1, 'the completed message is the one that was waiting')
  assert.equal(existsSync(path), false, 'and it is consumed once it has been read')
  rmSync(root, { recursive: true, force: true })
})

test('a message that never becomes valid ends up in dead, not nowhere', () => {
  const { hive, root } = fresh()
  hive.register('michael')
  const path = join(root, 'agents', 'michael', 'outbox', 'broken.json')
  writeFileSync(path, 'not json at all')
  // Older than the grace period: broken rather than busy.
  const old = new Date(Date.now() - 60_000)
  utimesSync(path, old, old)

  const dead: { subject: string }[] = []
  hive.on('dead', (m) => dead.push(m as { subject: string }))
  hive.route()

  assert.equal(existsSync(path), false)
  assert.equal(dead.length, 1)
  assert.match(dead[0].subject, /unreadable/)
  assert.equal(readdirSync(join(root, 'dead')).length, 1, 'kept as written, for reading later')
  rmSync(root, { recursive: true, force: true })
})

test('the gate refuses a message that skips the chain, and says so', () => {
  const { hive, root } = fresh()
  try {
    hive.register('michael')
    hive.register('morgan')
    // A developer writing straight to the boss: the message every floor with a
    // test loop eventually sends, and the one that means nobody checked it.
    hive.gate = (from, to) => (from === 'morgan' && to === 'michael' ? 'write to the analyst' : null)
    const blocked: [string, string][] = []
    hive.on('blocked', (msg, why) => blocked.push([msg.subject, why]))

    hive.send({ from: 'morgan', to: 'michael', subject: 'done', body: 'built it' })
    assert.deepEqual(hive.route(), [], 'nothing was delivered')
    assert.deepEqual(hive.peekInbox('michael'), [])
    assert.deepEqual(blocked, [['done', 'write to the analyst']])
    // Kept, not dropped: the sender may need it back, and a message that
    // vanishes is indistinguishable from one nobody acted on.
    assert.equal(readdirSync(join(root, 'dead')).length, 1)

    // The allowed direction still goes through.
    hive.register('ba')
    hive.send({ from: 'morgan', to: 'ba', subject: 'done', body: 'built it' })
    assert.equal(hive.route().length, 1)
    assert.equal(hive.peekInbox('ba').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a broadcast reaches the part of the floor it is allowed to reach', () => {
  const { hive, root } = fresh()
  try {
    for (const id of ['ba', 'morgan', 'michael']) hive.register(id)
    hive.gate = (_from, to) => (to === 'michael' ? 'the boss hears from the analyst only' : null)
    hive.send({ from: 'ba', to: '*', subject: 'standup', body: 'where are we' })
    const made = hive.route()
    assert.deepEqual(
      made.map((d) => d.to).sort(),
      ['morgan'],
      'refused one target, delivered the other - not all or nothing'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a request the gate refuses never reaches hiring or the human', () => {
  const { hive, root } = fresh()
  try {
    hive.register('morgan')
    hive.gate = () => 'developers do not hire and do not write to the human'
    const seen: string[] = []
    hive.on('hire', () => seen.push('hire'))
    hive.on('question', () => seen.push('question'))
    hive.on('blocked', () => seen.push('blocked'))

    hive.send({ from: 'morgan', to: 'hire', subject: 'seo', body: 'need help' })
    hive.send({ from: 'morgan', to: 'you', subject: 'which colour?', body: '?' })
    hive.route()
    assert.deepEqual(seen, ['blocked', 'blocked'], 'both reserved recipients are gated too')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * Delivered mail is not consumed - every brief tells its agent that its mail is
 * in `$BULLPEN_MAILBOX/inbox`, so it stays there to be read. A name is free the
 * moment its agent stops, though, and the next hire on the next project gets
 * that name: it came up in front of nine messages about work it had never done,
 * and its own brief told it to go and read them.
 */
test('an id handed to somebody new starts with an empty mailbox', () => {
  const { hive, root } = fresh()
  hive.register('morgan')
  hive.register('avery')
  hive.send({ from: 'avery', to: 'morgan', subject: 'the old project', body: 'x' })
  hive.send({ from: 'avery', to: 'morgan', subject: 'the old project again', body: 'y' })
  hive.route()
  // One still on its way out, so both directions are covered.
  hive.send({ from: 'morgan', to: 'avery', subject: 'half-written', body: 'z' })

  assert.equal(hive.peekInbox('morgan').length, 2)
  assert.equal(hive.forget('morgan'), 3, 'two delivered and one unsent')
  assert.deepEqual(hive.peekInbox('morgan'), [])

  // The directory stays: `list` is what the router walks, and an id it cannot
  // see is an id nothing can be addressed to.
  assert.ok(hive.list().includes('morgan'), 'still an address')
  hive.send({ from: 'avery', to: 'morgan', subject: 'the new project', body: 'a' })
  hive.route()
  assert.deepEqual(
    hive.peekInbox('morgan').map((m) => m.subject),
    ['the new project']
  )

  // Nobody else is touched, and an empty mailbox clears to an empty mailbox.
  assert.equal(hive.peekInbox('avery').length, 0, 'its own outbox went, so nothing arrived')
  assert.equal(hive.forget('nobody-here'), 0)
  rmSync(root, { recursive: true, force: true })
})

/**
 * `staff` is allowed to hire, so the name it returns is the one name the sweep
 * cannot already know about.
 *
 * `route()` opens with one `list()` and matched the staffed name against it,
 * which is a snapshot taken before the hire existed. So the message that
 * caused a hire was the message the hire never got: somebody was put on the
 * floor, given a card, and told nothing - indistinguishable, from outside,
 * from an agent that is simply slow to start.
 */
test('the message that causes a hire reaches the agent it hired', () => {
  const { hive, root } = fresh()
  hive.register('michael')

  hive.staff = (to, _from, _msg) => {
    if (to !== 'dev') return null
    // Exactly what main does: bring somebody up, then name them.
    hive.register('morgan')
    return 'morgan'
  }

  hive.send({ from: 'michael', to: 'dev', subject: 'the task', body: 'ship it' })
  const made = hive.route()

  assert.equal(made.length, 1, 'one delivery, not a dead letter')
  const got = hive.drainInbox('morgan')
  assert.equal(got.length, 1, 'the new hire is told what the work is')
  assert.equal(got[0].body, 'ship it')
  assert.equal(got[0].to, 'morgan', 'addressed to the person, not the role')
  assert.equal(readdirSync(join(root, 'dead')).length, 0, 'and nothing is dead')
  rmSync(root, { recursive: true, force: true })
})

/**
 * A mailbox outlives its agent, and `list()` is what the router reads as "who
 * is an id". So a floor that later names a role after somebody who has left -
 * `ba` here, an agent id on the floor before it - had every message to that
 * role delivered into a folder nobody reads: `staff` was never asked, no card
 * was opened, and the sender was told off for writing to its own role.
 */
test('a dead agent\'s leftover mailbox does not shadow a role of the same name', () => {
  const { hive, root } = fresh()
  hive.register('avery')
  // The one who left. Emptied, as `forget` leaves it: the directory stays.
  hive.register('ba')
  hive.live = (id) => id === 'avery' || id === 'morgan'
  let staffed = 0
  hive.staff = (to) => {
    if (to !== 'ba') return null
    staffed++
    hive.register('morgan')
    return 'morgan'
  }

  hive.send({ from: 'avery', to: 'ba', subject: 'done: the bundle', body: 'passed' })
  hive.route()

  assert.equal(staffed, 1, 'the role is staffed rather than read as an id')
  assert.equal(hive.peekInbox('ba').length, 0, 'nothing goes to the empty folder')
  const got = hive.drainInbox('morgan')
  assert.equal(got.length, 1, 'the analyst who is actually here gets it')
  assert.equal(got[0].to, 'morgan')
  rmSync(root, { recursive: true, force: true })
})
