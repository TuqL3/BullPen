/**
 * `src/main/index.ts`, exercised.
 *
 * It is the one file with no test at all - 2300 lines wiring the roster, the
 * approvals queue, the report loop and the shells together - and every bug ever
 * found in it was found by reading. `main-harness.ts` says what it costs to
 * load it outside Electron; this is what that buys.
 */
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { bootMain, dialogAnswer, type Main } from './main-harness.ts'
import { DEFAULT_WORKFLOW as CHAIN } from './floors.ts'
import { PRESETS as SHIPPED } from '../src/main/presets.ts'
import { toMarkdown } from '../src/main/workflow.ts'

const home = mkdtempSync(join(tmpdir(), 'bullpen-main-'))
const work = mkdtempSync(join(tmpdir(), 'bullpen-work-'))
let main: Main

const hire = async (id: string, role?: string): Promise<void> => {
  await main.invoke('agent:spawn', { id, cwd: work, cmd: 'claude', cols: 80, rows: 24, ...(role ? { role } : {}) })
}

/** Put a message in an agent's outbox, the way an agent itself does. */
const mail = (from: string, msg: object): void => {
  const dir = join(home, 'hive', 'agents', from, 'outbox')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`), JSON.stringify({ from, ...msg }))
}
const inbox = (id: string): { subject: string; body: string }[] => {
  const dir = join(home, 'hive', 'agents', id, 'inbox')
  try {
    return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  } catch {
    return []
  }
}
/** The router sweeps every 500ms and a reply needs a second sweep to come back. */
const settle = (ms = 1600): Promise<unknown> => new Promise((r) => setTimeout(r, ms))
const turn = (model: string, input: number, output: number, text: string): string =>
  JSON.stringify({
    type: 'assistant',
    message: { model, usage: { input_tokens: input, output_tokens: output }, content: [{ type: 'text', text }] }
  }) + '\n'

test('main comes up and registers its surface', async () => {
  main = await bootMain(home)
  assert.ok(main.channels.includes('agent:kill'), `channels: ${main.channels.length}`)
  assert.ok(main.channels.length > 40, `only ${main.channels.length} channels`)

  // The floor these tests are written about: an analyst who hands work out, a
  // developer, a tester. Bullpen ships a boss and a worker now, and every role
  // named below - `ba`, `dev`, `tester` - is a role that floor does not have.
  const set = await main.invoke<{ error?: string }>('workflow:set', toMarkdown(CHAIN))
  assert.equal(set.error, undefined, `the chain must apply: ${set.error}`)
})

test('an agent killed mid-turn does not jam the floor for the rest of the run', async () => {
  // `working` is emptied by the Stop hook, which a killed pty never sends. It
  // stayed in there forever - and `reportWhenQuiet` waits for that set to be
  // empty, so halting one busy agent silently ended every progress report for
  // the rest of the session.
  const god = await main.invoke<{ id: string }>('god:ensure', { cols: 80, rows: 24 })
  await main.invoke('fixed:ensure', { cols: 80, rows: 24 })
  // Work handed over is what makes a report owed.
  assert.equal(await main.invoke('agent:dispatch', 'ship the thing', 'decide', ''), null)

  await hire('quinn')
  await main.hook('quinn').event({ hook_event_name: 'UserPromptSubmit' })
  assert.equal(main.last('agent:status')?.[1], 'working')
  await main.invoke('agent:kill', 'quinn')
  assert.equal(main.pty('quinn').killed, true)

  // Everyone standing takes a turn and finishes it. With the floor now quiet,
  // somebody has to be asked where the work stands.
  for (const id of [...main.ptys.keys()]) {
    if (id.startsWith('shell:') || main.ptys.get(id)!.killed) continue
    const h = main.hook(id)
    await h.event({ hook_event_name: 'UserPromptSubmit' })
    await h.event({ hook_event_name: 'Stop' })
  }

  const asked = [...main.ptys.values()].some((p) => /idle now/i.test(p.written.join('')))
  assert.ok(asked, 'the floor going quiet has to reach somebody')
  assert.ok(god.id, 'and the boss is who it is dispatched through')
})

test('what a role never does follows the role, at spawn and after it', async () => {
  // The brief and the tool refusals are both read once, when the pty is made.
  // The wizard used to spawn first and say the role afterwards, so an agent was
  // briefed as whatever the floor's default is whatever the dropdown said.
  const md = await main.invoke<{ markdown: string }>('workflow:get')
  const floor = md.markdown
    .replace('### dev · a developer', '### dev · a developer\n- never: Bash')
  const set = await main.invoke<{ error?: string }>('workflow:set', floor)
  assert.equal(set.error, undefined, `the floor must apply: ${set.error}`)

  await hire('rowan', 'dev')
  const brief = main.pty('rowan').args[main.pty('rowan').args.indexOf('--append-system-prompt') + 1]
  assert.ok(brief && brief.length > 0, 'an agent is briefed at spawn or never')

  const hook = main.hook('rowan')
  const bash = await hook.ask({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  assert.equal(bash.permissionDecision, 'deny', 'a tool the role never uses is refused')
  assert.match(bash.permissionDecisionReason, /this role does/)

  // And a role that may use it is not refused. Named, because an agent spawned
  // without one falls back to whoever builds here - which is the role the test
  // just took Bash away from.
  await hire('sloane', 'god')
  const ok = await main.hook('sloane').ask({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  assert.equal(ok.permissionDecision, 'allow')
})

test('a halted agent takes its blocked request off the queue with it', async () => {
  // Named for the same reason: the fallback role is the one an earlier test
  // forbade Bash to, and a denied call is never asked about.
  await hire('ellis', 'god')
  const hook = main.hook('ellis')
  // Parked: nobody has decided, so this does not resolve until it is killed.
  const asked = hook.ask({ tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } })
  for (let i = 0; i < 100 && !main.last('approvals:pending'); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.ok(main.last('approvals:pending'), 'it should be waiting on a human')

  await main.invoke('agent:kill', 'ellis')
  // Raced, not simply awaited: left pending this never resolves at all, and a
  // test that hangs says less than one that fails.
  const out = await Promise.race([
    asked,
    new Promise<{ permissionDecision: string }>((r) =>
      setTimeout(() => r({ permissionDecision: 'never answered' }), 2000)
    )
  ])
  assert.equal(out.permissionDecision, 'deny', 'the request is answered, not left hanging')
  assert.ok(main.last('approvals:resolved'), 'and the queue is told')
})

test('the floor that ships is not written over', async () => {
  // It has no file: it is in the source. Saving one used to write a file beside
  // it under the same name, which the list then dropped for being a duplicate -
  // so an edit to the shipped floor went to disk and disappeared.
  // This run is on the chain fixture, so the name is what makes it the shipped
  // one - which is exactly what main checks.
  const md = await main.invoke<{ markdown: string }>('workflow:get')
  const shipped = md.markdown.replace(/^# .*$/m, `# ${SHIPPED[0].name}`)
  const mine = md.markdown.replace(/^# .*$/m, '# mine')

  const refused = await main.invoke<{ error?: string }>('workflow:save', shipped)
  assert.match(refused.error ?? '', /Bullpen ships/)

  const kept = await main.invoke<{ error?: string }>('workflow:save', mine)
  assert.equal(kept.error, undefined, `under another name it saves: ${kept.error}`)
})

