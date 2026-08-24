import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ENGINES, engineArgs, engineFor, retune } from '../src/engines.ts'
import { dropBrief } from '../src/main/god.ts'

/**
 * `RoleDef.cli` has said a floor may mix CLIs since it was written - its own
 * example is `codex`. What pinned every floor to one was two flags appended to
 * every spawn regardless: `--append-system-prompt` and `--settings` are
 * claude's, so anything else was handed arguments it did not know and refused
 * to start.
 */
test('only the CLI that understands them is handed claude’s own flags', () => {
  const claude = engineFor('claude')
  assert.deepEqual(engineArgs(claude, 'BRIEF', '/s.json'), [
    '--append-system-prompt',
    'BRIEF',
    '--settings',
    '/s.json'
  ])

  for (const cli of ['codex', 'something-nobody-wired-up']) {
    assert.deepEqual(engineArgs(engineFor(cli), 'BRIEF', '/s.json'), [], `${cli} gets none`)
  }
})

test('the engine is the command, not the flags after it or the path in front', () => {
  assert.equal(engineFor('claude --model sonnet').cmd, 'claude')
  assert.equal(engineFor('  codex  ').cmd, 'codex')
  // Where it was installed is not what it is called. Matching the whole string
  // reported an installed CLI as one Bullpen had never heard of.
  assert.equal(engineFor('/opt/homebrew/bin/codex').cmd, 'codex')
  assert.equal(engineFor('/usr/local/bin/claude --model opus').cmd, 'claude')

  // Nothing said means the default, which is the one that is wired up.
  assert.equal(engineFor(undefined).cmd, 'claude')
  assert.equal(engineFor('').cmd, 'claude')
})

test('an engine nobody wired up says so rather than looking supervised', () => {
  const unknown = engineFor('mystery-cli')
  assert.equal(unknown.supervised, false)
  assert.ok(unknown.caveat.trim(), 'and says what is given up')
  assert.ok(unknown.briefFile.trim(), 'and still has somewhere to put the brief')

  // Exactly one engine is supervised today, and it is claude. If a second one
  // ever is, that is a deliberate change and this line is where it is noticed.
  assert.deepEqual(
    ENGINES.filter((e) => e.supervised).map((e) => e.cmd),
    ['claude']
  )
  for (const e of ENGINES) {
    assert.ok(e.briefFile.endsWith('.md'), `${e.cmd} reads a markdown file`)
    assert.equal(e.supervised, !e.caveat, `${e.cmd}: a caveat is what being unsupervised costs`)
    assert.ok(e.modelFlag.startsWith('-'), `${e.cmd} names a model with a flag`)
  }
})

/**
 * A list of Claude models under a `codex` agent is a list of things that agent
 * cannot run. It was one list for everything, so picking `opus` on a codex
 * agent wrote an argument that only ever produced an error at startup.
 */
test('the model list belongs to the engine, and an empty one is not a guess', () => {
  const claude = engineFor('claude')
  assert.ok(claude.models.some((m) => m.id === 'claude-opus-5'))
  assert.ok(engineFor('codex').models.some((m) => m.id.startsWith('gpt-')))

  // Nothing shipped rather than something invented: chips naming models a CLI
  // does not take are chips that fail at startup, which is worse than none.
  assert.deepEqual(engineFor('mystery-cli').models, [], 'no guessed list')

  // Versions only. A bare alias moves when the CLI moves, so two runs a month
  // apart on "opus" are two different models with nothing on screen saying so.
  for (const e of ENGINES) {
    for (const m of e.models) {
      assert.ok(/\d/.test(m.id), `"${m.id}" names no version`)
    }
  }

  // No model of one engine is offered by another.
  const claudeIds = new Set(claude.models.map((m) => m.id))
  for (const e of ENGINES) {
    if (e.cmd === 'claude') continue
    for (const m of e.models) assert.ok(!claudeIds.has(m.id), `${e.cmd} offers ${m.id}`)
  }
})

/**
 * A briefing nobody can see is a briefing nobody can fix. The flag is what
 * claude acts on; the file is what a person opens - and for every other CLI it
 * is the whole of the brief.
 */
test('the brief lands as a file in the workspace, and never over an edit', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullpen-engines-'))
  try {
    const written = dropBrief(root, 'AGENTS.md', 'Morgan', 'You build what the BA designed.')
    assert.equal(written, join(root, 'AGENTS.md'))
    const text = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    assert.match(text, /^# Morgan$/m)
    assert.match(text, /You build what the BA designed\./)

    // Second time round it is the operator's file. Rewriting it on every
    // restart would be Bullpen silently undoing an edit made on purpose.
    writeFileSync(join(root, 'AGENTS.md'), 'my own words')
    assert.equal(dropBrief(root, 'AGENTS.md', 'Morgan', 'the generated one'), null)
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), 'my own words')

    // Two CLIs in one workspace do not collide: different files.
    dropBrief(root, 'CLAUDE.md', 'Avery', 'You review it.')
    assert.ok(existsSync(join(root, 'CLAUDE.md')))
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), 'my own words')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * A model belongs to the engine that has it. Switching the engine used to leave
 * `--model claude-opus-5` on a codex agent - an argument that only ever
 * produces an error at startup, sitting under a chip row offering nothing like
 * it and a chip claiming nothing is selected.
 */
test('changing engine drops a model the new one does not have, and keeps the rest', () => {
  const claude = engineFor('claude')
  const codex = engineFor('codex')

  assert.equal(retune('--model claude-opus-5', claude, codex), '')
  assert.equal(retune('--model gpt-5.6-sol', codex, claude), '')

  // Everything else on the line is the operator's and is not touched.
  assert.equal(retune('--model claude-opus-5 --verbose', claude, codex), '--verbose')
  assert.equal(retune('--verbose --foo bar', claude, codex), '--verbose --foo bar')

  // Nothing to drop is not a rewrite.
  assert.equal(retune('', claude, codex), '')

  // A model the new engine does have survives the move. Contrived - no id is on
  // both lists today - but the rule is "does this engine have it", not "is this
  // a different engine", and the two only look the same until one does.
  const twin = { ...codex, models: claude.models }
  assert.equal(retune('--model claude-opus-5 --verbose', claude, twin), '--model claude-opus-5 --verbose')

  // A model nobody lists is a model somebody typed on purpose. It goes, because
  // the new engine cannot be told it takes it - but only the flag goes.
  assert.equal(retune('--model something-typed --verbose', claude, codex), '--verbose')
})
