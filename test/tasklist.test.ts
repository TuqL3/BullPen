/**
 * The board as something the floor reads and asks to change.
 *
 * It was a projection nobody on the floor could see: derived from the mail,
 * drawn for the operator, and invisible to every agent it described. So work
 * had no identity - a report moved "the sender's newest open card", which is
 * the wrong card as soon as anybody holds two - and there was no way to put
 * work up for whoever was free rather than handing it to somebody by name.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { bootMain, type Main } from './main-harness.ts'
import { PRESETS as SHIPPED } from '../src/main/presets.ts'
import { DEFAULT_WORKFLOW as CHAIN } from './floors.ts'
import { columnFor, toMarkdown } from '../src/main/workflow.ts'

const home = mkdtempSync(join(tmpdir(), 'bullpen-tasks-'))
const work = mkdtempSync(join(tmpdir(), 'bullpen-tasks-work-'))
const FLOOR = SHIPPED[0]
const START = columnFor(FLOOR, 'start')
const DONE = columnFor(FLOOR, 'done')
const STUCK = columnFor(FLOOR, 'stuck')

let main: Main

const settle = (ms = 1400): Promise<unknown> => new Promise((r) => setTimeout(r, ms))
const mail = (from: string, msg: object): void => {
  const dir = join(home, 'hive', 'agents', from, 'outbox')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
    JSON.stringify({ from, ...msg })
  )
}
const inbox = (id: string): { subject: string; body: string; task?: string }[] => {
  try {
    const dir = join(home, 'hive', 'agents', id, 'inbox')
    return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  } catch {
    return []
  }
}
const tasksFile = (): { columns: string[]; tasks: Record<string, unknown>[] } =>
  JSON.parse(readFileSync(join(home, 'tasks.json'), 'utf8'))

const spawn = (id: string, role: string): Promise<unknown> =>
  main.invoke('agent:spawn', { id, cwd: work, cmd: 'claude', cols: 80, rows: 24, role })

test('the floor can read the whole list, not just its own inbox', async () => {
  main = await bootMain(home)
  const set = await main.invoke<{ error?: string }>('workflow:set', toMarkdown(FLOOR))
  assert.equal(set.error, undefined, `the shipped floor must apply: ${set.error}`)
  await main.invoke('god:ensure', { cols: 80, rows: 24 })
  await spawn('morgan', 'data_analyst')
  await main.invoke('board:addTask', 'morgan', 'pull the exports')

  const view = tasksFile()
  assert.deepEqual(view.columns, FLOOR.columns.map((c) => c.key), 'the columns come with it')
  const card = view.tasks.find((t) => t.text === 'pull the exports')
  assert.ok(card, 'a card on the board is a card on the floor')
  assert.equal(card.agent, 'morgan')
  assert.equal(card.status, START)
  // The projection, not the store: nothing an agent cannot act on.
  assert.ok(!('triggers' in view), 'schedules are the operator\'s, not the floor\'s')

  // And an agent is told where to find it.
  const args = main.pty('morgan').args
  const brief = args[args.indexOf('--append-system-prompt') + 1]
  assert.match(brief, /\$BULLPEN_TASKS/, 'the brief has to name the list')
  assert.match(brief, /"to": "board", "subject": "claim"/, 'and how to take a card')
})

test('work handed over carries the id of the card it opened', async () => {
  await spawn('avery', 'marketing_sale')
  mail('morgan', { to: 'marketing_sale', subject: 'cut the segments', body: 'by region' })
  await settle()

  const got = inbox('avery').find((m) => m.subject === 'cut the segments')
  assert.ok(got, 'the work reaches the worker')
  assert.ok(got.task, 'and says which card it is')
  const card = tasksFile().tasks.find((t) => t.id === got.task)
  assert.equal(card?.agent, 'avery', 'the card named is the card opened for them')
  assert.equal(card?.by, 'morgan', 'and it remembers who is waiting on it')
})

test('a report closes the card it names, not the newest one', async () => {
  // Two cards, one agent - the case that closed the wrong one every time.
  const first = await main.invoke<{ id: string }>('board:addTask', 'avery', 'the older job')
  const second = await main.invoke<{ id: string }>('board:addTask', 'avery', 'the newer job')

  mail('avery', {
    to: 'data_analyst',
    subject: 'done: the older job',
    body: '412 rows',
    task: first.id
  })
  await settle()

  const tasks = tasksFile().tasks
  assert.equal(tasks.find((t) => t.id === first.id)?.status, DONE, 'the one that was named')
  assert.notEqual(tasks.find((t) => t.id === second.id)?.status, DONE, 'and not the newest')
})

test('a card can be posted for a role and claimed by whoever is free', async () => {
  mail('morgan', {
    to: 'board',
    subject: 'post',
    role: 'marketing_sale',
    body: 'reformat the vendor feed'
  })
  await settle()

  const posted = tasksFile().tasks.find((t) => t.text === 'reformat the vendor feed')
  assert.ok(posted, 'the card is on the list')
  assert.equal(posted.agent, '', 'held by nobody until somebody takes it')
  assert.equal(posted.role, 'marketing_sale', 'and says what kind of agent it is for')

  mail('avery', { to: 'board', subject: 'claim', task: posted.id as string })
  await settle()
  assert.equal(
    tasksFile().tasks.find((t) => t.id === posted.id)?.agent,
    'avery',
    'whoever asked first holds it'
  )

  // Michael is a boss, not a marketing worker: the card is not his to take.
  const other = await main.invoke<{ id: string }>('board:addTask', '', 'not for the boss')
  mail('morgan', { to: 'board', subject: 'post', role: 'marketing_sale', body: 'another one' })
  await settle()
  const free = tasksFile().tasks.find((t) => t.text === 'another one')!
  mail('michael', { to: 'board', subject: 'claim', task: free.id as string })
  await settle()
  assert.equal(tasksFile().tasks.find((t) => t.id === free.id)?.agent, '', 'the wrong role is refused')
  assert.ok(
    inbox('michael').some((m) => /not what you are here/.test(m.body)),
    'and told why'
  )
  assert.ok(other, 'a card with no role is a card anyone may be given')
})

test('done on the board also tells whoever was waiting', async () => {
  const held = tasksFile().tasks.find((t) => t.text === 'reformat the vendor feed')!
  mail('avery', { to: 'board', subject: 'done', task: held.id as string, body: 'reformatted' })
  await settle()

  assert.equal(tasksFile().tasks.find((t) => t.id === held.id)?.status, DONE)
  // `by` is morgan, who posted it - a card moving is not a report.
  assert.ok(
    inbox('morgan').some((m) => /^done: reformat the vendor feed/.test(m.subject)),
    'the one waiting on it hears'
  )
})

test('the board refuses a card that is not yours', async () => {
  mail('morgan', { to: 'board', subject: 'post', role: 'marketing_sale', body: 'somebody else work' })
  await settle()
  const free = tasksFile().tasks.find((t) => t.text === 'somebody else work')!
  mail('morgan', { to: 'board', subject: 'done', task: free.id as string })
  await settle()

  assert.notEqual(tasksFile().tasks.find((t) => t.id === free.id)?.status, DONE)
  assert.ok(
    inbox('morgan').some((m) => /not yours|Claim it first/.test(m.body)),
    'said back, not swallowed'
  )
  assert.notEqual(STUCK, DONE, 'the floor has both columns, or this test says nothing')
})

/**
 * A pass closes the build it was a check of, and nothing else.
 *
 * `testerReported` had no way to know which build a check was for, so it closed
 * every card in the waiting column on that project. Two features under test at
 * once therefore closed each other: whichever passed first shipped both, and
 * the board said so with no sign anything had gone wrong.
 *
 * The link is written where the check is handed over - the one moment both
 * cards are in hand - so this is the floor with a checker on it, not the one
 * Bullpen ships.
 */
