/**
 * An agent that finishes its turn and tells nobody.
 *
 * Everything on this floor moves because somebody sent a message, which is
 * also the one thing nothing could check: an agent that simply does not write
 * one looks, from outside, exactly like an agent still thinking. The card sat
 * in the working column and the assigner waited for a report that was never
 * coming.
 *
 * Its own file because the watchdog is a clock. `BULLPEN_STALL_MS` has to be
 * turned down to something a test can wait for, and node runs each test file
 * in its own process - so main.test.ts keeps the real five minutes and nothing
 * there gets chased mid-test.
 */
process.env.BULLPEN_STALL_MS = '2000'
process.env.BULLPEN_HUNG_MS = '4000'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { bootMain, type Main } from './main-harness.ts'
import { PRESETS as SHIPPED } from '../src/main/presets.ts'
import { columnFor, toMarkdown } from '../src/main/workflow.ts'

const home = mkdtempSync(join(tmpdir(), 'bullpen-stall-'))
const work = mkdtempSync(join(tmpdir(), 'bullpen-stall-work-'))
const FLOOR = SHIPPED[0]
const START = columnFor(FLOOR, 'start')
const STUCK = columnFor(FLOOR, 'stuck')

let main: Main

const settle = (ms: number): Promise<unknown> => new Promise((r) => setTimeout(r, ms))
const inbox = (id: string): { subject: string; body: string }[] => {
  try {
    const dir = join(home, 'hive', 'agents', id, 'inbox')
    return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  } catch {
    return []
  }
}
/** One turn, start to finish, without a single message written. */
const silentTurn = async (id: string): Promise<void> => {
  const hook = main.hook(id)
  await hook.event({ hook_event_name: 'UserPromptSubmit' })
  await hook.event({ hook_event_name: 'Stop' })
}

test('a silent agent is chased, then its card is called stuck', async () => {
  main = await bootMain(home)
  const set = await main.invoke<{ error?: string }>('workflow:set', toMarkdown(FLOOR))
  assert.equal(set.error, undefined, `the shipped floor must apply: ${set.error}`)
  const god = await main.invoke<{ id: string }>('god:ensure', { cols: 80, rows: 24 })

  await main.invoke('agent:spawn', {
    id: 'quinn',
    cwd: work,
    cmd: 'claude',
    cols: 80,
    rows: 24,
    role: 'marketing_sale'
  })
  const card = await main.invoke<{ id: string; status: string }>(
    'board:addTask',
    'quinn',
    'cut the segments by region'
  )
  assert.equal(card.status, START, 'the card starts where the floor starts')

  // Turn one: it works, it stops, it writes nothing.
  const before = main.pty('quinn').written.join('').length
  await silentTurn('quinn')
  await settle(2600)

  const typed = main.pty('quinn').written.join('').slice(before)
  assert.match(typed, /still holding this task/, 'it is asked once, in its own terminal')
  assert.match(typed, /"done: "/, 'and told the word that closes a card')

  const chased = await main.invoke<{ status: string }[]>('board:tasks', 'quinn')
  assert.equal(chased[0].status, START, 'one silence is a question, not a verdict')

  // Turn two: asked, and still says nothing.
  await silentTurn('quinn')
  await settle(2600)

  const after2 = await main.invoke<{ status: string }[]>('board:tasks', 'quinn')
  assert.equal(after2[0].status, STUCK, 'the board must not go on calling this live work')
  assert.ok(
    inbox(god.id).some((m) => /^no report:/.test(m.subject)),
    'and Michael is told, because he is who reports to the human'
  )
})

test('an agent that reports is not chased', async () => {
  await main.invoke('agent:spawn', {
    id: 'avery',
    cwd: work,
    cmd: 'claude',
    cols: 80,
    rows: 24,
    role: 'marketing_sale'
  })
  await main.invoke('board:addTask', 'avery', 'count the campaign')

  const before = main.pty('avery').written.join('').length
  const hook = main.hook('avery')
  await hook.event({ hook_event_name: 'UserPromptSubmit' })
  // What a working agent does: one message out before the turn ends. To the
  // analyst, because that is the only address this role has - a report to the
  // boss is refused by the router, and being chased for it would be right.
  const out = join(home, 'hive', 'agents', 'avery', 'outbox')
  mkdirSync(out, { recursive: true })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    join(out, 'report.json'),
    JSON.stringify({ from: 'avery', to: 'data_analyst', subject: 'done: counted', body: '412' })
  )
  await hook.event({ hook_event_name: 'Stop' })
  await settle(3200)

  const typed = main.pty('avery').written.join('').slice(before)
  assert.ok(!typed.includes('still holding this task'), 'a report is not silence')
})

