/**
 * The wiring, channel by channel.
 *
 * Every module here has a unit test and most of the channels had none, which is
 * a distinction that only holds until something goes wrong between them - and
 * both of the last two bugs found did: a payload field dropped on one of two
 * hire paths, and a floor applied through the second of two doors coming up
 * with cards keyed to columns it no longer had. The logic was right in both
 * cases. What was wrong was the join.
 *
 * So this is the join: main booted once, and every channel reachable outside
 * Electron invoked the way the renderer invokes it. Not a substitute for the
 * unit tests - it asserts that the call arrives, acts, and answers, and leaves
 * what the answer should be to the file that owns the logic.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { bootMain, keychain, type Main } from './main-harness.ts'
import { PRESETS as SHIPPED } from '../src/main/presets.ts'
import { SHELL_ID } from '../src/names.ts'
import { columnFor, toMarkdown } from '../src/main/workflow.ts'

const home = mkdtempSync(join(tmpdir(), 'bullpen-ipc-'))
const work = mkdtempSync(join(tmpdir(), 'bullpen-ipc-work-'))
const FLOOR = SHIPPED[0]
let main: Main

const spawn = (id: string, role?: string): Promise<unknown> =>
  main.invoke('agent:spawn', {
    id,
    cwd: work,
    cmd: 'claude',
    cols: 80,
    rows: 24,
    ...(role ? { role } : {})
  })

test('main comes up on the shipped floor', async () => {
  main = await bootMain(home)
  const set = await main.invoke<{ error?: string }>('workflow:set', toMarkdown(FLOOR))
  assert.equal(set.error, undefined, `the shipped floor must apply: ${set.error}`)
})

test('the workflow channels read, check and write a floor without running one', async () => {
  const blank = await main.invoke<string>('workflow:blank')
  assert.match(blank, /^# /, 'a blank floor is a markdown file')

  const got = await main.invoke<{ workflow: { name: string }; markdown: string; problems: string[] }>(
    'workflow:get'
  )
  assert.equal(got.workflow.name, FLOOR.name)
  assert.deepEqual(got.problems, [], 'the running floor lints clean')

  const clean = await main.invoke<{ problems: string[]; preview: unknown }>(
    'workflow:lint',
    got.markdown
  )
  assert.deepEqual(clean.problems, [], 'the running floor checks clean')
  assert.ok(clean.preview, 'and comes back parsed, for the dialog to draw')
  const broken = await main.invoke<{ problems: string[]; preview: unknown }>(
    'workflow:lint',
    '# x\n\nnothing at all'
  )
  assert.ok(broken.problems.length > 0, 'a floor that is not one comes back with why')
  assert.equal(broken.preview, null, 'and nothing to draw')

  const preview = await main.invoke<{ markdown: string; problems: string[] }>('workflow:preview', {
    description: 'a different line'
  })
  assert.match(preview.markdown, /a different line/, 'preview shows the patch without applying it')
  assert.equal(
    (await main.invoke<{ workflow: { description: string } }>('workflow:get')).workflow.description,
    FLOOR.description,
    'and the floor that runs is untouched'
  )

  const rules = await main.invoke<{ rules: unknown[] }>('workflow:rules', {})
  assert.ok(rules, 'the card rules a floor implies are readable')

  const dry = await main.invoke<{ steps: unknown[]; ends: string } | { error: string }>(
    'workflow:dryRun',
    got.markdown,
    'count the exports'
  )
  assert.ok('steps' in dry && dry.steps.length > 0, 'a task walks the floor, spending nothing')
  assert.ok('ends' in dry && dry.ends.length > 0, 'and the walk says where it stops')

  const saved = await main.invoke<{ error?: string }>('workflow:save', blank.replace(/«[^»]*»/g, 'x'))
  assert.equal((saved as { error?: string }).error, undefined, `a floor saves: ${saved.error}`)
  const list = await main.invoke<{ name: string }[]>('workflow:list')
  assert.ok(list.length > 0, 'and comes back in the list')
  await main.invoke('workflow:delete', list[list.length - 1].name)
})

test('the board channels carry cards, schedules and context rules', async () => {
  await spawn('quinn', 'marketing_sale')
  const start = columnFor(FLOOR, 'start')
  const done = columnFor(FLOOR, 'done')

  const card = await main.invoke<{ id: string; status: string }>(
    'board:addTask',
    'quinn',
    'count the campaign'
  )
  assert.equal(card.status, start)
  await main.invoke('board:setTaskStatus', card.id, done)
  const tasks = await main.invoke<{ id: string; status: string }[]>('board:tasks', 'quinn')
  assert.equal(tasks.find((t) => t.id === card.id)?.status, done)
  await main.invoke('board:removeTask', card.id)
  assert.equal(
    (await main.invoke<unknown[]>('board:tasks', 'quinn')).length,
    0,
    'a card removed is gone'
  )

  await main.invoke('board:addTrigger', 'quinn', 'say where you are', 15)
  const triggers = await main.invoke<{ id: string; enabled: boolean }[]>('board:triggers', 'quinn')
  assert.equal(triggers.length, 1)
  await main.invoke('board:toggleTrigger', triggers[0].id)
  assert.equal(
    (await main.invoke<{ enabled: boolean }[]>('board:triggers', 'quinn'))[0].enabled,
    false,
    'a schedule switches off without being deleted'
  )
  await main.invoke('board:removeTrigger', triggers[0].id)
  assert.equal((await main.invoke<unknown[]>('board:triggers', 'quinn')).length, 0)

  // Keyed by agent, not by a rule id: there is one context rule per agent, so
  // the agent is the name of it. `toggleRule(rules[0].id)` is a no-op, which is
  // the sort of thing only a call through the real channel catches.
  await main.invoke('board:setRule', 'quinn', 80, 'compact')
  const rules = await main.invoke<{ atPct: number; enabled: boolean }[]>('board:rules', 'quinn')
  assert.equal(rules[0].atPct, 80)
  await main.invoke('board:toggleRule', 'quinn')
  assert.equal((await main.invoke<{ enabled: boolean }[]>('board:rules', 'quinn'))[0].enabled, false)
  await main.invoke('board:removeRule', 'quinn')
  assert.equal((await main.invoke<unknown[]>('board:rules', 'quinn')).length, 0)
})

test('the window, theme and layout channels answer', async () => {
  assert.equal(await main.invoke('ui:setMode', 'dark'), true)
  assert.equal(await main.invoke('ui:setMode', 'chartreuse'), false, 'and only the two it knows')
  const prefs = await main.invoke<{ fontSize: number; floor: string }>('ui:prefs')
  assert.equal(typeof prefs.fontSize, 'number')
  assert.ok(prefs.floor.length > 0, 'the panel gets something to draw with')

  await main.invoke('ui:setNotify', false)
  assert.equal(await main.invoke('ui:notify'), false)
  await main.invoke('ui:setNotify', true)
  assert.equal(await main.invoke('ui:notify'), true)

  const layout = { panels: ['floor', 'code'] }
  await main.invoke('layout:set', layout)
  assert.deepEqual(await main.invoke('layout:get'), layout, 'the layout is remembered')

  // Mocked away in a test runner, so what is asserted is that they are wired at
  // all: an unregistered channel throws rather than resolving.
  await main.invoke('window:minimize')
  await main.invoke('window:toggleFullscreen')
  await main.invoke('ui:open', 'https://example.com')
  assert.equal(
    await main.invoke('ui:unsaved', 'the floor you were drawing'),
    'save',
    'the default button is the one that does not lose work'
  )
  assert.deepEqual(await main.invoke('dialog:pickDir'), null, 'a cancelled picker is not a path')
})

test('the floor, roster and log channels answer', async () => {
  const cwd = await main.invoke<string>('god:cwd')
  assert.ok(cwd.length > 0, 'the boss works somewhere')
  const setup = await main.invoke<{ chosen: boolean }>('god:setup')
  assert.equal(typeof setup.chosen, 'boolean')

  await main.invoke('floor:publish', [
    { id: 'quinn', name: 'Quinn', project: 'p', cwd: work, status: 'running', activity: 'idle', pid: 1 }
  ])

  assert.deepEqual(await main.invoke('report:list'), [], 'nobody has reported yet')
  assert.equal(await main.invoke('dispatch:last'), null, 'and nothing has been dispatched')
  assert.ok(
    (await main.invoke<unknown[]>('activity:list', 10)).length > 0,
    'the log has the boot in it'
  )

  const hits = await main.invoke<unknown[]>('search:text', 'campaign')
  assert.ok(Array.isArray(hits), 'search answers with rows, even none')
})

test('the agent channels spawn, steer, restart and forget', async () => {
  const state = await main.invoke<{ id: string; pid: number }>('agent:spawn', {
    id: 'avery',
    cwd: work,
    cmd: 'claude',
    cols: 80,
    rows: 24,
    role: 'data_analyst'
  })
  assert.equal(state.id, 'avery')
  assert.ok(state.pid > 0, 'a spawn answers with a live process')

  assert.equal(await main.invoke('agent:setRole', 'avery', 'marketing_sale'), true)
  assert.equal(
    await main.invoke('agent:setRole', 'avery', 'no-such-role'),
    false,
    'and refuses a role this floor does not have'
  )
  await main.invoke('agent:setRole', 'avery', 'data_analyst')

  const before = main.pty('avery').written.join('').length
  assert.equal(await main.invoke('agent:submit', 'avery', 'where are you'), true)
  assert.ok(
    main.pty('avery').written.join('').slice(before).includes('where are you'),
    'a prompt reaches the terminal'
  )

  // A steer is held for the next tool call rather than typed: mid-turn text is
  // text in the middle of whatever it was doing.
  await main.invoke('agent:steer', 'avery', 'use the staging data')
  const steers = await main.invoke<string[]>('agent:steers', 'avery')
  assert.ok(steers.some((n) => n.includes('staging')), 'and waits where the hook will find it')

  assert.equal(await main.invoke('agent:ctx', 'avery'), null, 'no turn yet, so no reading')
  assert.equal(await main.invoke('agent:cost', 'avery'), null)

  const again = await main.invoke<{ id: string; pid: number }>('agent:restart', {
    id: 'avery',
    cwd: work,
    cmd: 'claude',
    cols: 80,
    rows: 24,
    role: 'data_analyst'
  })
  assert.equal(again.id, 'avery')
  assert.notEqual(again.pid, state.pid, 'restart is a new process, not the old one nudged')

  await main.invoke('board:addTask', 'avery', 'something to lose')
  await main.invoke('agent:kill', 'avery')
  assert.equal(main.pty('avery').killed, true)
  await main.invoke('agent:forget', 'avery')
  assert.equal(
    (await main.invoke<unknown[]>('board:tasks', 'avery')).length,
    0,
    'off the roster takes the cards with it'
  )
})

test('the code channels reach inside one agent workspace and nowhere else', async () => {
  mkdirSync(join(work, 'src'), { recursive: true })
  writeFileSync(join(work, 'src', 'hello.ts'), 'export const hi = 1\n')

  const listed = await main.invoke<{ entries?: { name: string }[]; error?: string }>(
    'code:list',
    work,
    ''
  )
  assert.ok(listed.entries?.some((e) => e.name === 'src'), `the tree reads: ${listed.error}`)

  const read = await main.invoke<{ text?: string; error?: string }>('code:read', work, 'src/hello.ts')
  assert.ok(read.text?.includes('hi = 1'), `and a file reads: ${read.error}`)

  const wrote = await main.invoke<{ ok?: boolean; error?: string }>(
    'code:write',
    work,
    'src/hello.ts',
    'export const hi = 2\n'
  )
  assert.equal(wrote.error, undefined, `a write inside the sandbox lands: ${wrote.error}`)
  assert.equal(
    (await main.invoke<{ text?: string }>('code:read', work, 'src/hello.ts')).text,
    'export const hi = 2\n'
  )

  const found = await main.invoke<{ hits: { path: string }[] }>('code:search', work, 'hi', false, false)
  assert.ok(found.hits.length > 0, 'and search finds it')

  // The whole point of the panel having a root at all.
  for (const channel of ['code:list', 'code:read'] as const) {
    const escaped = await main.invoke<{ error?: string }>(channel, work, '../../../etc/passwd')
    assert.ok(escaped.error, `${channel} refuses a path out of the workspace`)
  }
  assert.ok(
    (await main.invoke<{ error?: string }>('code:write', work, '../escaped.ts', 'x')).error,
    'and so does a write'
  )
})

test('the git channels read a real repository', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'bullpen-ipc-git-'))
  const run = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  }
  run('init', '-q')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'test')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  run('add', 'a.txt')
  run('commit', '-qm', 'first')
  writeFileSync(join(repo, 'a.txt'), 'two\n')

  const changed = await main.invoke<{ repo: boolean; changes: { path: string }[] }>('git:changes', repo)
  assert.equal(changed.repo, true)
  assert.ok(changed.changes.some((c) => c.path === 'a.txt'), 'a modified file shows up')

  const diff = await main.invoke<{ text: string; error?: string }>('git:diff', repo, 'a.txt')
  assert.equal(diff.error, undefined, `and its diff reads: ${diff.error}`)
  assert.ok(diff.text.includes('+two'), 'with the new line in it')

  const stats = await main.invoke<Record<string, string>>('git:stats', repo)
  assert.ok(stats['a.txt'], 'the summary counts it')

  assert.deepEqual(await main.invoke('git:discard', repo, 'a.txt'), { ok: true })
  assert.equal(
    (await main.invoke<{ changes: unknown[] }>('git:changes', repo)).changes.length,
    0,
    'and throwing the change away actually throws it away'
  )

  // Not a repository is an answer, not a throw - the panel opens on whatever
  // directory the agent was started in.
  assert.equal((await main.invoke<{ repo: boolean }>('git:changes', work)).repo, false)
  rmSync(repo, { recursive: true, force: true })
})

test('the ask-me channels take a question and give it an answer', async () => {
  const out = join(home, 'hive', 'agents', 'michael', 'outbox')
  mkdirSync(out, { recursive: true })
  const ask = (subject: string): void => {
    writeFileSync(
      join(out, `${subject.replace(/\W+/g, '-')}.json`),
      JSON.stringify({ from: 'michael', to: 'you', subject, body: 'which one?' })
    )
  }
  ask('which period')
  await new Promise((r) => setTimeout(r, 1500))

  const pending = await main.invoke<{ id: string; subject: string }[]>('ask:list')
  const q = pending.find((a) => a.subject === 'which period')
  assert.ok(q, `a message to "you" surfaces as a question: ${JSON.stringify(pending)}`)

  assert.equal(await main.invoke('ask:answer', q.id, 'q2'), true)
  assert.equal(await main.invoke('ask:answer', q.id, 'again'), false, 'and only once')
  assert.ok(
    !(await main.invoke<{ id: string }[]>('ask:list')).some((a) => a.id === q.id),
    'answered leaves the queue'
  )
  assert.ok(
    (await main.invoke<{ id: string; answer?: string }[]>('ask:history')).some(
      (a) => a.id === q.id && a.answer === 'q2'
    ),
    'and stays in the history with what was said back'
  )

  ask('and the region')
  await new Promise((r) => setTimeout(r, 1500))
  const second = (await main.invoke<{ id: string; subject: string }[]>('ask:list')).find(
    (a) => a.subject === 'and the region'
  )
  assert.ok(second, 'the second question arrives')
  assert.equal(await main.invoke('ask:dismiss', second.id), true)
  assert.ok(
    !(await main.invoke<{ id: string }[]>('ask:list')).some((a) => a.id === second.id),
    'waved away also leaves the queue'
  )
  assert.equal(await main.invoke('ask:dismiss', 'no-such-question'), false)
})

test('the sync and webhook channels answer without a network', async () => {
  const status = await main.invoke<{
    hasToken: boolean
    keyring: boolean
    machine: string
    user: string
  }>('sync:status')
  assert.equal(status.hasToken, false, 'nothing signed in under a test runner')
  assert.equal(typeof status.keyring, 'boolean')

  // The pane is drawn from the token's file, never from the token. Decrypting
  // it means the keychain, and on macOS the keychain means a login-password
  // prompt every time the app's signature has changed - which, ad-hoc signed,
  // is every update. Opening settings used to raise one.
  await main.invoke('sync:set', { token: 'ghp_notarealtoken' })
  const before = keychain.decrypts
  const signed = await main.invoke<{ hasToken: boolean; keyring: boolean }>('sync:status')
  assert.equal(signed.hasToken, true, 'the file is there, and that is the whole question')
  assert.equal(keychain.decrypts, before, 'and it was answered without opening the keychain')
  assert.equal(
    signed.keyring,
    false,
    'no keyring under a test runner, so the token on disk is plain - which is what the pane warns about'
  )
  await main.invoke('sync:set', { token: '' })

  await main.invoke('sync:set', { machine: 'the laptop' })
  assert.equal(
    (await main.invoke<{ machine: string }>('sync:status')).machine,
    'the laptop',
    'what is set comes back'
  )

  // Nothing to sync with, so each of these must say so rather than throw or
  // reach for the network. `sync:signIn` is not in here: this build ships a
  // client id, so pressing it really does ask github.com for a device code -
  // which is a request to somebody else's server, not a test.
  assert.equal(status.user, '', 'nobody signed in, so no name to show')
  for (const channel of ['sync:now', 'sync:wait', 'sync:whoami'] as const) {
    assert.ok((await main.invoke<{ error?: string }>(channel)).error, `${channel} says why not`)
  }

  const hook = await main.invoke<{ enabled: boolean; port: number; token: string }>('webhook:get')
  assert.equal(typeof hook.enabled, 'boolean')
  assert.ok(hook.token, 'a token exists before anybody asks for one')
  await main.invoke('webhook:rotate')
  assert.notEqual(
    (await main.invoke<{ token: string }>('webhook:get')).token,
    hook.token,
    'a rotated token is a different token'
  )
  // Off, so the self-test must say that rather than post to a dead port.
  assert.equal((await main.invoke<{ ok: boolean }>('webhook:test')).ok, false)
})

test('the memory, terminal and approval channels answer', async () => {
  await spawn('sloane', 'data_analyst')
  const empty = mkdtempSync(join(tmpdir(), 'bullpen-ipc-memory-'))

  assert.equal(await main.invoke('agent:memory', empty), null, 'no brief on disk there')
  writeFileSync(join(empty, 'CLAUDE.md'), '# who you are\n')
  assert.deepEqual(await main.invoke('agent:memory', empty), {
    name: 'CLAUDE.md',
    text: '# who you are\n'
  })
  rmSync(empty, { recursive: true, force: true })

  assert.equal(typeof (await main.invoke<string>('pty:backlog', 'sloane')), 'string')
  assert.equal(await main.invoke('pty:backlog', 'nobody'), '', 'and an id nobody holds is empty')

  // Nothing is waiting on a decision, so this must be a no-op rather than a
  // throw: the panel can be clicked after the agent it belonged to is gone.
  assert.equal(await main.invoke('approvals:decide', 'no-such-call', 'allow'), undefined)

  const stopped = await main.invoke<string[]>('fixed:stop')
  assert.ok(Array.isArray(stopped), 'stopping the standing agents answers with who went')
  assert.deepEqual(await main.invoke('fixed:stop'), [], 'and nothing is left to stop twice')
})

/**
 * These three shell out to the `claude` CLI, which a test must never do - so
 * only the paths that answer before it is reached. That is not a formality:
 * every one of them is a button somebody presses with the field still empty.
 */