test('a floor against a law is not written to disk', async () => {
  // The one law that ships: the desk a task is typed at has to be able to hand
  // it on. Saving used to write the file and report the breach underneath it,
  // which is not what "must" means - and the drawing that broke it was a role
  // deleted from the canvas, one keystroke away.
  const md = await main.invoke<{ markdown: string }>('workflow:get')
  const lonely = md.markdown.replace(/^- talks to: .*$/m, '- talks to: you, hire')

  const refused = await main.invoke<{ error?: string }>('workflow:save', lonely)
  assert.match(refused.error ?? '', /can write to nobody but/)

  // And the floor on disk is still the one that was there before it.
  const still = await main.invoke<{ markdown: string }>('workflow:get')
  assert.equal(still.markdown, md.markdown)

  const ok = await main.invoke<{ error?: string }>('workflow:save', md.markdown)
  assert.equal(ok.error, undefined, `a legal floor still saves: ${ok.error}`)
})

test('a message the floor refuses is handed back with somewhere else to send it', async () => {
  // The failure this prevents is silence: an agent whose message vanished waits
  // for a reply that is never coming.
  await hire('dev-a', 'dev')
  mail('dev-a', { to: 'you', subject: 'can I?', body: 'asking' })
  await settle()
  const back = inbox('dev-a')
  assert.equal(back.length, 1, 'a refused sender must be told')
  assert.match(back[0].subject, /not delivered/i)
  assert.match(back[0].body, /you write to/i, 'and told where it should have gone')
})