test('a pass closes the build it checked, not every build waiting', async () => {
  const set = await main.invoke<{ error?: string }>('workflow:set', toMarkdown(CHAIN))
  assert.equal(set.error, undefined, `the chain must apply: ${set.error}`)
  const WAIT = columnFor(CHAIN, 'waiting')
  const CHAIN_DONE = columnFor(CHAIN, 'done')

  for (const [id, role] of [
    ['dev-one', 'dev'],
    ['dev-two', 'dev'],
    ['trang', 'tester']
  ] as const) {
    await main.invoke('agent:spawn', { id, cwd: work, cmd: 'claude', cols: 80, rows: 24, role })
  }

  // Two builds, both waiting on a check.
  const first = await main.invoke<{ id: string }>('board:addTask', 'dev-one', 'the login screen')
  const second = await main.invoke<{ id: string }>('board:addTask', 'dev-two', 'the export job')
  await main.invoke('board:setTaskStatus', first.id, WAIT)
  await main.invoke('board:setTaskStatus', second.id, WAIT)

  // One of them is handed to the tester, quoting the card it is a check of.
  mail('dev-one', {
    to: 'tester',
    subject: 'check the login screen',
    body: 'ready',
    task: first.id
  })
  await settle()

  const checkCard = tasksFile().tasks.find((t) => t.agent === 'trang')
  assert.ok(checkCard, 'the tester is given a card of their own')
  assert.equal(checkCard.checks, first.id, 'and it records which build it is a check of')

  // To the analyst, not to the developer: `checks → assigns: closes` is the rule
  // that finishes a task. A pass mailed to the developer is `checks → builds`,
  // which is a bug going back and puts their card in `doing`.
  mail('trang', { to: 'ba', subject: 'pass: the login screen', body: 'looks right' })
  await settle()

  const tasks = tasksFile().tasks
  assert.equal(tasks.find((t) => t.id === first.id)?.status, CHAIN_DONE, 'the build that passed')
  assert.equal(
    tasks.find((t) => t.id === second.id)?.status,
    WAIT,
    'and the one nobody checked is still waiting'
  )
})

