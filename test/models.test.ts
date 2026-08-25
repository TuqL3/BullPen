import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CLAUDE_MODELS, labelForModel, modelOf, withModel } from '../src/models.ts'
import { bannerModel, configuredModel } from '../src/main/climodel.ts'

/**
 * There is no model field on an agent - the CLI takes `--model` and Bullpen
 * passes the extra arguments through verbatim, so the arguments are the model.
 * These two functions are the whole of that, which makes them the whole of what
 * can go wrong with it.
 */
test('the model is read out of the arguments, in either spelling', () => {
  assert.equal(modelOf('--model opus'), 'opus')
  assert.equal(modelOf('--model=claude-opus-5'), 'claude-opus-5')
  assert.equal(modelOf('--verbose --model claude-sonnet-5 --foo bar'), 'claude-sonnet-5')
  assert.equal(modelOf('--model "claude-opus-5[1m]"'), 'claude-opus-5[1m]')
  assert.equal(modelOf(''), null)
  assert.equal(modelOf('--verbose'), null)

  // A flag whose name merely starts the same way is not this flag.
  assert.equal(modelOf('--model-name opus'), null)

  // A model released after this file was written still comes back. Reporting
  // "none" for an argument that is plainly there would be Bullpen claiming it
  // cannot see what it can see.
  assert.equal(modelOf('--model claude-something-6'), 'claude-something-6')
})

test('setting a model rewrites the one flag and leaves the rest alone', () => {
  assert.equal(withModel('', 'opus'), '--model opus')
  assert.equal(withModel('--verbose', 'opus'), '--model opus --verbose')

  // Rewritten in place, not appended. Picking three in a row used to leave
  // three `--model` flags on the line: the CLI takes the last, so what ran was
  // right and what was written was nonsense.
  const twice = withModel(withModel('--model opus', 'claude-sonnet-5'), 'claude-haiku-4-5')
  assert.equal(twice, '--model claude-haiku-4-5')
  assert.equal((twice.match(/--model/g) ?? []).length, 1)

  // Both spellings are removed, and what was around them survives.
  assert.equal(withModel('--verbose --model=opus --foo bar', 'claude-opus-5'),
    '--model claude-opus-5 --verbose --foo bar')

  // And it comes off again.
  assert.equal(withModel('--model opus --verbose', null), '--verbose')
  assert.equal(withModel('--model opus', null), '')

  // Whatever is set is what reads back - including the bracketed 1M id, which
  // is the one that looks least like a bare word.
  for (const m of CLAUDE_MODELS) assert.equal(modelOf(withModel('--verbose', m.id)), m.id)
})

test('every model on the list is listed once and says what it is', () => {
  const ids = CLAUDE_MODELS.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length, 'no model appears twice')
  for (const m of CLAUDE_MODELS) {
    assert.ok(m.label.trim(), `${m.id} has no label`)
    assert.ok(!/\s/.test(m.id), `"${m.id}" would not survive being split on spaces`)
  }

  // A handful shown without asking, the rest behind `more`. Nine chips is not
  // a choice, it is a table - and the answer nearly every time is one of three
  // words. If this grows, the dialog is back to being a table.
  const common = CLAUDE_MODELS.filter((m) => m.common)
  assert.ok(common.length > 0 && common.length <= 4, `${common.length} shown up front`)
  assert.ok(CLAUDE_MODELS.length > common.length, 'and older versions to fold away')
})

/**
 * The flag is the engine's, not this file's. One CLI spelling it differently is
 * a CLI whose model could be read but never set - `withModel` would append its
 * own spelling beside the one already there and the CLI would take neither.
 */
test('a CLI that spells the flag differently is read and written in its own spelling', () => {
  assert.equal(modelOf('-m gpt-5', '-m'), 'gpt-5')
  assert.equal(modelOf('--model opus', '-m'), null, 'and not in somebody else\'s')
  assert.equal(withModel('--verbose', 'gpt-5', '-m'), '-m gpt-5 --verbose')
  assert.equal(withModel('-m gpt-5 --verbose', 'o3', '-m'), '-m o3 --verbose')
  assert.equal((withModel('-m a', 'b', '-m').match(/-m/g) ?? []).length, 1)
})

/**
 * What the CLI reports is the build it ran, not the name anybody picked.
 *
 * An agent started on no flag at all still says which model answered, and that
 * string carries a date the shipped ids do not. Matched on the longest id it
 * starts with, so `claude-opus-5-20260114` is Opus 5 rather than nothing - and
 * an id nothing here knows is shown as itself, because a wrong name is worse
 * than a raw one when it is what somebody is paying for.
 */
test('a dated model id reads back as the name it was shipped under', () => {
  assert.equal(labelForModel('claude-opus-5', CLAUDE_MODELS), 'Opus 5')
  assert.equal(labelForModel('claude-opus-5-20260114', CLAUDE_MODELS), 'Opus 5')
  assert.equal(labelForModel('claude-opus-5[1m]', CLAUDE_MODELS), 'Opus 5 · 1M', 'the longer id wins')
  assert.equal(labelForModel('claude-sonnet-4-6-20260101', CLAUDE_MODELS), 'Sonnet 4.6')
  assert.equal(labelForModel('claude-something-else', CLAUDE_MODELS), 'claude-something-else')
})