test('the model-backed channels refuse before they spawn anything', async () => {
  assert.ok((await main.invoke<{ error?: string }>('workflow:generate', '   ')).error)
  assert.ok((await main.invoke<{ error?: string }>('workflow:redraft', {})).error)

  const floor = (await main.invoke<{ workflow: object }>('workflow:get')).workflow
  assert.ok((await main.invoke<{ error?: string }>('role:brief', floor, 'boss', '  ')).error)
  assert.ok(
    (await main.invoke<{ error?: string }>('role:brief', floor, 'no-such-role', 'do things')).error,
    'and a role this floor does not have'
  )
})

test('a patch applies the floor through the same door a whole file does', async () => {
  const patched = await main.invoke<{
    workflow: { description: string; roles: Record<string, { fixed?: { id: string } }> }
    markdown: string
    problems: string[]
  }>('workflow:patch', { description: 'the same floor, said differently' })

  assert.equal(patched.workflow.description, 'the same floor, said differently')
  assert.deepEqual(patched.problems, [], 'and it still lints')
  assert.equal(
    patched.workflow.roles.boss.fixed?.id,
    'michael',
    'the desk is seated on this door too'
  )
  assert.match(patched.markdown, /the same floor, said differently/)

  // Cards are keyed to the columns of the floor they were opened on, so
  // applying one clears them - through this door as much as the other.
  await main.invoke('board:addTask', 'michael', 'opened before the patch')
  await main.invoke('workflow:patch', { description: 'said differently again' })
  assert.deepEqual(await main.invoke('board:tasks'), [])
})

