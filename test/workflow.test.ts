import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PRESETS, DEFAULT_WORKFLOW, STARTER } from '../src/main/presets.ts'
import {
  can,
  coreRoles,
  fixedId,
  lint,
  parseWorkflow,
  refuseMail,
  renderBrief,
  rolesWith,
  roleOfFixedId,
  parseMarkdown,
  toMarkdown,
  listWorkflows,
  saveWorkflow,
  deleteWorkflow,
  workflowFile,
  type Workflow
} from '../src/main/workflow.ts'

/**
 * The presets are the schema's proof. `solo` has no analyst and no tester, and
 * `review` checks by reading instead of running - if either needs a special
 * case in the code, the workflow is not really data.
 */
test('every shipped preset lints clean', () => {
  for (const w of PRESETS) {
    assert.deepEqual(lint(w), [], `preset "${w.name}" must not ship with problems`)
  }
})

test('the default is the chain Bullpen has always run', () => {
  assert.equal(DEFAULT_WORKFLOW.name, 'analyst-chain')
  assert.equal(fixedId(DEFAULT_WORKFLOW, 'god'), 'michael')
  assert.equal(fixedId(DEFAULT_WORKFLOW, 'ba'), 'ba')
  assert.deepEqual(coreRoles(DEFAULT_WORKFLOW).sort(), ['ba', 'god'])
  assert.equal(roleOfFixedId(DEFAULT_WORKFLOW, 'michael'), 'god')
})

test('a floor with nobody to check work is still a legal floor', () => {
  const solo = PRESETS.find((w) => w.name === 'solo') as Workflow
  assert.deepEqual(rolesWith(solo, 'checks'), [], 'solo has no tester by design')
  assert.deepEqual(rolesWith(solo, 'speaksToHuman'), ['god'])
  assert.ok(can(solo, 'god', 'assigns'), 'one agent may both report and assign')
})

test('the router refuses a shortcut and says where to send it instead', () => {
  const w = DEFAULT_WORKFLOW
  assert.equal(refuseMail(w, 'ba', 'dev'), null, 'the analyst assigns developers')
  const why = refuseMail(w, 'dev', 'you')
  assert.ok(why?.includes('the human'), 'the refusal names who was written to')
  assert.ok(why?.includes('the analyst'), 'and names where it should go instead')
  assert.ok(refuseMail(w, 'god', 'dev'), 'the boss does not assign directly on this floor')
})

test('a brief is filled from the workflow, not from hard-coded names', () => {
  const brief = renderBrief(DEFAULT_WORKFLOW, 'god', { id: 'michael', name: 'Michael' })
  assert.ok(brief.includes('"ba"'), 'the boss is told the analyst id from the workflow')
  assert.ok(brief.includes('Iris'))
  assert.ok(!brief.includes('{{'), 'no placeholder may survive into a real brief')

  const dev = renderBrief(DEFAULT_WORKFLOW, 'dev', { id: 'dave', reportTo: 'ba' })
  assert.ok(dev.includes('"dave"'))
  assert.ok(dev.includes('"ba"'))
  assert.ok(!dev.includes('{{'))
})

test('an unknown placeholder is left visible rather than blanked', () => {
  const w: Workflow = {
    ...DEFAULT_WORKFLOW,
    roles: { ...DEFAULT_WORKFLOW.roles, god: { ...DEFAULT_WORKFLOW.roles.god, brief: 'mail {{role.qa.id}} now' } }
  }
  const out = renderBrief(w, 'god', { id: 'michael' })
  assert.equal(out, 'mail {{role.qa.id}} now', 'a blank here would silently tell it to mail nobody')
})

test('lint catches the failures that would otherwise be silent', () => {
  const orphan: Workflow = {
    ...DEFAULT_WORKFLOW,
    talksTo: { ...DEFAULT_WORKFLOW.talksTo, ba: ['god', 'dev', 'hire'], dev: ['ba'] },
    roles: {
      ...DEFAULT_WORKFLOW.roles,
      tester: { ...DEFAULT_WORKFLOW.roles.tester, hireable: false }
    }
  }
  assert.ok(
    lint(orphan).some((l) => l.includes('tester')),
    'a role nothing routes to would sit idle forever with no error anywhere'
  )

  const mute: Workflow = { ...DEFAULT_WORKFLOW, talksTo: { ...DEFAULT_WORKFLOW.talksTo, god: ['ba'] } }
  assert.ok(
    lint(mute).some((l) => l.includes('human')),
    'a floor that cannot reach the human works and reports nothing'
  )

  const contradiction: Workflow = {
    ...DEFAULT_WORKFLOW,
    talksTo: { ...DEFAULT_WORKFLOW.talksTo, god: ['you'] }
  }
  assert.ok(
    lint(contradiction).some((l) => l.includes('briefed to write to')),
    "a brief naming an address the router refuses loops the agent on its own message"
  )
})

