/**
 * Everything the "ask me" tab renders, driven through the real plumbing.
 *
 * Three sources, three different mechanisms, and the tab is the only place they
 * meet - so this walks each one end to end and checks it arrives carrying the
 * fields the tab actually reads. A source that silently stops emitting looks,
 * in the UI, exactly like an agent that never asked anything.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Approvals, type Pending } from '../src/main/approvals.ts'
import { Hive, HUMAN, type Message } from '../src/main/hive.ts'

const home = (): string => mkdtempSync(join(tmpdir(), 'bp-ask-'))

test('type 1 of 3: an approval - the hook holds the tool call open', async () => {
  const root = home()
  try {
    const a = new Approvals(join(root, 'control'))
    a.setSandbox('dwight', join(root, 'work'))
    const port = await a.start()

    const seen: Pending[] = []
    a.on('pending', (p: Pending) => {
      seen.push(p)
      a.decide(p.id, 'deny')
    })

    const res = await fetch(`http://127.0.0.1:${port}/hook?token=${a.token}&agent=dwight`, {
      method: 'POST',
      body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /etc' } })
    })
    assert.equal((await res.json()).hookSpecificOutput.permissionDecision, 'deny')

    // The card shows who, which tool, why it stopped, and what it would run.
    assert.equal(seen.length, 1)
    assert.equal(seen[0].agentId, 'dwight')
    assert.equal(seen[0].toolName, 'Bash')
    assert.equal(seen[0].detail, 'rm -rf /etc')
    assert.match(seen[0].reason, /delete/)
    assert.ok(seen[0].createdAt > 0)

    a.stop()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('type 2 of 3: a question through the hive - answerable from the tab', () => {
  const root = home()
  try {
    const hive = new Hive(join(root, 'hive'))
    hive.register('dwight')

    const asked: Message[] = []
    hive.on('question', (m: Message) => asked.push(m))

    // Exactly what an agent does: one json file in its own outbox, to `you`.
    const outbox = join(hive.agentDir('dwight'), 'outbox')
    mkdirSync(outbox, { recursive: true })
    writeFileSync(
      join(outbox, 'q1.json'),
      JSON.stringify({ from: 'dwight', to: HUMAN, subject: 'which branch?', body: 'main or dev?' })
    )
    hive.route()

    assert.equal(asked.length, 1)
    assert.equal(asked[0].subject, 'which branch?')
    assert.equal(asked[0].body, 'main or dev?')

    // And the answer goes back as an ordinary message, so the agent needs no
    // second delivery path to be listening on.
    hive.send({ from: HUMAN, to: 'dwight', subject: 're: which branch?', body: 'dev' })
    hive.route()
    assert.deepEqual(
      hive.drainInbox('dwight').map((m) => m.body),
      ['dev']
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('type 3 of 3: the CLI asking in its own terminal - shown, not answerable', async () => {
  const root = home()
  try {
    const a = new Approvals(join(root, 'control'))
    const port = await a.start()

    const asked: string[] = []
    let cleared = 0
    a.on('waiting', (_id: string, q: string) => asked.push(q))
    a.on('answered', () => cleared++)

    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}?token=${a.token}&agent=dwight`, {
        method: 'POST',
        body: JSON.stringify(body)
      })

    // AskUserQuestion is allowed - there is nothing here for Bullpen to decide -
    // so the only thing that marks it is the announcement.
    const res = await post('/hook', {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Where does project seo live?' }] }
    })
    assert.equal((await res.json()).hookSpecificOutput.permissionDecision, 'allow')
    assert.deepEqual(asked, ['Where does project seo live?'])

    // A plan waiting for approval is the same shape of block.
    await post('/hook', { tool_name: 'ExitPlanMode', tool_input: { plan: '1. do the thing' } })
    assert.deepEqual(asked, ['Where does project seo live?', 'approve the plan'])

    await post('/event', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' })
    assert.equal(cleared, 1, 'answered in the terminal - the card must go')

    a.stop()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