test('a test notification says what happened', async () => {
  // No notification server under a test runner, so the one path that must be
  // right is the one that says so instead of throwing.
  const res = await main.invoke<{ ok?: true; error?: string }>('ui:notifyTest')
  assert.equal(res.ok, undefined)
  assert.match(res.error ?? '', /notification/i)
})

test('the window closes', async () => {
  assert.equal(await main.invoke('window:close'), undefined)
})

after(async () => {
  await main?.stop()
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

test('the shell tab spawns one shell, and pty writes on its id reach it', async () => {
  const state = await main.invoke<{ id: string; pid: number }>('shell:open', 100, 30)
  assert.equal(state.id, SHELL_ID)
  const shell = main.pty(SHELL_ID)
  // Not the CLI. The whole point of the tab is a shell, and `resolveCli` passes
  // an explicit cmd through untouched - a regression there would spawn claude.
  assert.notEqual(shell.cmd, 'claude')

  // Idempotent: the renderer calls this on every visit to the tab, and a second
  // process per visit is exactly what `spawn` refuses with a thrown duplicate.
  const again = await main.invoke<{ pid: number }>('shell:open', 100, 30)
  assert.equal(again.pid, state.pid, 'a second open must not spawn a second shell')

  // The routing: SHELL_ID goes to the shell manager, an agent id does not.
  main.send('pty:write', SHELL_ID, 'ls\r')
  assert.deepEqual(shell.written, ['ls\r'])

  // And its output rides the same channel the agents use, so the renderer needs
  // nothing new to paint it.
  shell.say('bullpen\n')
  assert.deepEqual(main.last('pty:data'), [SHELL_ID, 'bullpen\n'])
})