test('bad json comes back as a sentence, not a crash', () => {
  assert.ok('error' in parseWorkflow(null))
  assert.ok('error' in parseWorkflow({ name: 'x' }))
  assert.ok('error' in parseWorkflow({ name: 'x', roles: { dev: { brief: 'hi', can: ['flies'] } } }))
  assert.ok('error' in parseWorkflow({ name: 'x', roles: { dev: { can: [] } } }))

  const ok = parseWorkflow(JSON.parse(JSON.stringify(DEFAULT_WORKFLOW)))
  assert.ok('workflow' in ok)
  if ('workflow' in ok) {
    assert.deepEqual(lint(ok.workflow), [], 'a workflow must survive a round trip through JSON')
    assert.equal(ok.workflow.roles.god.fixed?.name, 'Michael')
  }
})

/**
 * Markdown is the surface a person writes a workflow on, so the two directions
 * have to agree exactly: what the editor shows, parsed back, must be the same
 * floor. Anything lost here is a setting that silently reverts on save.
 */
test('every preset survives a round trip through markdown', () => {
  for (const w of PRESETS) {
    const back = parseMarkdown(toMarkdown(w))
    assert.ok('workflow' in back, `"${w.name}" must parse back: ${JSON.stringify(back)}`)
    if ('workflow' in back) {
      assert.deepEqual(back.workflow, w, `"${w.name}" changed on the way round`)
    }
  }
})

test('a workflow can be written by hand without reading the schema', () => {
  const md = `# tiny
One boss, one builder.

## boss · the boss
- agent: chief · Chief
- can: speaksToHuman, assigns
- talks to: worker, you, hire
- dispatch
- entry

You are {{self.name}}. Hand work to a worker, and report to the human every time
one reports to you: {"from": "{{self.id}}", "to": "you", "subject": "report", "body": "..."}

## worker · a worker
- can: builds
- talks to: boss
- hireable

You are "{{self.id}}". Report to {{reportTo}} when the work is done.
`
  const parsed = parseMarkdown(md)
  assert.ok('workflow' in parsed, JSON.stringify(parsed))
  if (!('workflow' in parsed)) return
  const w = parsed.workflow
  assert.equal(w.name, 'tiny')
  assert.equal(w.dispatch, 'boss')
  assert.equal(w.entry, 'boss')
  assert.equal(w.roles.boss.fixed?.id, 'chief')
  assert.equal(w.roles.boss.fixed?.name, 'Chief')
  assert.equal(w.roles.boss.label, 'the boss')
  assert.deepEqual(w.roles.worker.can, ['builds'])
  assert.equal(w.roles.worker.hireable, true)
  assert.deepEqual(w.talksTo.boss, ['worker', 'you', 'hire'])
  assert.match(w.roles.worker.brief, /\{\{reportTo\}\}/, 'the brief is the prose, kept whole')
  assert.deepEqual(lint(w), [], 'a hand-written floor this small must be legal')
})

test('markdown mistakes come back as a sentence, not a broken floor', () => {
  assert.ok('error' in parseMarkdown('no heading at all'))
  assert.ok('error' in parseMarkdown('# empty\n\nnothing but a name'))
  assert.ok('error' in parseMarkdown('# x\n\n## a\n- can: flies\n\nbrief'))
  const noDispatch = parseMarkdown('# x\n\n## a\n- can: builds\n- talks to: you\n\nbrief')
  assert.ok('error' in noDispatch && /dispatch/.test(noDispatch.error))
})

/**
 * The library on disk. Several workflows kept side by side is the point - a
 * floor that only ever holds one is a floor you cannot switch back from.
 */