/**
 * What the CLI would start on when Bullpen passes no flag.
 *
 * Read out of the same files the CLI reads, in the same order, because the
 * alternative was a menu that said "its default" and nothing else until the
 * agent had taken a turn. Nobody having written one is an answer too: null,
 * not the newest model on the list.
 */
test("the CLI's own settings answer for an agent started with no flag", () => {
  const home = mkdtempSync(join(tmpdir(), 'bullpen-cfg-home-'))
  const work = mkdtempSync(join(tmpdir(), 'bullpen-cfg-work-'))
  const write = (dir: string, body: object): void => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(body))
  }
  const env = {} as NodeJS.ProcessEnv

  assert.equal(configuredModel('claude', work, home, env), null, 'nobody wrote one')

  write(home, { model: 'claude-opus-5' })
  assert.equal(configuredModel('claude', work, home, env), 'claude-opus-5')

  write(work, { env: { ANTHROPIC_MODEL: 'claude-haiku-4-5' } })
  assert.equal(
    configuredModel('claude', work, home, env),
    'claude-haiku-4-5',
    "the project's own settings beat the home directory's"
  )

  writeFileSync(
    join(work, '.claude', 'settings.local.json'),
    JSON.stringify({ model: 'claude-sonnet-5' })
  )
  assert.equal(configuredModel('claude', work, home, env), 'claude-sonnet-5', 'and local beats both')

  assert.equal(
    configuredModel('claude', work, home, { ANTHROPIC_MODEL: 'claude-fable-5' }),
    'claude-fable-5',
    'the environment is what the process actually starts with'
  )

  // Another CLI keeps its default somewhere else, in another format: a model
  // read out of the wrong file is worse than no model at all.
  assert.equal(configuredModel('codex', work, home, env), null)
  assert.equal(configuredModel('/opt/homebrew/bin/claude', work, home, env), 'claude-sonnet-5')

  writeFileSync(join(work, '.claude', 'settings.local.json'), '{ half a file')
  assert.equal(configuredModel('claude', work, home, env), 'claude-haiku-4-5', 'unreadable is not a model')

  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

/**
 * The one thing here read off a terminal, and the reason it is safe to.
 *
 * An agent brought up a minute ago has taken no turn and may have no model
 * written down anywhere, so the only thing that knows which one is answering is
 * the process - and it says so once, in the box it prints at startup. The read
 * is anchored to that box and to names Bullpen ships: an agent talking about
 * models in its own output cannot reach it, and a CLI that changes its banner
 * gets null rather than a wrong answer.
 */
test('the startup banner answers for an agent that has taken no turn', () => {
  const banner =
    '\u001b[1mClaude Code\u001b[0m v2.1.241\n Opus 5 (1M context) with xhigh effort · Claude Max\n ~/Projects\n'
  assert.equal(
    bannerModel(banner, CLAUDE_MODELS),
    'claude-opus-5[1m]',
    'the CLI writes "Opus 5 (1M context)" where the menu writes "Opus 5 · 1M" - same model, ' +
      'different context window, and the shorter match ticked the wrong row'
  )

  const pinned = 'Claude Code v2.1.241\n Opus 5 · 1M with xhigh effort\n'
  assert.equal(bannerModel(pinned, CLAUDE_MODELS), 'claude-opus-5[1m]', 'the longer name wins')

  // The real thing, captured off a pty. The box is drawn cell by cell, so what
  // sits between the name and the version is a cursor move rather than a space:
  // strip the escapes and it reads `Claude Codev2.1.245`, with nothing in the
  // middle. A `\s+` here matched none of it, which is why every agent's menu
  // said "the CLI's default" and ticked nothing.
  const drawn =
    ' \u001b[48;2;0;0;0m▛███▛█\u001b[12G\u001b[39m\u001b[49m\u001b[1mClaude Code' +
    '\u001b[24G\u001b[22m\u001b[38;2;153;153;153mv2.1.245\n' +
    '\u001b[1B\u001b[38;2;215;119;87m▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀\u001b[12G' +
    '\u001b[38;2;153;153;153mOpus 5 (1M context) with xhigh effort · Claude Max\n'
  assert.equal(bannerModel(drawn, CLAUDE_MODELS), 'claude-opus-5[1m]', 'no space, still the box')

  assert.equal(bannerModel('Claude Code v2.1.241\n Sonnet 5\n', CLAUDE_MODELS), 'claude-sonnet-5')

  // Not a banner: an agent that merely said the words, and a CLI whose first
  // screen this does not know. Both are null, which is what the menu showed
  // before any of this and is the honest answer.
  assert.equal(bannerModel('I would run this on Sonnet 5 if I were you', CLAUDE_MODELS), null)
  assert.equal(bannerModel('codex v1.2\n gpt-5.6-sol\n', CLAUDE_MODELS), null)
  assert.equal(
    bannerModel('Claude Code v2.1.241\n' + 'x'.repeat(400) + 'Haiku 4.5', CLAUDE_MODELS),
    null,
    'and a name far below the box is not the box'
  )
})
