import assert from 'node:assert/strict'
import { test } from 'node:test'
import { trimTail } from '../src/main/pty.ts'

/**
 * Applying a floor reloads the window and leaves the agents that have a place
 * on the new one running, so the renderer comes back with an empty terminal
 * attached to a pty that has already printed everything it had to say. This is
 * what fills it back in - bounded, because an agent that has been up all day
 * has printed more than anybody wants held in memory.
 */
test('the backlog keeps the end of what was printed, cut at a line', () => {
  // Under the limit, nothing is thrown away.
  assert.equal(trimTail('one\n', 'two\n', 100), 'one\ntwo\n')
  assert.equal(trimTail('', '', 100), '')

  // Over it, the oldest goes. What is left starts at a line boundary rather
  // than mid-line: a cut that lands inside an escape sequence replays half of
  // one, and half a sequence is a pane painted in whatever colour the rest of
  // it would have ended.
  const kept = trimTail('aaaa\nbbbb\ncccc\n', 'dddd\n', 12)
  assert.equal(kept, 'cccc\ndddd\n')
  assert.ok(kept.length <= 12)

  // A cut with no newline after it has no boundary to find. Keeping exactly
  // the last `max` is still better than keeping nothing.
  assert.equal(trimTail('', 'abcdefghij', 4), 'ghij')

  // The limit is a ceiling that holds however many chunks it takes to reach it.
  let tail = ''
  for (let i = 0; i < 500; i++) tail = trimTail(tail, `line ${i}\n`, 200)
  assert.ok(tail.length <= 200, `grew to ${tail.length}`)
  assert.ok(tail.endsWith('line 499\n'), 'and the newest is the part that is kept')
  assert.ok(!tail.includes('line 0\n'), 'the oldest is gone')
})
