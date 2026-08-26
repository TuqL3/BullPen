import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Asks, asksPath, REPORTING, type Ask } from '../src/main/asks.ts'

const fresh = (cap?: number): { asks: Asks; root: string } => {
  const root = mkdtempSync(join(tmpdir(), 'bullpen-asks-'))
  return { asks: new Asks(asksPath(root), cap), root }
}

const ask = (id: string, subject = 's'): Ask => ({
  id,
  from: 'michael',
  subject,
  body: 'which one do you want?',
  ts: 1
})

/**
 * Answering used to delete the question. The queue was only ever the present
 * tense, so what had been decided an hour ago was unknowable to the person who
 * decided it, and two agents could be told opposite things a day apart with
 * nothing to check against.
 */
test('an answered question is kept, with what was said back', () => {
  const { asks, root } = fresh()
  asks.add(ask('q1', 'which database'))
  asks.add(ask('q2', 'ship on friday?'))
  assert.equal(asks.pending().length, 2)

  const answered = asks.answer('q1', 'postgres')
  assert.equal(answered?.answer, 'postgres')
  assert.ok((answered?.answeredAt ?? 0) > 0)

  assert.deepEqual(
    asks.pending().map((a) => a.id),
    ['q2'],
    'answering takes it out of the queue'
  )
  assert.equal(asks.all().length, 2, 'and leaves it in the history')

  // Newest first, which is the order it is read in.
  assert.deepEqual(
    asks.all().map((a) => a.id),
    ['q2', 'q1']
  )

  // Survives a restart: that is the whole point of the file.
  const reopened = new Asks(asksPath(root))
  assert.equal(reopened.all().length, 2)
  assert.equal(reopened.all().find((a) => a.id === 'q1')?.answer, 'postgres')
  assert.deepEqual(
    reopened.pending().map((a) => a.id),
    ['q2']
  )
  rmSync(root, { recursive: true, force: true })
})

test('a question is answered once, and waving one away is not answering it', () => {
  const { asks, root } = fresh()
  asks.add(ask('q1'))

  assert.ok(asks.answer('q1', 'yes'))
  assert.equal(asks.answer('q1', 'no'), null, 'and not twice')
  assert.equal(asks.dismiss('q1'), null, 'nor dismissed after the fact')
  assert.equal(asks.answer('nobody', 'x'), null)

  asks.add(ask('q2'))
  const waved = asks.dismiss('q2')
  assert.ok((waved?.dismissedAt ?? 0) > 0)
  assert.equal(waved?.answer, undefined, 'no answer was given')
  assert.deepEqual(asks.pending(), [], 'and it is off the queue either way')
  assert.equal(asks.all().length, 2, 'having been asked is still worth keeping')
  rmSync(root, { recursive: true, force: true })
})

/**
 * A floor left running overnight asks a great many things. The cap is about the
 * size of the file - it must never be the reason an agent sitting blocked on a
 * question drops off the queue.
 */
test('the history is bounded, and never at a waiting question’s expense', () => {
  const { asks, root } = fresh(3)
  for (let i = 0; i < 10; i++) {
    asks.add(ask(`a${i}`))
    asks.answer(`a${i}`, 'sure')
  }
  assert.equal(asks.all().length, 3, 'the oldest dealt-with go first')
  assert.deepEqual(
    asks.all().map((a) => a.id),
    ['a9', 'a8', 'a7']
  )

  // Now fill it past the cap with questions nobody has answered.
  for (let i = 0; i < 10; i++) asks.add(ask(`w${i}`))
  assert.equal(asks.pending().length, 10, 'not one of them is dropped')
  assert.ok(asks.all().length >= 10)
  rmSync(root, { recursive: true, force: true })
})

test('a missing or unreadable file is an empty queue, not a dead app', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullpen-asks-'))
  const asks = new Asks(join(root, 'nothing-here', 'asks.json'))
  assert.deepEqual(asks.all(), [])
  // And writing into it creates the directory it needs.
  asks.add(ask('q1'))
  assert.equal(new Asks(join(root, 'nothing-here', 'asks.json')).all().length, 1)
  rmSync(root, { recursive: true, force: true })
})

/** The pattern main routes on - imported, so a word added to it is tested here. */
test('a work report goes to the monitor and a question stays in the queue', () => {
  for (const subject of [
    'report',
    're: the export',
    'done: the sitemap route',
    'fail: could not build it',
    'finished the migration',
    'shipped',
    'status update'
  ]) {
    assert.ok(REPORTING.test(subject), `"${subject}" is a report`)
  }

  for (const subject of [
    'which database should we use?',
    'blocked: need a decision on pricing',
    'stuck: no credentials for staging',
    'redis or postgres',
    'should I delete the old table?'
  ]) {
    assert.ok(!REPORTING.test(subject), `"${subject}" is a question`)
  }

  // `blocked` and `stuck` are deliberately questions: a worker saying it is
  // stuck is asking for a decision, which is the one thing this queue is for.
  // `redis or postgres` is the trap - it starts with "re".
  assert.ok(!REPORTING.test('redis or postgres'), 'a word beginning with "re" is not "re:"')
})

test('a new run starts with an empty queue, on disk as well as in memory', () => {
  // The board and the ask-me queue belong to one run: every agent dies with the
  // app, so on the next one the whole list is questions nobody is waiting on an
  // answer to. Main calls this once, at module scope, before anything reads it.
  const { asks, root } = fresh()
  asks.add(ask('q1', 'go?'))
  asks.add(ask('q2', 'this one is answered'))
  asks.answer('q2', 'yes')

  assert.equal(asks.clear(), 2)
  assert.deepEqual(asks.all(), [])
  assert.deepEqual(asks.pending(), [])
  // Written through, not just emptied in memory - the next run reads the file.
  assert.deepEqual(new Asks(asksPath(root)).all(), [])
  // An already-empty queue clears to nothing.
  assert.equal(asks.clear(), 0)
  rmSync(root, { recursive: true, force: true })
})