test('work handed to a role, not a person, lands on somebody and on the board', async () => {
  // Addressed to `dev` rather than to an id: the floor picks who is free, or
  // hires. Sent by whoever the floor allows to hand work out - the router
  // refuses the boss writing straight to a builder, which is the chain.
  await hire('iris', 'ba')
  await hire('dev-b', 'dev')
  mail('iris', { to: 'dev', subject: 'build it', body: 'the thing' })
  await settle()
  const tasks = await main.invoke<{ agentId: string; text: string }[]>('board:tasks')
  assert.ok(
    tasks.some((t) => t.text.includes('build it')),
    `nobody got the work: ${JSON.stringify(tasks)}`
  )
})

test('an agent holding work is not stood down without being asked', async () => {
  // A stand-down kills the process mid-turn, and what it was doing goes with
  // it. Idle agents are nobody's question; one holding a card is work somebody
  // is waiting on, so the switch stops and asks - and "keep this floor" keeps
  // the floor that is running, not a half-applied one.
  await hire('nadia', 'ba')
  await hire('omar', 'dev')
  mail('nadia', { to: 'dev', subject: 'build it', body: 'the other thing' })
  await settle()
  const held = (await main.invoke<{ agentId: string; text: string }[]>('board:tasks')).find((t) =>
    t.text.includes('the other thing')
  )
  assert.ok(held, 'the card has to be open before the question means anything')

  const before = await main.invoke<{ markdown: string }>('workflow:get')
  dialogAnswer.messageBox = 1
  try {
    // The shipped floor has none of the chain's roles, so every agent on it is
    // for the door - including the one holding that card.
    const res = await main.invoke<{ error?: string }>('workflow:set', toMarkdown(SHIPPED[0]))
    assert.match(res.error ?? '', /^Kept "/, 'the switch is refused, and says which floor stayed')
  } finally {
    dialogAnswer.messageBox = 0
  }

  assert.equal(main.pty(held.agentId).killed, false, 'the agent holding it is still up')
  const after = await main.invoke<{ markdown: string }>('workflow:get')
  assert.equal(after.markdown, before.markdown, 'and the floor on disk did not move')
})

test('what a turn cost, and how full the window is, come off the transcript', async () => {
  await hire('sawyer')
  const tx = join(work, 'sawyer.jsonl')
  writeFileSync(tx, turn('claude-opus-5', 500_000, 1000, 'built the thing'))
  const hook = main.hook('sawyer')
  await hook.event({ hook_event_name: 'UserPromptSubmit', transcript_path: tx })
  await hook.event({ hook_event_name: 'Stop', transcript_path: tx })
  await settle(1500)

  const ctx = main.last('agent:ctx')?.[1] as { used: number; limit: number; pct: number }
  assert.ok(ctx, 'a finished turn has to produce a reading')
  assert.equal(ctx.used, 500_000)
  assert.equal(ctx.limit, 1_000_000, 'opus 5 is a 1M window, whatever the id says')
  assert.equal(ctx.pct, 50)

  const cost = main.last('agent:cost')?.[1] as { usd: number; turns: number; complete: boolean }
  assert.equal(cost.turns, 1)
  assert.equal(cost.complete, true, 'every token seen had a price')
  assert.ok(cost.usd > 0)

  // And what it last said is what "finished" reports.
  const done = main.pushed
    .filter((p) => p.channel === 'activity:item')
    .map((p) => p.args[0] as { kind: string; text: string })
    .filter((a) => a.kind === 'done')
  assert.ok(done.some((d) => /built the thing/.test(d.text)), 'the report is what it last said')
})

test('a context rule compacts an idle agent whose window has filled', async () => {
  await main.invoke('board:setRule', 'sawyer', 40, 'compact')
  const tx = join(work, 'sawyer.jsonl')
  appendFileSync(tx, turn('claude-opus-5', 900_000, 10, 'more'))
  const before = main.pty('sawyer').written.join('').length
  await main.hook('sawyer').event({ hook_event_name: 'Stop', transcript_path: tx })
  await settle(1500)
  const typed = main.pty('sawyer').written.join('').slice(before)
  assert.match(typed, /\/compact/, 'a full window at an idle agent is compacted')
})

test('the inbound door answers its own knock', async () => {
  const set = await main.invoke<{ enabled: boolean }>('webhook:set', true, 0)
  assert.equal(set.enabled, true)
  const res = await main.invoke<{ ok: boolean; status?: number }>('webhook:test')
  assert.equal(res.ok, true, 'the whole path - socket, token, parser, mail - has to work')
  assert.equal(res.status, 202)
  await main.invoke('webhook:set', false, 0)
})

/**
 * The front desk is Michael, including on a floor typed by hand.
 *
 * Three doors already forced it - the chart on the way out of `staffed`, the
 * generator on the way out of `tidy`, and the blank floor by writing it in.
 * This was the fourth: markdown pasted into the file column and applied as it
 * stands, which is the one path that reached `workflow:set` uncorrected. What
 * came out was a floor whose dispatch agent was somebody else - a different id
 * to every brief that writes to Michael, a different face on the roster, and
 * nothing anywhere saying it had happened.
 */
test('the desk work is typed at is Michael, whatever the file put there', async () => {
  const before = await main.invoke<{ markdown: string }>('workflow:get')
  const floor = before.markdown.replace(/^- agent: .+$/m, '- agent: sep · Sếp')
  assert.match(floor, /- agent: sep · Sếp/, 'the test has to actually seat somebody else')

  const set = await main.invoke<{ error?: string }>('workflow:set', floor)
  assert.equal(set.error, undefined, `a floor naming somebody else is corrected, not refused: ${set.error}`)

  const after = await main.invoke<{ markdown: string }>('workflow:get')
  assert.match(after.markdown, /- agent: michael · Michael/)
  assert.ok(!after.markdown.includes('sep · Sếp'), 'and the other name is gone, not merely outranked')

  // The saved copy too. It used to be written from the text as typed, so the
  // floor ran as Michael and reopened as somebody else on the next launch.
  const saved = await main.invoke<{ name: string; markdown: string }[]>('workflow:list')
  const mine = saved.find((w) => w.markdown.includes('- agent:'))
  assert.ok(mine && !mine.markdown.includes('sep · Sếp'), 'what is on disk is what is running')

  const god = await main.invoke<{ id: string }>('god:ensure', { cols: 80, rows: 24 })
  assert.equal(god.id, 'michael', 'and he is who the dispatch box types at')
})

/**
 * A card typed in by hand starts where the floor starts.
 *
 * `board.addTask` defaults to `todo`, which is one board's word: the floor
 * Bullpen ships starts at `asked`. The IPC never passed a column, so every
 * hand-added card was stored under a key the board has no column for - not
 * drawn anywhere, and nothing able to move it out.
 */
test('a card added by hand lands in the floor\'s own starting column', async () => {
  const shipped = SHIPPED[0]
  const start = shipped.columns.find((c) => c.kind === 'start')!.key
  assert.notEqual(start, 'todo', 'this test says nothing if the shipped floor starts at todo')

  const set = await main.invoke<{ error?: string }>('workflow:set', toMarkdown(shipped))
  assert.equal(set.error, undefined, `the shipped floor must apply: ${set.error}`)

  const card = await main.invoke<{ status: string } | null>('board:addTask', 'harper', 'count the exports')
  assert.equal(card?.status, start)
})

/**
 * The two words that move a card are said to everybody, not only to whoever
 * hands work out.
 *
 * They used to sit behind the "here is how you hand work over" guard, which is
 * skipped for a role that writes to nobody but the human. That is the one role
 * whose report is the last thing that happens to a task: it reported in
 * whatever words it chose, and `stuckInstead` reads "fail:" - so a failure
 * closed the card green on the one hand-off the operator actually reads.
 */
test('every agent is told the two words, even one who hands work to nobody', async () => {
  const floor = toMarkdown(SHIPPED[0]).replace(
    /^- talks to: data_analyst$/m,
    '- talks to: you'
  )
  assert.match(floor, /- talks to: you/, 'the test has to actually cut the role off')
  const set = await main.invoke<{ error?: string }>('workflow:set', floor)
  assert.equal(set.error, undefined, `the floor must apply: ${set.error}`)

  await hire('marlowe', 'marketing_sale')
  const args = main.pty('marlowe').args
  const brief = args[args.indexOf('--append-system-prompt') + 1]
  assert.ok(brief, 'an agent is briefed at spawn or never')
  assert.match(brief, /"done: "/, 'the word that closes a card')
  assert.match(brief, /"fail: "/, 'and the word that does not')
  assert.ok(
    !brief.includes('Handing work over'),
    'and it is not told how to hand out work it can hand to nobody'
  )
})

/**
 * Work handed down the chain staffs the floor, and Michael is who staffed it.
 *
 * Every step hires: the boss asks for an analyst and gets one, and the analyst
 * asks for a worker and gets one too - without either of them reading the
 * roster, checking who is idle, or writing to `hire`. The hire is logged
 * against Michael whoever asked, because there is one desk that staffs this
 * floor and it is not whichever agent happened to want the work done.
 */
test('a role nobody holds is hired into, at any depth, by Michael', async () => {
  const set = await main.invoke<{ error?: string }>('workflow:set', toMarkdown(SHIPPED[0]))
  assert.equal(set.error, undefined, `the shipped floor must apply: ${set.error}`)
  const god = await main.invoke<{ id: string }>('god:ensure', { cols: 80, rows: 24 })
  // An empty floor, because that is what this test is about. Earlier tests
  // leave agents standing and idle, and an idle one holding the role being
  // asked for is reused rather than hired - which is correct, and is the other
  // half of `assignTo`.
  for (const id of [...main.ptys.keys()]) {
    if (id !== god.id) await main.invoke('agent:kill', id)
  }
  // By who is *running*, not by which keys exist. Hire names come off the same
  // roster earlier tests spawn by hand from, so a fresh hire routinely reuses
  // an id this harness has already seen - and comparing key sets reads that as
  // nobody having been hired at all.
  const running = (): string[] => [...main.ptys.keys()].filter((id) => !main.pty(id).killed)
  const before = new Set(running())
  const added = (): string[] => running().filter((id) => !before.has(id))

  // Step one: the boss hands work to a role with nobody in it.
  mail(god.id, { to: 'data_analyst', subject: 'count the exports', body: 'by channel' })
  await settle(1200)
  const [analyst] = added()
  assert.ok(analyst, 'the boss asked for an analyst and nobody was free - somebody is hired')

  // Step two: that hire hands work on, and is staffed the same way. It has no
  // project of its own and never writes to "hire".
  mail(analyst, { to: 'marketing_sale', subject: 'cut the segments', body: 'by region' })
  await settle(1200)
  const worker = added().find((id) => id !== analyst)
  assert.ok(worker, 'and the analyst asking one step further is staffed too')

  // Reported to whoever asked, not to whoever hired.
  const args = main.pty(worker).args
  const brief = args[args.indexOf('--append-system-prompt') + 1]
  assert.match(brief, new RegExp(analyst), 'the work goes back to the one who handed it over')

  // The hire line names the display name, not the id, so match on the asker -
  // there is one hire line per step and each names who needed somebody.
  const log = await main.invoke<{ actor: string; text: string }[]>('activity:list', 400)
  for (const asker of [god.id, analyst]) {
    const line = log.find((a) => /hired/.test(a.text) && a.text.startsWith(`${asker} needed`))
    assert.ok(line, `the hire ${asker} caused is on the record`)
    assert.equal(line.actor, god.id, `a hire is Michael's: ${line.text}`)
  }
})

/**
 * The monitor keeps every round, not the last one.
 *
 * One report was held, and the next overwrote it - so a floor that reports
 * three times an hour threw its own history away as fast as it wrote it. All
 * that was left of the round before was an activity line saying a report had
 * happened, without a word of what it said.
 */
test('reports pile up newest first instead of overwriting each other', async () => {
  const god = await main.invoke<{ id: string }>('god:ensure', { cols: 80, rows: 24 })
  const before = (await main.invoke<{ subject: string }[]>('report:list')).length

  mail(god.id, { to: 'you', subject: 'report: first round', body: 'two files read' })
  await settle(1200)
  mail(god.id, { to: 'you', subject: 'report: second round', body: 'the spec is in' })
  await settle(1200)

  const list = await main.invoke<{ subject: string; ts: number }[]>('report:list')
  assert.equal(list.length, before + 2, 'both are kept')
  assert.equal(list[0].subject, 'report: second round', 'newest first')
  assert.equal(list[1].subject, 'report: first round')
  assert.ok(list[0].ts >= list[1].ts, 'and stamped, so the monitor can date them')

  // A report is not a question: neither of them may reach the ask queue.
  const asked = await main.invoke<{ subject: string }[]>('ask:list')
  assert.equal(
    asked.filter((a) => /round/.test(a.subject)).length,
    0,
    'nothing owed in reply, so nothing waiting for one'
  )
})

/**
 * A hire that names no role gets the one the asker is waiting on.
 *
 * Michael writes `{to: "hire", subject: <project>}` and nothing else - that is
 * what his own briefing tells him to send, and there is no role in it. The
 * fallback used to be "whoever builds", which on this floor is the marketing &
 * sale worker: two desks past the analyst the boss actually hands work to, and
 * briefed to report to a role with nobody in it. The floor came up with no
 * analyst on it and the request stopped there.
 */
test('a hire with no role named is hired into the next role down the chain', async () => {
  const set = await main.invoke<{ error?: string }>('workflow:set', toMarkdown(SHIPPED[0]))
  assert.equal(set.error, undefined, `the shipped floor must apply: ${set.error}`)
  const god = await main.invoke<{ id: string }>('god:ensure', { cols: 80, rows: 24 })
  for (const id of [...main.ptys.keys()]) {
    if (id !== god.id) await main.invoke('agent:kill', id)
  }
  const running = (): string[] => [...main.ptys.keys()].filter((id) => !main.pty(id).killed)
  const before = new Set(running())

  mail(god.id, { to: 'hire', subject: 'nfc-music-box', cwd: work, body: 'read the spec' })
  await settle(1200)

  const [hired] = running().filter((id) => !before.has(id))
  assert.ok(hired, 'somebody is hired')
  const line = (await main.invoke<{ text: string }[]>('activity:list', 400)).find((a) =>
    /hired .* on nfc-music-box/.test(a.text)
  )
  assert.ok(line, 'the hire is on the record')
  assert.match(
    line.text,
    /as data_analyst/,
    `the boss talks to the analyst, so that is who gets hired: ${line.text}`
  )
})

/**
 * A message the floor accepted and could not place is answered.
 *
 * `blocked` - a message the chain refused - has always replied. This is the
 * other silence: an address that got past the gate and reached nobody, which
 * from the sender's side is worse, because they were allowed to write it. It
 * was logged, pushed at the UI, and never mentioned to the agent waiting.
 */
test('a message that reaches nobody comes back with a reason', async () => {
  await main.invoke('workflow:set', toMarkdown(SHIPPED[0]))
  const god = await main.invoke<{ id: string }>('god:ensure', { cols: 80, rows: 24 })

  mail(god.id, { to: 'nobody-of-that-name', subject: 'a word', body: 'please' })
  await settle(1200)
  const back = inbox(god.id)
  assert.ok(
    back.some((m) => /not delivered: a word/.test(m.subject)),
    'the sender is told, not merely logged at'
  )
})

/**
 * A line from a role back to itself means "hand it to another one of me".
 *
 * `assignTo` used to refuse that before the floor was consulted, on the way to
 * stopping an agent handing work to itself - which the candidate list already
 * does, by dropping the sender. So the drawing had no say: a floor of two
 * writers who pass work between them was read as a floor where that line does
 * nothing, and the message died without a reply.
 */
test('a role may hand work to another agent in the same role, if the floor drew it', async () => {
  const floor = toMarkdown(SHIPPED[0]).replace(
    '- talks to: boss, marketing_sale',
    '- talks to: boss, marketing_sale, data_analyst'
  )
  assert.match(floor, /- talks to: boss, marketing_sale, data_analyst/, 'the self line has to be drawn')
  const set = await main.invoke<{ error?: string }>('workflow:set', floor)
  assert.equal(set.error, undefined, `a floor may draw a line to itself: ${set.error}`)

  const god = await main.invoke<{ id: string }>('god:ensure', { cols: 80, rows: 24 })
  for (const id of [...main.ptys.keys()]) {
    if (id !== god.id) await main.invoke('agent:kill', id)
  }
  // By who is *running*, not by which keys exist. Hire names come off the same
  // roster earlier tests spawn by hand from, so a fresh hire routinely reuses
  // an id this harness has already seen - and comparing key sets reads that as
  // nobody having been hired at all.
  const running = (): string[] => [...main.ptys.keys()].filter((id) => !main.pty(id).killed)
  const before = new Set(running())
  const added = (): string[] => running().filter((id) => !before.has(id))

  mail(god.id, { to: 'data_analyst', subject: 'the first half', body: 'q1' })
  await settle(1200)
  const [first] = added()
  assert.ok(first, 'somebody is hired into the role')

  // The one thing that was impossible: an analyst asking for an analyst.
  mail(first, { to: 'data_analyst', subject: 'the second half', body: 'q2' })
  await settle(1200)
  const second = added().find((id) => id !== first)
  assert.ok(second, 'and a second one, because the sender is not a candidate for their own ask')
})

/**
 * The other door onto the same floor.
 *
 * `workflow:patch` applies a floor from a partial - the chart's shape, without
 * a round trip through markdown. It set `wf`, saved, and stopped: no reseating
 * of the front desk, no board cleared, no tool refusals re-read. So a floor
 * applied through it came up with cards keyed to columns it no longer had and
 * whoever the patch named sitting at Michael's desk, while the same floor
 * applied through `workflow:set` came up correctly.
 */
test('applying a floor by patch does what applying it by text does', async () => {
  await main.invoke('workflow:set', toMarkdown(SHIPPED[0]))
  const god = await main.invoke<{ id: string }>('god:ensure', { cols: 80, rows: 24 })
  const before = await main.invoke<{
    workflow: { dispatch: string; roles: Record<string, { fixed?: { id: string; name: string } }> }
  }>('workflow:get')
  const seat = before.workflow.dispatch

  await main.invoke('board:addTask', god.id, 'a card from the old floor')
  assert.ok(
    (await main.invoke<unknown[]>('board:tasks')).length > 0,
    'there is a card to lose'
  )

  const out = await main.invoke<{ workflow: { roles: Record<string, { fixed?: { id: string } }> } }>(
    'workflow:patch',
    { roles: { ...before.workflow.roles, [seat]: { ...before.workflow.roles[seat], fixed: { id: 'sep', name: 'S\u1ebfp' } } } }
  )
  assert.equal(out.workflow.roles[seat].fixed?.id, 'michael', 'the desk is Michael on every door')
  assert.equal(
    (await main.invoke<unknown[]>('board:tasks')).length,
    0,
    'and the cards of the floor that is gone go with it'
  )
})

after(async () => {
  await main?.stop()
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})
