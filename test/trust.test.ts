import assert from 'node:assert/strict'
import { test } from 'node:test'
import { feed, isTrustPrompt, newWatch, stripAnsi, TRUST_WINDOW_MS } from '../src/main/trust.ts'

const SANDBOX = '/tmp/bp-Andy-hWw4bV'

const PROMPT = (dir: string) => `Accessing workspace:

${dir}

Quick safety check: Is this a project you created or one you trust? (Like your own
code, a well-known open source project, or work from your team). If not, take a
moment to review what's in this folder first.

Claude Code'll be able to read, edit, and execute files here.

Security guide

[34m❯ 1. Yes, I trust this folder[0m
  2. No, exit

Enter to confirm · Esc to cancel
`

test('strips the escape codes the pty wraps everything in', () => {
  assert.equal(stripAnsi('[34mhello[0m'), 'hello')
  assert.equal(stripAnsi('[1;32mok[m done'), 'ok done')
})

test('recognises the real prompt for its own sandbox', () => {
  assert.equal(isTrustPrompt(PROMPT(SANDBOX), SANDBOX), true)
})

test('survives the pty hard-wrapping the prompt mid-token', () => {
  // A narrow terminal splits both the path and the sentence.
  const wrapped = PROMPT(SANDBOX).replace('/tmp/bp-Andy', '/tmp/bp-\nAndy').replace('I trust this', 'I trust\nthis')
  assert.equal(isTrustPrompt(wrapped, SANDBOX), true)
})

test('refuses a trust prompt for a directory the human never picked', () => {
  // Claude Code cd'd somewhere else, or a nested repo asked. Not our mandate.
  assert.equal(isTrustPrompt(PROMPT('/home/lukas'), SANDBOX), false)
  assert.equal(isTrustPrompt(PROMPT('/etc'), SANDBOX), false)
})

test('ordinary output is never mistaken for the prompt', () => {
  for (const noise of [
    `$ ls ${SANDBOX}\nREADME.md src\n`,
    `Running tests in ${SANDBOX} ... 12 passed`,
    `${SANDBOX}: I trust the plan, proceeding`,
    ''
  ]) {
    assert.equal(isTrustPrompt(noise, SANDBOX), false, noise.slice(0, 40))
  }
})

test('answers exactly once, then never again', () => {
  const now = 1_000_000
  const w = newWatch(SANDBOX, now)
  assert.equal(feed(w, PROMPT(SANDBOX), now + 1000), true)
  // An agent that later prints the same text must not get a second keypress.
  assert.equal(feed(w, PROMPT(SANDBOX), now + 2000), false)
})

test('will not answer once the startup window has closed', () => {
  const now = 1_000_000
  const w = newWatch(SANDBOX, now)
  assert.equal(feed(w, PROMPT(SANDBOX), now + TRUST_WINDOW_MS + 1), false, 'too late to be a startup prompt')
  assert.equal(w.answered, false)
})

test('assembles the prompt from the small chunks a pty actually emits', () => {
  const now = 1_000_000
  const w = newWatch(SANDBOX, now)
  const text = PROMPT(SANDBOX)
  let fired = false
  for (let i = 0; i < text.length; i += 7) {
    if (feed(w, text.slice(i, i + 7), now + 500)) fired = true
  }
  assert.equal(fired, true, 'must reassemble across chunk boundaries')
})

test('an empty or absurd sandbox never matches', () => {
  assert.equal(isTrustPrompt(PROMPT(SANDBOX), ''), false)
  assert.equal(isTrustPrompt(PROMPT(SANDBOX), '/'), false)
})