/**
 * A turn that never ends.
 *
 * The one failure with no event of its own: no Stop hook, no exit, nothing to
 * hang a handler off. The id sat in `working` for the rest of the run, so the
 * card read as live work nobody was doing - and `reportWhenQuiet` waits for
 * that set to empty, which meant one hung agent silently ended every progress
 * report after it. The same cost a killed pty used to have, guarded on the way
 * out of `exit`; this is the case where nothing exits.
 */
test('a turn that never ends is written off, and the floor is not muted by it', async () => {
  const god = await main.invoke<{ id: string }>('god:ensure', { cols: 80, rows: 24 })
  await main.invoke('agent:spawn', {
    id: 'rowan',
    cwd: work,
    cmd: 'claude',
    cols: 80,
    rows: 24,
    role: 'marketing_sale'
  })
  await main.invoke('board:addTask', 'rowan', 'reformat the export')

  // Starts, and never stops.
  await main.hook('rowan').event({ hook_event_name: 'UserPromptSubmit' })
  const cards = await main.invoke<{ status: string }[]>('board:tasks', 'rowan')
  assert.notEqual(cards[0].status, STUCK, 'a turn in progress is not stuck yet')

  await settle(7000)

  const after = await main.invoke<{ status: string }[]>('board:tasks', 'rowan')
  assert.equal(after[0].status, STUCK, 'the board must not call this live work')
  assert.ok(
    inbox(god.id).some((m) => /^no end to a turn: rowan/.test(m.subject)),
    'Michael is told, once'
  )

  // Nothing was killed: it may still come back, and if it does the Stop hook
  // takes it out of both sets like any other turn.
  assert.equal(main.pty('rowan').killed, false, 'a slow turn is not a turn to kill')
})

/**
 * A card posted for a role and taken by nobody.
 *
 * `post` puts a card on the list and offers it to one agent, unheld on purpose
 * so a busy one can pass. Nothing then looked at it again: an offer declined -
 * or made to an agent that never read it - left the card on the list with no
 * holder and no chase. The silent-agent watchdog cannot see it, because it
 * watches agents and this card has none.
 */
test('a card nobody claims is offered again, then handed back', async () => {
  const god = await main.invoke<{ id: string }>('god:ensure', { cols: 80, rows: 24 })
  await main.invoke('agent:spawn', {
    id: 'ellis',
    cwd: work,
    cmd: 'claude',
    cols: 80,
    rows: 24,
    role: 'data_analyst'
  })

  const out = join(home, 'hive', 'agents', 'ellis', 'outbox')
  mkdirSync(out, { recursive: true })
  writeFileSync(
    join(out, 'post.json'),
    JSON.stringify({
      from: 'ellis',
      to: 'board',
      subject: 'post',
      role: 'marketing_sale',
      body: 'nobody wants this one'
    })
  )
  await settle(1200)

  const list = (): Record<string, string>[] =>
    JSON.parse(readFileSync(join(home, 'tasks.json'), 'utf8')).tasks
  const posted = list().find((t) => t.text === 'nobody wants this one')
  assert.ok(posted, 'the card is on the list')
  assert.equal(posted.agent, '', 'and unheld, so somebody busy can pass on it')

  // Offered once by `post` itself: a card nobody is told about is a card nobody
  // opens, whatever file it is written in.
  const offered = readdirSync(join(home, 'hive', 'agents'))
    .flatMap((id) => {
      try {
        const dir = join(home, 'hive', 'agents', id, 'inbox')
        return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
      } catch {
        return []
      }
    })
    .filter((m) => /^up for grabs:/.test(m.subject))
  assert.ok(offered.length >= 1, 'somebody is told it is there')
  assert.equal(offered[0].task, posted.id, 'and told which card')

  // Nobody claims it. Two sweeps: offered once more, then given back.
  await settle(7000)
  const after = list().find((t) => t.id === posted.id)!
  assert.equal(after.status, STUCK, 'the board stops calling it work anybody is on')
  assert.ok(
    inbox('ellis').some((m) => /^nobody took:/.test(m.subject)),
    'and whoever posted it hears, because it is theirs again'
  )
  assert.ok(god.id, 'the floor was up throughout')
})

after(async () => {
  await main?.stop()
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})
