/**
 * A role is one pair of hands, and work arrives at it faster than hands finish.
 *
 * Typed straight into a working CLI, three hand-offs land inside one turn and
 * come back as one answer that half-did all three - which is what hiring a
 * fourth agent used to be the answer to. So the card is the queue, `pump` is
 * the one server, and it takes the next only when the turn before it ends.
 *
 * Its own file because the pool is the point. `main.test.ts` shares one floor
 * across two hundred tests and every id it has ever spawned is a candidate
 * developer, so "the busy one is the only one" cannot be arranged there - the
 * work goes to whichever of the others happens to be idle, which is the very
 * behaviour under test.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { bootMain, type Main } from './main-harness.ts'
import { DEFAULT_WORKFLOW } from './floors.ts'
import { toMarkdown } from '../src/main/workflow.ts'

const home = mkdtempSync(join(tmpdir(), 'bullpen-queue-'))
const work = mkdtempSync(join(tmpdir(), 'bullpen-queue-work-'))

let main: Main

const settle = (ms = 1600): Promise<unknown> => new Promise((r) => setTimeout(r, ms))

/** Put a message in an agent's outbox, the way an agent itself does. */
const mail = (from: string, msg: object): void => {
  const dir = join(home, 'hive', 'agents', from, 'outbox')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`), JSON.stringify({ from, ...msg }))
}

test('work handed to a busy agent waits in its line until the turn ends', async () => {
  main = await bootMain(home)
  const set = await main.invoke<{ error?: string }>('workflow:set', toMarkdown(DEFAULT_WORKFLOW))
  assert.equal(set.error, undefined, `the floor must apply: ${set.error}`)
  await main.invoke('god:ensure', { cols: 80, rows: 24 })

  await main.invoke('agent:spawn', { id: 'vera', cwd: work, cmd: 'claude', cols: 80, rows: 24, role: 'ba' })
  await main.invoke('agent:spawn', { id: 'wes', cwd: work, cmd: 'claude', cols: 80, rows: 24, role: 'dev' })
  // The only developer on this floor, and mid-turn - the way the CLI's own
  // hook says so. Nobody else can be handed this, so what happens to it is
  // the queue rather than the pool.
  await main.hook('wes').event({ hook_event_name: 'UserPromptSubmit' })

  const before = main.pty('wes').written.join('')
  mail('vera', { to: 'dev', subject: 'build the importer', body: 'the whole thing' })
  await settle()

  assert.ok(
    (await main.invoke<{ text: string }[]>('board:tasks')).some((t) =>
      t.text.includes('build the importer')
    ),
    'the card is on the board straight away - a line has to be visible to be a line'
  )
  assert.equal(
    main.pty('wes').written.join(''),
    before,
    'and nothing was typed into the turn that is still running'
  )

  // The turn ending is what serves the queue.
  await main.hook('wes').event({ hook_event_name: 'Stop' })
  await settle()

  const typed = main.pty('wes').written.join('').slice(before.length)
  assert.match(typed, /build the importer/, 'now it goes out')
  assert.match(typed, /"to": "vera"/, 'reporting to whoever handed it over, by name')
})

test('a second hand-off waits behind the first rather than hiring a second pair of hands', async () => {
  const before = main.ptys.size

  // `wes` is holding the first card now, so this one has nobody free at all -
  // which used to be the whole reason a hire happened.
  mail('vera', { to: 'dev', subject: 'build the exporter', body: 'the other thing' })
  await settle()

  assert.equal(main.ptys.size, before, 'nobody was hired')
  const cards = await main.invoke<{ text: string; agentId: string }[]>('board:tasks')
  const second = cards.find((t) => t.text.includes('build the exporter'))
  assert.ok(second, 'the second job is on the board')
  assert.equal(second.agentId, 'wes', 'in the same line, behind the first')
})

test('a reply is not queued - it is said while the turn it answers is still open', async () => {
  await main.hook('wes').event({ hook_event_name: 'UserPromptSubmit' })
  const before = main.pty('wes').written.join('')

  mail('vera', { to: 'dev', subject: 're: build the importer', body: 'one correction to it' })
  await settle()

  assert.match(
    main.pty('wes').written.join('').slice(before.length),
    /one correction to it/,
    'an answer that waits for the turn it is about to end is an answer nobody can use'
  )
})

after(async () => {
  await main?.stop()
})
