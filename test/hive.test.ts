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
