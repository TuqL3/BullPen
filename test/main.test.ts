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
import { bootMain, type Main } from './main-harness.ts'

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

after(async () => {
  await main?.stop()
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})