/**
 * Taking a checker off the roster does not strand what it was checking.
 *
 * `checks` points one way: the check names the build, the build names nobody.
 * So deleting the checker's cards deleted the only record that anything was
 * being checked, and left the build in the waiting column with nobody looking
 * at it and nothing that would ever move it - work reading as in progress
 * forever, which is the one thing the board must not say.
 */
test('firing a checker does not leave its build waiting forever', async () => {
  const WAIT = columnFor(CHAIN, 'waiting')
  const CHAIN_STUCK = columnFor(CHAIN, 'stuck')
  await main.invoke('agent:spawn', {
    id: 'dev-three',
    cwd: work,
    cmd: 'claude',
    cols: 80,
    rows: 24,
    role: 'dev'
  })
  await main.invoke('agent:spawn', {
    id: 'hollis',
    cwd: work,
    cmd: 'claude',
    cols: 80,
    rows: 24,
    role: 'tester'
  })
  const build = await main.invoke<{ id: string }>('board:addTask', 'dev-three', 'the settings page')
  await main.invoke('board:setTaskStatus', build.id, WAIT)

  mail('dev-three', { to: 'tester', subject: 'check the settings page', body: 'ready', task: build.id })
  await settle()
  const check = tasksFile().tasks.find((t) => t.checks === build.id)
  assert.ok(check, 'the checker is given a card that names the build')

  await main.invoke('agent:forget', check.agent as string)
  await settle(400)

  const tasks = tasksFile().tasks
  assert.ok(!tasks.some((t) => t.id === check.id), "the checker's own card goes with it")
  assert.equal(
    tasks.find((t) => t.id === build.id)?.status,
    CHAIN_STUCK,
    'and the build it was checking stops reading as in progress'
  )
})