test('a saved workflow comes back exactly as it was written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-wf-'))
  try {
    assert.deepEqual(listWorkflows(dir), [], 'nothing saved yet, and no directory either')

    const md = toMarkdown(DEFAULT_WORKFLOW)
    saveWorkflow(dir, md)
    const solo = PRESETS.find((w) => w.name === 'solo') as Workflow
    saveWorkflow(dir, toMarkdown(solo))

    const list = listWorkflows(dir)
    assert.deepEqual(
      list.map((w) => w.name).sort(),
      ['analyst-chain', 'solo'],
      'both are kept - switching between them is the whole feature'
    )
    assert.equal(list.find((w) => w.name === 'analyst-chain')?.markdown, md)

    // Saving the same name again replaces it rather than making a second file.
    saveWorkflow(dir, md.replace('# analyst-chain', '# analyst-chain'))
    assert.equal(listWorkflows(dir).length, 2)

    deleteWorkflow(dir, 'solo')
    assert.deepEqual(listWorkflows(dir).map((w) => w.name), ['analyst-chain'])
    // Deleting what is not there is not an error: the end state is what was asked.
    deleteWorkflow(dir, 'solo')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one unreadable file does not empty the whole list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-wf-'))
  try {
    saveWorkflow(dir, toMarkdown(DEFAULT_WORKFLOW))
    writeFileSync(join(dir, 'workflows', 'junk.md'), 'this is not a workflow at all')
    assert.deepEqual(
      listWorkflows(dir).map((w) => w.name),
      ['analyst-chain'],
      'a half-saved file must not take the good ones with it'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a workflow that would not run is refused before it reaches the disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-wf-'))
  try {
    assert.throws(() => saveWorkflow(dir, '# broken\n\n## a\n- can: builds\n\nbrief'), /dispatch/)
    assert.deepEqual(listWorkflows(dir), [], 'nothing half-written is left behind')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a name cannot write outside the workflow directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-wf-'))
  try {
    assert.ok(workflowFile(dir, '../../etc/passwd').startsWith(join(dir, 'workflows')))
    assert.throws(() => workflowFile(dir, '../..'), /needs a name/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The starter is a form with the answers left out.
 *
 * It used to be a floor that ran as it stood, which read as "this is finished"
 * - the blanks were example values and nothing said which of them were meant to
 * be replaced. Now every blank is marked, and the linter names each one, so the
 * preview beside the editor is a list of what is left to do.
 */
test('the starter parses, and every blank in it is named', () => {
  const parsed = parseMarkdown(STARTER)
  assert.ok('workflow' in parsed, JSON.stringify(parsed))
  if (!('workflow' in parsed)) return
  const w = parsed.workflow

  assert.equal(w.dispatch, 'boss')
  assert.deepEqual(w.roles.builder.can, ['builds'])
  assert.equal(w.roles.builder.hireable, true)

  const problems = lint(w)
  assert.ok(problems.length > 0, 'an unfilled template must not be applyable')
  // Structure is not what is missing - only the words are.
  assert.ok(
    problems.every((p) => p.includes('«')),
    `the only complaints should be blanks, got: ${problems.join(' | ')}`
  )
  // One line per place to fill in, not per distinct wording: the same blank in
  // two roles is two things to write, and collapsing them would hide one.
  assert.equal(problems.length, 5, `expected one line per blank, got: ${problems.join(' | ')}`)
  assert.ok(
    problems.some((p) => p.includes('boss')) && problems.some((p) => p.includes('builder')),
    'both roles have something left in them'
  )

  // Fill them in and it runs, with nothing else to change.
  const filled = STARTER.replace(/«[^»]*»/g, 'something real')
  const done = parseMarkdown(filled)
  assert.ok('workflow' in done)
  if ('workflow' in done) assert.deepEqual(lint(done.workflow), [])
})

/**
 * A brief is full of `<the task>` and `<what you changed>` - instructions to
 * the agent about what to write in a message. Those belong; the operator's own
 * blanks do not. Confusing the two flagged every shipped preset as unfinished.
 */
test('a placeholder meant for the agent is not mistaken for an unfilled blank', () => {
  for (const w of PRESETS) {
    assert.deepEqual(lint(w), [], `"${w.name}" must not read as a half-written template`)
  }
  const md = STARTER.replace(/«[^»]*»/g, 'real')
  const parsed = parseMarkdown(md)
  assert.ok('workflow' in parsed)
  if ('workflow' in parsed) {
    assert.match(parsed.workflow.roles.builder.brief, /<the task>/, 'the agent keeps its own')
    assert.deepEqual(lint(parsed.workflow), [])
  }
})

test('a comment cannot smuggle a bullet into a role', () => {
  const md = `# x

## a
- can: builds, checks
- talks to: you
<!-- - can: assigns -->
- dispatch

brief here`
  const parsed = parseMarkdown(md)
  assert.ok('workflow' in parsed)
  if ('workflow' in parsed) {
    assert.deepEqual(parsed.workflow.roles.a.can, ['builds', 'checks'])
    assert.equal(parsed.workflow.roles.a.brief, 'brief here')
  }
})

/**
 * A floor is not two people.
 *
 * `analyst-chain` has a boss and an analyst, and that shape was mistaken for a
 * rule: main could start exactly one agent beside the boss, so a workflow with
 * a third standing agent silently never started it.
 */
test('a workflow may name any number of standing agents', () => {
  const qa = PRESETS.find((w) => w.name === 'qa-lead') as Workflow
  assert.ok(qa, 'the preset that proves it must exist')
  assert.deepEqual(lint(qa), [])

  const fixed = Object.keys(qa.roles).filter((r) => qa.roles[r].fixed)
  assert.deepEqual(fixed.sort(), ['ba', 'god', 'qa'])

  // Whoever is not dispatch has to be started by the floor; anything that
  // treats "the second one" as special leaves the third standing agent down.
  const besides = fixed.filter((r) => r !== qa.dispatch)
  assert.equal(besides.length, 2, 'more than one agent stands beside the boss here')
  assert.ok(
    besides.every((r) => qa.roles[r].fixed?.id),
    'each one needs its own id to be spawned under'
  )

  // And the far end still works: a floor with none but the boss.
  const solo = PRESETS.find((w) => w.name === 'solo') as Workflow
  assert.deepEqual(
    Object.keys(solo.roles).filter((r) => solo.roles[r].fixed && r !== solo.dispatch),
    []
  )
})


/**
 * A floor whose voice is allowed to reach the human but never told to is the
 * quietest failure there is: it takes the work, does it, and says nothing. The
 * talks-to line permits the message; only the brief causes it.
 */
test("the floor's voice must be told to report, not merely allowed to", () => {
  const mute: Workflow = {
    ...DEFAULT_WORKFLOW,
    roles: {
      ...DEFAULT_WORKFLOW.roles,
      god: {
        ...DEFAULT_WORKFLOW.roles.god,
        // Allowed to write to the human - talksTo is untouched - but the brief
        // never says so, which is exactly how it slips through review.
        brief: 'You are {{self.name}}. Hand every request to {{role.ba.id}} and keep out of the way.'
      }
    }
  }
  const problems = lint(mute)
  assert.ok(
    problems.some((p) => p.includes('never tells it to write')),
    `expected a complaint about the boss never reporting, got: ${problems.join(' | ')}`
  )

  // And the shipped floors all pass it, so this is a rule and not a tripwire.
  for (const w of PRESETS) assert.deepEqual(lint(w), [], `"${w.name}" must stay clean`)
})

/**
 * A brief that opens with a list.
 *
 * The config block used to end at the first non-bullet line, so a brief whose
 * first line was "- report when you are done" was read as more role fields:
 * unknown keys, silently dropped, and the instruction never reached the agent.
 * Nothing errored - the brief was just shorter than what was written.
 */
test('bullets in a brief stay in the brief', () => {
  const md = `# t

## a · a builder
- can: builds
- talks to: you
- dispatch
- agent: a · A

- report when you are done
- report when you are blocked

Write to "you" when you finish.`
  const parsed = parseMarkdown(md)
  assert.ok('workflow' in parsed, JSON.stringify(parsed))
  if (!('workflow' in parsed)) return
  const role = parsed.workflow.roles.a

  assert.deepEqual(role.can, ['builds'], 'the config block is still read')
  assert.deepEqual(parsed.workflow.talksTo.a, ['you'])
  assert.match(role.brief, /report when you are done/, 'the list belongs to the brief')
  assert.match(role.brief, /report when you are blocked/)
  assert.match(role.brief, /Write to "you"/)
})

test('blank lines under the heading are just spacing', () => {
  const md = `# t

## a

- can: builds
- talks to: you
- dispatch
- agent: a · A

Report to "you" when done.`
  const parsed = parseMarkdown(md)
  assert.ok('workflow' in parsed)
  if ('workflow' in parsed) {
    assert.deepEqual(parsed.workflow.roles.a.can, ['builds'])
    assert.equal(parsed.workflow.roles.a.brief, 'Report to "you" when done.')
  }
})