/**
 * A card is a note until the operator says it is work.
 *
 * Adding one told the agent nothing at all, so the list and the floor described
 * two different days. Telling it about every card as it is typed is the other
 * failure: a turn spent on a list still being written. So the press that
 * confirms is the press that spends - and what it starts, it finishes: the next
 * confirmed card goes out when the last one leaves the working column.
 */
test('a confirmed card is worked through, an unconfirmed one only sits there', async () => {
  const START_C = columnFor(CHAIN, 'start')
  const WORKING_C = columnFor(CHAIN, 'working')
  const DONE_C = columnFor(CHAIN, 'done')
  await main.invoke('agent:spawn', {
    id: 'quinn-board',
    cwd: work,
    cmd: 'claude',
    cols: 80,
    rows: 24,
    role: 'dev'
  })
  const first = await main.invoke<{ id: string }>('board:addTask', 'quinn-board', 'write the parser')
  const second = await main.invoke<{ id: string }>('board:addTask', 'quinn-board', 'write the loader')
  await main.invoke('board:addTask', 'quinn-board', 'rewrite the world')
  const typed = (): string => main.pty('quinn-board').written.join(' ')
  const card = (id: string): string | undefined =>
    tasksFile().tasks.find((t) => t.id === id)?.status as string | undefined

  assert.ok(!typed().includes('write the parser'), 'adding a card says nothing to the agent')

  await main.invoke('board:release', first.id)
  await main.invoke('board:release', second.id)
  assert.ok(typed().includes('write the parser'), 'confirming one hands it over')
  assert.ok(!typed().includes('write the loader'), 'the second waits - two tasks in one terminal is one of them lost')
  assert.equal(card(first.id), WORKING_C, 'and the card it started reads as live work')
  assert.equal(card(second.id), START_C, 'while the queued one has not moved')

  // What a report does, done by hand: the card leaves the working column.
  await main.invoke('board:setTaskStatus', first.id, DONE_C)
  await main.hook('quinn-board').event({ hook_event_name: 'Stop' })
  await settle(300)
  assert.ok(typed().includes('write the loader'), 'the next confirmed card goes out on its own')
  assert.ok(!typed().includes('rewrite the world'), 'what was never confirmed is never handed over')
})

/**
 * The human is a party to the floor, and mail to them moves the card.
 *
 * `you` is a reserved address, so it leaves the router by the ask queue rather
 * than by `deliver` - and `routeCard` was never called on that path. Every
 * `→ you` rule an operator wrote was a rule that never fired: the dispatch
 * agent's own card sat in the first column forever while the dry run drew it
 * closing, and one dispatched task left an open card behind it every time.
 */
test('the card closes when the floor tells the human it is done, and not before', async () => {
  // An earlier test leaves another floor running, and `DONE` is this one's.
  await main.invoke('workflow:set', toMarkdown(FLOOR))
  await main.invoke('god:ensure', { cols: 80, rows: 24 })
  await settle(400)
  type Card = { id: string; status: string; agent: string; text: string }
  const held = (): Card | undefined =>
    (tasksFile().tasks as unknown as Card[]).find(
      (t) => t.agent === 'michael' && t.text.includes('the sitemap route')
    )

  await main.invoke('agent:dispatch', 'add the sitemap route', 'decide', '')
  await settle()
  assert.ok(held(), 'dispatch opens a card for the one who takes it')
  assert.notEqual(held()?.status, DONE, 'and it is not finished the moment it is handed over')

  // Progress, which the app asks for by name every time the floor goes quiet.
  mail('michael', { to: 'you', subject: 'report', body: 'still with the analyst' })
  await settle()
  assert.notEqual(held()?.status, DONE, 'a progress report closes nothing')

  // The outcome.
  mail('michael', { to: 'you', subject: 'done: add the sitemap route', body: 'shipped' })
  await settle()
  assert.equal(held()?.status, DONE, 'saying it is done is what takes it off the board')
})

after(async () => {
  await main?.stop()
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})
