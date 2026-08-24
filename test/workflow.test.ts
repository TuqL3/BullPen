import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PRESETS, DEFAULT_WORKFLOW } from './floors.ts'
import { PRESETS as SHIPPED } from '../src/main/presets.ts'
import { STARTER } from '../src/main/presets.ts'
import {
  can,
  columnFor,
  coreRoles,
  deleteWorkflow,
  fixedId,
  formatDoc,
  hasPlaceFor,
  lint,
  listWorkflows,
  parseMarkdown,
  parseWorkflow,
  pctOr,
  pickForRole,
  refuseMail,
  renderBrief,
  roleOfFixedId,
  rolesWith,
  saveWorkflow,
  drawnCardRules,
  isBoard,
  matches,
  withWork,
  toMarkdown,
  trimmed,
  withoutCardRules,
  type CardRule,
  type Workflow,
  workCwd,
  workflowFile
} from '../src/main/workflow.ts'

/**
 * The presets are the schema's proof. `solo` has no analyst and no tester, and
 * `review` checks by reading instead of running - if either needs a special
 * case in the code, the workflow is not really data.
 */
test('the shipped floor is whole: its rules name its own roles and its own board', () => {
  // It used to ship as a drawing with no rules on it, because it was an example
  // somebody would rewrite. It is the floor the app runs now, so its rules ship
  // with it - and a rule naming a role or a column this floor does not have is
  // a rule that never fires, which reads as an agent ignoring you.
  for (const w of SHIPPED) {
    const known = new Set([...Object.keys(w.roles), w.human, w.hire, 'anyone', 'staff'])
    const caps = new Set(w.capabilities.map((c) => c.name))
    const columns = new Set([...w.columns.map((c) => c.key), 'open', 'closes'])
    for (const r of w.cardRules) {
      assert.ok(known.has(r.from) || caps.has(r.from), `"${w.name}": rule from "${r.from}"`)
      assert.ok(known.has(r.to) || caps.has(r.to), `"${w.name}": rule to "${r.to}"`)
      assert.ok(columns.has(r.status), `"${w.name}": rule moves a card to "${r.status}"`)
    }
    assert.deepEqual(lint(w), [], `preset "${w.name}" is missing something`)
  }
})

test('the default is the chain Bullpen has always run', () => {
  assert.equal(DEFAULT_WORKFLOW.name, 'analyst-chain')
  assert.equal(fixedId(DEFAULT_WORKFLOW, 'god'), 'michael')
  assert.equal(roleOfFixedId(DEFAULT_WORKFLOW, 'michael'), 'god')
  // One agent at launch, and everybody else hired when there is work for them.
  // A floor that stands four agents up on startup is four context windows being
  // paid for before anybody has asked for anything.
  assert.deepEqual(coreRoles(DEFAULT_WORKFLOW), ['god'])
  assert.equal(fixedId(DEFAULT_WORKFLOW, 'ba'), null)
  assert.equal(DEFAULT_WORKFLOW.roles.ba.hireable, true)
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
  // Nobody stands in that role at launch, so what the brief can name is the
  // role itself - which is an address: mail to it is put in front of whoever
  // holds it, or somebody is hired.
  assert.ok(brief.includes('the analyst'))
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
  // A capability nobody declared is not a parse error any more: which words
  // exist is the floor's own `## capabilities`, and `lint` is what checks a
  // role against them. The parser only refuses shapes it cannot read.
  const flies = parseWorkflow({ name: 'x', roles: { dev: { brief: 'hi', can: ['flies'] } } })
  assert.ok('workflow' in flies)
  if ('workflow' in flies) {
    assert.ok(
      lint(flies.workflow).some((p) => p.includes('flies')),
      'and lint is where it is refused'
    )
  }
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

## capabilities
- speaksToHuman — writes to you
- assigns — hands work out
- builds — does the work

## board
- todo: todo #7fc7e8 (start)
- done: done #7fd8a0 (done)

## card rules
- assigns → staff: opens a card
- builds → assigns: done
- speaksToHuman → you: done

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
/**
 * The file is what somebody opens to see what their floor is. It came out with
 * an empty `- can:`, an empty `- talks to:`, `- does:` repeating the brief's
 * own first line, and `- entry` under the `- dispatch` it already defaults to -
 * four lines of form where the floor should be.
 */
/**
 * The rules a drawing says, by name, and only where a line is.
 *
 * `defaultCardRules` answers in words - `assigns → staff` - which is right for
 * a floor that wrote nothing and wrong to write down: `staff` names pairs with
 * no line between them, so a file written from it drifts from the drawing the
 * moment anybody edits either.
 */
test('every line drawn gets a rule, whatever shape the floor is', () => {
  // The rules are written from pairs of capabilities - who assigns, who builds,
  // who checks - and a drawing can put a line where no pair names it: two
  // builders working to each other, a role holding a word nobody writes rules
  // about, a loop. Those lines came back from `write it` with nothing on them,
  // which is a hand-off the board never hears about.
  const bare = (id: string): Workflow['roles'][string] => ({
    label: id,
    can: [],
    brief: 'x',
    ...(id === 'boss' ? { fixed: { id: 'michael', name: 'M' } } : { hireable: true })
  })
  const floor = (talksTo: Record<string, string[]>, can: Record<string, string[]> = {}): Workflow =>
    ({
      ...DEFAULT_WORKFLOW,
      name: 'shape',
      dispatch: 'boss',
      entry: 'boss',
      cardRules: [],
      talksTo,
      roles: Object.fromEntries(
        Object.keys(talksTo).map((id) => [id, { ...bare(id), can: can[id] ?? [] }])
      )
    }) as Workflow

  const shapes: [string, Workflow][] = [
    ['a chain', floor({ boss: ['you', 'hire', 'a'], a: ['boss', 'b'], b: ['a'] })],
    ['two under one', floor({ boss: ['you', 'a', 'b'], a: ['boss'], b: ['boss'] })],
    [
      'builders working to each other',
      floor({ boss: ['you', 'a'], a: ['boss', 'b'], b: ['a'] }, { a: ['builds'], b: ['builds'] })
    ],
    ['a loop', floor({ boss: ['you', 'a'], a: ['b'], b: ['boss'] })],
    [
      'a word nothing writes rules about',
      floor({ boss: ['you', 'a'], a: ['boss'] }, { boss: ['assigns'], a: ['cites'] })
    ]
  ]

  for (const [what, drawn] of shapes) {
    const w = withWork(drawn)
    const ruled: Workflow = { ...w, cardRules: drawnCardRules(w) }
    for (const [from, tos] of Object.entries(w.talksTo)) {
      if (!w.roles[from]) continue
      for (const to of tos) {
        if (!w.roles[to] || to === from) continue
        assert.ok(
          ruled.cardRules.some((r) => matches(ruled, from, r.from) && matches(ruled, to, r.to)),
          `${what}: nothing says what "${from}" writing to "${to}" does`
        )
      }
    }
  }
})

test('the rules written from a drawing name only pairs that have a line', () => {
  const w = DEFAULT_WORKFLOW as Workflow
  const rules = drawnCardRules(w)
  assert.ok(rules.length > 0)

  const talks = (a: string, b: string): boolean =>
    (w.talksTo[a] ?? []).includes(b) || (a === w.human && b === w.dispatch)
  for (const r of rules) {
    // The human is one of the two ends a line can have, and the rule about the
    // task they type is the first card of every job on the floor.
    assert.ok(r.from === w.human || w.roles[r.from], `"${r.from}" is a role or the human`)
    assert.ok(r.to === w.human || w.roles[r.to], `"${r.to}" is a role or the human`)
    assert.ok(talks(r.from, r.to), `${r.from} → ${r.to} is a line on this floor`)
  }

  // One per direction: the router takes the first that fits and never reads the
  // second, so a second one written down is a line nobody can act on.
  const pairs = rules.map((r) => `${r.from}→${r.to}`)
  assert.deepEqual([...new Set(pairs)], pairs, 'no pair is written twice')

  // Take a line off and the rule about it is not written.
  const cut = { ...w, talksTo: { ...w.talksTo, tester: ['dev'] } } as Workflow
  assert.ok(!drawnCardRules(cut).some((r) => r.from === 'tester' && r.to === 'ba'))
})

/**
 * Which way a line goes is what decides whether it is a hand-off or a report,
 * and the drawing is the only thing that says. Level with each other counted as
 * a report, so a worker passing work sideways was marked as having finished it.
 */
test('a line that does not go back up is a hand-off, not a report', () => {
  const w = {
    ...(DEFAULT_WORKFLOW as Workflow),
    capabilities: [{ name: 'speaks', kind: 'speaksToHuman' as const, what: '' }],
    columns: [
      { key: 'todo', label: 'todo', bar: '#a3e3ff', kind: 'start' as const },
      { key: 'done', label: 'done', bar: '#7fd8a0', kind: 'done' as const }
    ],
    cardRules: [],
    dispatch: 'boss',
    entry: 'boss',
    roles: {
      boss: { label: 'the boss', can: ['speaks'], brief: 'x' },
      one: { label: 'one', can: [], brief: 'y', hireable: true },
      two: { label: 'two', can: [], brief: 'z', hireable: true }
    },
    talksTo: { boss: ['one', 'two', 'you'], one: ['boss', 'two'], two: ['boss', 'one'] }
  } as unknown as Workflow

  const at = (from: string, to: string): string | undefined =>
    drawnCardRules(w).find((r) => r.from === from && r.to === to)?.status

  // `one` and `two` are both one hop from the boss, so neither is reporting to
  // the other: whatever crosses between them is work.
  assert.equal(at('one', 'two'), 'open', 'sideways is work being handed over')
  assert.equal(at('two', 'one'), 'open')
  // Back towards the operator still is a report.
  assert.equal(at('one', 'boss'), 'done')
  assert.equal(at('boss', 'one'), 'open')
})

/**
 * A file grows things nobody uses and nothing says so - a capability declared
 * and held by no role, a second column of a kind everything already answers
 * with the first - and a floor read by somebody new is read as though every
 * line in it is load-bearing.
 */
test('writing the floor again takes out what nothing reaches', () => {
  const w = {
    ...(DEFAULT_WORKFLOW as Workflow),
    capabilities: [
      { name: 'speaks', kind: 'speaksToHuman' as const, what: '' },
      { name: 'builds', kind: 'builds' as const, what: '' },
      { name: 'checks', kind: 'checks' as const, what: 'held by nobody' }
    ],
    columns: [
      { key: 'todo', label: 'todo', bar: '#a3e3ff', kind: 'start' as const },
      { key: 'analysis', label: 'analysis', bar: '#b39ddb', kind: 'working' as const },
      { key: 'building', label: 'building', bar: '#e8cf6a', kind: 'working' as const },
      { key: 'review', label: 'review', bar: '#6ec6c9', kind: 'waiting' as const },
      { key: 'done', label: 'done', bar: '#7fd8a0', kind: 'done' as const }
    ],
    roles: {
      boss: { label: 'the boss', can: ['speaks'], brief: 'x' },
      dev: { label: 'a developer', can: ['builds'], brief: 'y', hireable: true }
    },
    talksTo: { boss: ['dev', 'you'], dev: ['boss'] },
    dispatch: 'boss',
    entry: 'boss',
    cardRules: [{ from: 'dev', to: 'boss', status: 'review' }]
  } as unknown as Workflow

  const out = trimmed(w)
  assert.deepEqual(
    out.capabilities.map((c) => c.name),
    ['speaks', 'builds'],
    'a word no role holds is a word nothing can name'
  )
  assert.deepEqual(
    out.columns.map((c) => c.key),
    ['todo', 'analysis', 'review', 'done'],
    'the second `working` column is a stage no card can reach; `review` is named by a rule'
  )
})

/**
 * The failure this stops: the board is written again for the work the floor
 * actually does, the rules still name the stages the old one had, and the file
 * that gets written will not read back - `"done" is not a column on this board`.
 */
test('a rule that names a stage the board no longer has goes with it', () => {
  const w = {
    ...(DEFAULT_WORKFLOW as Workflow),
    columns: [
      { key: 'requested', label: 'requested', bar: '#a3e3ff', kind: 'start' as const },
      { key: 'delivered', label: 'delivered', bar: '#7fd8a0', kind: 'done' as const }
    ],
    cardRules: [
      { from: 'ba', to: 'dev', status: 'done' },
      { from: 'dev', to: 'ba', status: 'delivered' },
      { from: 'tester', to: 'ba', status: 'closes' },
      { from: 'god', to: 'ba', status: 'open' }
    ]
  } as unknown as Workflow

  const out = trimmed(w)
  assert.deepEqual(
    out.cardRules.map((r) => r.status),
    ['delivered', 'closes', 'open'],
    '`done` is not a stage on this board any more'
  )

  // And what is left round-trips, which is the whole point.
  const back = parseMarkdown(toMarkdown(out))
  assert.ok(!('error' in back), 'error' in back ? back.error : '')
})

/**
 * What `write it` reads is the model's file with its rules taken out. Asked to
 * leave the section alone, a model copies the old rules back - and those name
 * the stages of the board it was in the same breath asked to replace, so the
 * whole file refused to read before anything could throw them away.
 */
test('the rules a model sends back are gone before the file is read', () => {
  const middle = [
    '# f',
    '',
    '## board',
    '- a: a #fff (start)',
    '',
    '## card rules',
    '- x → y: done',
    '- y → x: opens a card',
    '',
    '## briefs',
    '',
    '### x',
    '',
    'hi',
    ''
  ].join('\n')
  assert.ok(!withoutCardRules(middle).includes('card rules'))
  assert.ok(withoutCardRules(middle).includes('## briefs'), 'and what follows it stays')
  assert.ok(withoutCardRules(middle).includes('- a: a #fff (start)'), 'and what precedes it')

  // Last section, and a file that never had one.
  const last = '# f\n\n## board\n- a: a #fff (start)\n\n## card rules\n- x → y: done\n'
  assert.ok(!withoutCardRules(last).includes('x → y'))
  const none = '# f\n\n## board\n- a: a #fff (start)\n'
  assert.equal(withoutCardRules(none), none)
})

/** A board is a board when it has keys of its own, a start and an end. */
test('a board the model wrote is only taken when it is one', () => {
  const col = (key: string, kind: string): { key: string; label: string; bar: string; kind: string } => ({
    key,
    label: key,
    bar: '#fff',
    kind
  })
  const ok = [col('briefed', 'start'), col('drafting', 'working'), col('published', 'done')]
  assert.equal(isBoard(ok as Workflow['columns']), true)
  assert.equal(isBoard([col('a', 'start')] as Workflow['columns']), false, 'no end')
  assert.equal(
    isBoard([col('a', 'start'), col('a', 'done')] as Workflow['columns']),
    false,
    'two columns cannot share a key'
  )
  assert.equal(
    isBoard([col('a b', 'start'), col('z', 'done')] as Workflow['columns']),
    false,
    'a key is one word'
  )
})

test('the file leaves out what a role did not say', () => {
  const w = {
    ...DEFAULT_WORKFLOW,
    entry: DEFAULT_WORKFLOW.dispatch,
    capabilities: [],
    talksTo: { ...DEFAULT_WORKFLOW.talksTo, dev: [] },
    roles: {
      ...DEFAULT_WORKFLOW.roles,
      dev: {
        ...DEFAULT_WORKFLOW.roles.dev,
        can: [],
        brief: 'Does the work.\n\nAnd says so.',
        does: 'Does the work.'
      }
    }
  } as Workflow

  const md = toMarkdown(w)
  // The `### dev` block, which is where all four of them would have been.
  const from = md.indexOf('### dev')
  const block = md.slice(from, md.indexOf('\n###', from + 1))
  assert.ok(!block.includes('- can:'), 'a role that holds no words does not say so')
  assert.ok(!block.includes('- talks to:'), 'nor one that writes to nobody')
  assert.ok(!block.includes('- does:'), 'the brief already opens with it')
  assert.ok(!md.includes('- entry'), 'entry follows dispatch unless it was sent elsewhere')

  // What is still said is still read back.
  const back = parseMarkdown(md)
  assert.ok(!('error' in back), 'error' in back ? back.error : '')
  if ('error' in back) return
  assert.equal(back.workflow.entry, w.dispatch, 'and entry comes back pointing at dispatch')
  assert.deepEqual(back.workflow.roles.dev.can, [])

  // A role that was sent somewhere else keeps its line.
  const moved = toMarkdown({ ...w, entry: 'dev' } as Workflow)
  assert.ok(moved.includes('- entry'))
})

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
    // Unreadable is refused; unfinished is not - what a floor must have is a
    // matter of the laws that are switched on, and the caller checks those.
    assert.throws(() => saveWorkflow(dir, 'not a workflow at all'), /#/)
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

  // The rules are blank on purpose - the starter shows the syntax in a comment
  // and writes none of them - so those two complaints are the template working.
  const problems = lint(w).filter((p) => !/card|assigns/i.test(p))
  assert.ok(problems.length > 0, 'an unfilled template must not be applyable')
  // Structure is not what is missing - only the words are.
  assert.ok(
    problems.every((p) => p.includes('«')),
    `the only complaints should be blanks, got: ${problems.join(' | ')}`
  )
  // One line per place to fill in, not per distinct wording: the same blank in
  // two roles is two things to write, and collapsing them would hide one.
  assert.equal(problems.length, 7, `expected one line per blank, got: ${problems.join(' | ')}`)
  assert.ok(
    problems.some((p) => p.includes('boss')) && problems.some((p) => p.includes('builder')),
    'both roles have something left in them'
  )

  // Fill them in and it runs, with nothing else to change.
  const filled = STARTER.replace(/«[^»]*»/g, 'something real')
  const done = parseMarkdown(filled)
  assert.ok('workflow' in done)
  if ('workflow' in done) {
    assert.deepEqual(lint(done.workflow).filter((p) => !/card|assigns/i.test(p)), [])
  }
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
    assert.deepEqual(lint(parsed.workflow).filter((p) => !/card|assigns/i.test(p)), [])
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
  // The shipped floors stand one agent up - the one the operator types at - and
  // hire the rest. An operator who wants three standing can still write three,
  // and main must start all of them: the old code could start exactly one
  // beside the boss, and silently never started the third.
  const chain = DEFAULT_WORKFLOW
  const three: Workflow = {
    ...chain,
    roles: {
      ...chain.roles,
      ba: { ...chain.roles.ba, hireable: undefined, fixed: { id: 'iris', name: 'Iris' } },
      tester: { ...chain.roles.tester, hireable: undefined, fixed: { id: 'tess', name: 'Tess' } }
    }
  }
  const fixed = Object.keys(three.roles).filter((r) => three.roles[r].fixed)
  assert.deepEqual(fixed.sort(), ['ba', 'god', 'tester'])

  const besides = fixed.filter((r) => r !== three.dispatch)
  assert.equal(besides.length, 2, 'more than one agent stands beside the boss here')
  assert.ok(
    besides.every((r) => three.roles[r].fixed?.id),
    'each one needs its own id to be spawned under'
  )

  // And the far end, which is what ships: nobody but the boss.
  for (const w of PRESETS) {
    assert.deepEqual(
      Object.keys(w.roles).filter((r) => w.roles[r].fixed && r !== w.dispatch),
      [],
      `"${w.name}" stands somebody up besides the boss`
    )
  }
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

/**
 * The cast, then the prose.
 *
 * A workflow used to be four role definitions each buried under its own four
 * pages of brief: to find out who was on the floor you had to read everything
 * any of them had been told. The definitions come first now, in one section, so
 * the first screen of the file answers "who is here and what are they for".
 */
test('roles are defined first, briefs after, and both halves are read', () => {
  const md = `# two-part
One boss, one builder.

- reuse below: 40
- hire above: 80

## capabilities
- speaksToHuman — writes to you
- assigns — hands work out
- builds — does the work

## board
- todo: todo #7fc7e8 (start)
- done: done #7fd8a0 (done)

## card rules
- assigns → staff: opens a card
- builds → assigns: done
- speaksToHuman → you: done

## roles

### boss · the boss
- agent: chief · Chief
- can: speaksToHuman, assigns
- does: hands the work out and is the only one who reports to you
- talks to: builder, you, hire
- dispatch
- entry

### builder · a builder
- can: builds
- does: writes the code and reports when it is done
- talks to: boss
- hireable

## briefs

### boss

You are {{self.name}}. Report to the human every time: {"to": "you"}

### builder

You are "{{self.id}}". Report to {{reportTo}} when it is done.

### not-a-role

This heading names nobody, so it stays inside the builder's brief.
`
  const parsed = parseMarkdown(md)
  assert.ok('workflow' in parsed, JSON.stringify(parsed))
  if (!('workflow' in parsed)) return
  const w = parsed.workflow

  assert.equal(w.dispatch, 'boss')
  assert.equal(w.entry, 'boss')
  assert.equal(w.reuseBelowPct, 40)
  assert.equal(w.roles.boss.fixed?.id, 'chief')
  assert.equal(w.roles.boss.does, 'hands the work out and is the only one who reports to you')
  assert.equal(w.roles.builder.does, 'writes the code and reports when it is done')
  assert.deepEqual(w.talksTo.builder, ['boss'])
  // The brief was written in the other half of the document and still arrived.
  assert.match(w.roles.boss.brief, /Report to the human/)
  // A heading inside a brief that names no role is prose, not a new section:
  // briefs are written by people, and people write headings.
  assert.match(w.roles.builder.brief, /stays inside the builder's brief/)
  assert.deepEqual(lint(w), [])
})

test('what a role is for is written back out, above what the router does with it', () => {
  const md = toMarkdown(DEFAULT_WORKFLOW)
  assert.ok(md.indexOf('## roles') < md.indexOf('## briefs'), 'the cast comes before the prose')
  assert.ok(md.indexOf('## roles') < md.indexOf('You are {{self.name}}'), 'no brief above the cast')
  for (const [role, def] of Object.entries(DEFAULT_WORKFLOW.roles)) {
    assert.ok(md.includes(`### ${role}`), `"${role}" is missing from the cast`)
    assert.ok(md.includes(`- does: ${def.does}`), `"${role}" lost what it is for`)
  }
  // An old one-section workflow opens, and comes back in the new shape.
  const old = parseMarkdown(`# old\n\n## a · the boss\n- agent: a · A\n- can: speaksToHuman, assigns\n- talks to: b, you, hire\n- dispatch\n\nYou report to "you".\n\n## b · a builder\n- can: builds\n- talks to: a\n- hireable\n\nYou build.`)
  assert.ok('workflow' in old, JSON.stringify(old))
  if (!('workflow' in old)) return
  assert.equal(old.workflow.roles.a.brief, 'You report to "you".')
  assert.ok(toMarkdown(old.workflow).includes('## roles'), 'it is rewritten into the readable shape')
})

/**
 * The reference is a document, and a document somebody may disagree with.
 *
 * The one Bullpen ships is bundled; a file at `~/.bullpen/workflow-format.md`
 * takes over. Worth a test because the failure is silent both ways: an override
 * that is never read looks like an edit that did nothing, and a shipped
 * document dropped for an empty file would brief the workflow writer on a blank
 * page and reject everything it wrote.
 */
test('your own rules replace the shipped ones, and a blank file does not', () => {
  const home = mkdtempSync(join(tmpdir(), 'bp-fmt-'))
  try {
    const shipped = '# shipped\n\nthe format as it comes'

    const none = formatDoc(home, shipped)
    assert.equal(none.text, shipped)
    assert.equal(none.custom, false)
    assert.equal(none.path, join(home, 'rules.md'))

    writeFileSync(none.path, '# mine\n\nthe format as I want it', 'utf8')
    const mine = formatDoc(home, shipped)
    assert.equal(mine.custom, true)
    assert.match(mine.text, /as I want it/)

    // A truncated save is not a decision to describe the format as nothing.
    writeFileSync(none.path, '   \n', 'utf8')
    const blank = formatDoc(home, shipped)
    assert.equal(blank.text, shipped)
    assert.equal(blank.custom, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/**
 * A floor that is not a software team, written by hand.
 *
 * Every word in this file is the operator's: the columns, what the human is
 * called, the capabilities, the placeholders, and what each role is allowed to
 * run. None of it is a name the code knows - which is the whole claim being
 * tested, because until this the answer to "can I use my own words" was no.
 */
test('a floor can be described entirely in its own words', () => {
  const md = `# lab
Principal → researcher ⇄ reviewer.

- reuse below: 40
- hire above: 80
- human address: pi
- hire address: recruit

## capabilities
- reports (speaksToHuman) — the only one who writes to the PI
- plans (assigns) — decides what gets investigated
- collects (builds) — runs the experiment
- replicates (checks) — repeats it before anything is written up
- cites — used by the rules, and by nothing else

## words
- {{lab}} — the Kavli group
- {{style}} — cite everything, claim nothing twice

## board
- queued: Queued #7fc7e8 (start)
- running: Running #e8cf6a (working)
- replicating: Replicating #c9a2e8 (waiting)
- halted: Halted #e8917f (stuck)
- written_up: Written up #7fd8a0 (done)

## card rules
- plans → staff: opens a card
- reports → staff: opens a card
- collects → replicates: Replicating
- collects → plans: Replicating
- replicates → collects: Running (their card)
- replicates → plans: closes it
- plans → reports: Written up
- reports → pi: Written up

## roles

### chief · the principal
- agent: pi · Ada
- can: reports
- does: takes what you ask and hands it to the planner
- talks to: planner, pi
- dispatch
- entry
- cli: claude --model sonnet
- never: Bash

### planner · the planner
- can: plans
- does: turns a question into experiments and puts people on them
- talks to: chief, hand, checker, recruit
- hireable

### hand · a researcher
- can: collects, cites
- does: runs what it is given and writes down what happened
- talks to: planner, checker
- hireable

### checker · a reviewer
- can: replicates
- does: repeats the work before any of it is written up
- talks to: planner, hand
- hireable

## briefs

### chief
You are {{self.name}} of {{lab}}. Everything goes to the planner, and you are the
only one who writes to "pi". {{style}}.

### planner
You plan. Put somebody on it, "recruit" one if nobody is free, and report to the
principal when the reviewer passes it.

### hand
You run it. Report to {{reportTo}} when it is done or stuck.

### checker
You repeat it. Send problems to the researcher, and pass it to {{reportTo}}.
`
  const parsed = parseMarkdown(md)
  assert.ok('workflow' in parsed, JSON.stringify(parsed))
  if (!('workflow' in parsed)) return
  const w = parsed.workflow

  assert.deepEqual(lint(w), [], 'a floor in its own words must be a legal floor')
  assert.equal(w.human, 'pi')
  assert.equal(w.hire, 'recruit')
  assert.equal(w.roles.chief.cli, 'claude --model sonnet')
  assert.deepEqual(w.roles.chief.never, ['Bash'])
  // Capabilities are a name and a sentence. Which of them the app treats as
  // building or checking is read off the card rules, not off a label here.
  assert.deepEqual(
    w.capabilities.map((c) => c.name),
    ['reports', 'plans', 'collects', 'replicates', 'cites']
  )
  // Both, because both are written as opening one: the principal hands the
  // question to the planner, and the planner hands the work out. Read off the
  // rules, which is the point - nothing here labels either of them.
  assert.deepEqual(rolesWith(w, 'assigns'), ['chief', 'planner'], 'whoever a rule says opens a card')
  assert.deepEqual(rolesWith(w, 'checks'), ['checker'], 'whoever a rule says closes one')
  assert.deepEqual(rolesWith(w, 'speaksToHuman'), ['chief'], 'whoever talks-to allows')
  // Columns keep their own keys, and their kinds are what the floor reaches for.
  assert.deepEqual(
    w.columns.map((c) => c.key),
    ['queued', 'running', 'replicating', 'halted', 'written_up']
  )
  assert.equal(columnFor(w, 'working'), 'running')
  assert.equal(columnFor(w, 'done'), 'written_up')
  // A rule written with the column's display name resolves to its key. By what
  // it says rather than by where it sits: the list grew a line and every index
  // after it moved, which is a test about the parser failing about an edit to
  // the fixture.
  const rule = (from: string, to: string): CardRule | undefined =>
    w.cardRules.find((r) => r.from === from && r.to === to)
  assert.deepEqual(rule('collects', 'plans'), {
    from: 'collects',
    to: 'plans',
    status: 'replicating'
  })
  assert.deepEqual(rule('replicates', 'collects'), {
    from: 'replicates',
    to: 'collects',
    status: 'running',
    whose: 'to'
  })

  // The floor's own words reach the brief; the built-in ones still win.
  const brief = renderBrief(w, 'chief', { id: 'pi', name: 'Ada' })
  assert.match(brief, /You are Ada of the Kavli group/)
  assert.match(brief, /cite everything, claim nothing twice/)
  assert.ok(!brief.includes('{{'), 'nothing may reach an agent unfilled')

  // And it survives being written back out.
  const back = parseMarkdown(toMarkdown(w))
  assert.ok('workflow' in back)
  if ('workflow' in back) assert.deepEqual(back.workflow, w)
})

/**
 * Renaming the human is a rename, not a hole: the router has to route on the
 * new word, and the linter has to stop asking for the old one.
 */
test('the address the human answers to is the floor\'s, and lint follows it', () => {
  const base = parseMarkdown(toMarkdown(DEFAULT_WORKFLOW))
  assert.ok('workflow' in base)
  if (!('workflow' in base)) return
  // Renaming the human without moving `talks to` strands the old address, and
  // that is now the only thing deciding who the floor's voice is - so lint says
  // nobody can reach the human at all rather than quibbling about wording.
  const w = { ...base.workflow, human: 'boss' }
  assert.ok(
    lint(w).some((p) => p.includes('Nobody can write to the human')),
    `renaming the human must strand the old address, got: ${lint(w).join(' | ')}`
  )
  // Move it and the floor is legal again - with the voice still owing a brief
  // that tells it to write there.
  const moved = { ...w, talksTo: { ...w.talksTo, god: ['ba', 'boss'] } }
  assert.ok(
    lint(moved).some((p) => p.includes('"boss"')),
    `the voice still has to be told to write to "boss", got: ${lint(moved).join(' | ')}`
  )
  // Both reserved addresses cannot be one word, and neither may be a role.
  assert.ok(lint({ ...w, human: 'hire', hire: 'hire' }).some((p) => p.includes('cannot share')))
  assert.ok(
    lint({ ...base.workflow, hire: 'dev' }).some((p) => p.includes('both a role and a reserved'))
  )
})

/**
 * A role that works somewhere of its own is not a role in the wrong place.
 *
 * The spawn honoured `- cwd:` and the "is the running one where it should be"
 * check compared against dispatch's directory regardless, so an agent standing
 * exactly where it was told to was killed and restarted on every launch - which
 * costs its conversation, and says nothing on screen about why.
 */
test('where a role works is one answer, not two', () => {
  const base = parseMarkdown(toMarkdown(DEFAULT_WORKFLOW))
  assert.ok('workflow' in base)
  if (!('workflow' in base)) return
  const w: Workflow = {
    ...base.workflow,
    roles: { ...base.workflow.roles, ba: { ...base.workflow.roles.ba, cwd: '~/notes' } }
  }

  assert.equal(workCwd(w, 'ba', '/home/me', '/floor'), '/home/me/notes', '~ is the home directory')
  assert.equal(workCwd(w, 'god', '/home/me', '/floor'), '/floor', 'no cwd means where dispatch is')
  // An absolute path is taken as written, home or no home.
  const abs: Workflow = {
    ...w,
    roles: { ...w.roles, ba: { ...w.roles.ba, cwd: '/srv/notes' } }
  }
  assert.equal(workCwd(abs, 'ba', '/home/me', '/floor'), '/srv/notes')
})

/**
 * A board is what "the card an agent is on" is read off, and that question is
 * "its newest card that is not finished". A board with nothing marked finished
 * answers it wrong forever: every card reads as live, so the agent never gets
 * another one.
 */
test('a board has to have somewhere finished, and no two columns share a key', () => {
  const base = parseMarkdown(toMarkdown(DEFAULT_WORKFLOW))
  assert.ok('workflow' in base)
  if (!('workflow' in base)) return
  const w = base.workflow

  const noDone = { ...w, columns: w.columns.filter((c) => c.kind !== 'done') }
  assert.ok(
    lint(noDone).some((p) => p.includes('(done)')),
    `a board with nowhere finished must be refused, got: ${lint(noDone).join(' | ')}`
  )

  const twice = { ...w, columns: [...w.columns, { ...w.columns[0] }] }
  assert.ok(lint(twice).some((p) => p.includes('share the key')))

  // And the shipped floors all have somewhere to finish.
  for (const p of PRESETS) assert.deepEqual(lint(p), [], p.name)
})

/**
 * A floor has to be able to say things Bullpen has no word for.
 *
 * "Write in this tone", "escalate to this person", "never over 800 words" -
 * none of that is the app's business, and without somewhere to put it the only
 * way was writing the same sentence into four briefs by hand and remembering to
 * change all four.
 */
test('a role carries words of its own, and the narrower one wins', () => {
  const md = `# tone
One boss, one writer.

- reuse below: 50
- hire above: 70

## words
- {{tone}} — the house tone: plain and short
- {{deadline}} — Friday

## capabilities
- speaksToHuman — writes to you
- assigns — hands work out
- builds — does the work

## board
- todo: todo #7fc7e8 (start)
- done: done #7fd8a0 (done)

## card rules
- assigns → staff: opens a card
- builds → assigns: done
- speaksToHuman → you: done

## roles

### boss · the boss
- agent: chief · Chief
- can: speaksToHuman, assigns
- talks to: writer, you, hire
- dispatch
- entry

### writer · a writer
- can: builds
- talks to: boss
- hireable
- tone: warm, and never more than 800 words
- escalate to: legal

## briefs

### boss
You report to "you" every time.

### writer
Write in this tone: {{tone}}. Anything legal goes to {{escalate to}}. Due {{deadline}}.
`
  const parsed = parseMarkdown(md)
  assert.ok('workflow' in parsed, JSON.stringify(parsed))
  if (!('workflow' in parsed)) return
  const w = parsed.workflow

  assert.deepEqual(w.roles.writer.attrs, {
    tone: 'warm, and never more than 800 words',
    'escalate to': 'legal'
  })
  // The lines the parser already knows are not swept in with them.
  const own: Record<string, string> = w.roles.writer.attrs ?? {}
  assert.equal(own.can, undefined)
  assert.equal(own['talks to'], undefined)

  const brief = renderBrief(w, 'writer', { id: 'wanda', name: 'Wanda' })
  // The role's own tone beats the floor's; the floor's deadline still arrives.
  assert.match(brief, /Write in this tone: warm, and never more than 800 words\./)
  assert.match(brief, /goes to legal/)
  assert.match(brief, /Due Friday/)
  assert.ok(!brief.includes('{{'), 'nothing may reach an agent unfilled')

  // And they survive being written back out.
  const back = parseMarkdown(toMarkdown(w))
  assert.ok('back' in { back } && 'workflow' in back)
  if ('workflow' in back) assert.deepEqual(back.workflow, w)
  assert.deepEqual(lint(w), [])
})

/**
 * A rule that says what it is for.
 *
 * `builds → assigns: wait to test` is a true sentence nobody can act on: it
 * does not say when a builder writes to whoever assigns, which is the thing the
 * person drawing the floor had in mind and the thing they lose first.
 */
test('a card rule carries the words it was written for', () => {
  const md = toMarkdown({
    ...DEFAULT_WORKFLOW,
    cardRules: DEFAULT_WORKFLOW.cardRules.map((r) =>
      r.from === 'builds' && r.to === 'assigns' ? { ...r, when: 'they say the work is built' } : r
    )
  })
  assert.match(md, /- builds → assigns: wait to test · when they say the work is built/)

  const back = parseMarkdown(md)
  assert.ok('workflow' in back, JSON.stringify(back))
  if (!('workflow' in back)) return
  const rule = back.workflow.cardRules.find((r) => r.from === 'builds' && r.to === 'assigns')
  assert.equal(rule?.when, 'they say the work is built')
  assert.equal(rule?.status, 'wait_test', 'and the column it names is still read')

  // Both halves at once: whose card, and why.
  const both = parseMarkdown(
    md.replace(
      '- checks → builds: doing (their card)',
      '- checks → builds: doing (their card) · when they send a problem back'
    )
  )
  assert.ok('workflow' in both)
  if ('workflow' in both) {
    const r = both.workflow.cardRules.find((x) => x.from === 'checks' && x.to === 'builds')
    assert.equal(r?.whose, 'to')
    assert.equal(r?.when, 'they send a problem back')
  }
})

/**
 * Agents belong to a floor, so switching floors stands down whoever the new one
 * has no role for. `analyst-chain` over `solo` used to leave Iris running: on
 * the roster, mailable, working to a brief for a role that had gone.
 */
test('a floor keeps the agents it has a role for, and no others', () => {
  const solo = PRESETS.find((w) => w.name === 'solo') as Workflow
  const chain = DEFAULT_WORKFLOW

  // The analyst has no role on `solo` at all.
  assert.equal(hasPlaceFor(solo, { id: 'ba', role: 'ba', standing: true }), false)
  // The boss is the same role with the same agent named for it.
  assert.equal(hasPlaceFor(solo, { id: 'michael', role: 'god', standing: true }), true)
  // A hired builder is doing a job `solo` still has.
  assert.equal(hasPlaceFor(solo, { id: 'dev-2', role: 'dev', standing: false }), true)

  // A floor that names somebody else for a standing role replaces whoever is
  // in it; a hired agent doing the same job is not in that spot and stays.
  const renamed = {
    ...chain,
    roles: { ...chain.roles, ba: { ...chain.roles.ba, fixed: { id: 'nadia', name: 'Nadia' } } }
  }
  assert.equal(hasPlaceFor(renamed, { id: 'ba', role: 'ba', standing: true }), false)
  assert.equal(hasPlaceFor(renamed, { id: 'ba-helper', role: 'ba', standing: false }), true)
})

/**
 * Who takes work handed to a role. Every brief used to ask the agent to work
 * this out from the floor file - four steps a model does badly and silently.
 */
test('work handed to a role goes to whoever is free, emptiest window first', () => {
  const w = DEFAULT_WORKFLOW // reuse below 50, hire above 70

  const busy = { id: 'a', role: 'dev', idle: false, ctxPct: 10 }
  const full = { id: 'b', role: 'dev', idle: true, ctxPct: 71 }
  const some = { id: 'c', role: 'dev', idle: true, ctxPct: 60 }
  const fresh = { id: 'd', role: 'dev', idle: true, ctxPct: 5 }
  const other = { id: 'e', role: 'tester', idle: true, ctxPct: 0 }

  // Emptiest of the free ones, and never somebody in another role.
  assert.equal(pickForRole(w, 'dev', [busy, full, some, fresh, other]), 'd')
  // Nobody eligible is not an error: it means hire, which is the caller's job.
  assert.equal(pickForRole(w, 'dev', []), null)
  // The emptiest window on the floor belongs to somebody mid-turn. Work waits
  // for a new pair of hands rather than being stacked on a turn in progress:
  // a second task handed to a working agent lands as an interruption, and the
  // first one is what pays for it.
  assert.equal(pickForRole(w, 'dev', [busy]), null)
  // Idle but past "give it to one under" is treated the same as busy - what is
  // left of that window is not enough to work in.
  assert.equal(pickForRole(w, 'dev', [busy, full, some]), null)
  // A fresh hire has no reading yet. That is empty, not full.
  assert.equal(pickForRole(w, 'dev', [{ id: 'new', role: 'dev', idle: true }]), 'new')
  // At the threshold, not under it.
  assert.equal(pickForRole(w, 'dev', [{ id: 'x', role: 'dev', idle: true, ctxPct: 50 }]), null)
  assert.equal(pickForRole(w, 'dev', [{ id: 'x', role: 'dev', idle: true, ctxPct: 49 }]), 'x')

  // A floor may ship without `thresholds-ordered`, so the two numbers can be
  // the wrong way round. The lower one decides either way - reuse 90 must not
  // hand work to an agent that hire 10 calls unavailable.
  const inverted = { ...w, reuseBelowPct: 90, hireAbovePct: 10 }
  assert.equal(pickForRole(inverted, 'dev', [{ id: 'y', role: 'dev', idle: true, ctxPct: 20 }]), null)
  assert.equal(pickForRole(inverted, 'dev', [{ id: 'y', role: 'dev', idle: true, ctxPct: 5 }]), 'y')
})

/**
 * Where a fact is written is not what it says. Every model asked to write one
 * of these puts `- dispatch: boss` in the header, and the file was refused for
 * it - which read as "the generator is broken" rather than "same thing, other
 * line".
 */
test('dispatch and entry may be said in the header instead of on the role', () => {
  const md = [
    '# two desks',
    'a boss and a builder.',
    '',
    '- dispatch: boss',
    '- entry: dev',
    '',
    '## roles',
    '',
    '### boss · the boss',
    '- agent: chief · Chief',
    '- can: speaksToHuman',
    '- talks to: dev, you',
    '',
    '### dev · a builder',
    '- can: builds',
    '- talks to: boss',
    '- hireable',
    '',
    '## briefs',
    '',
    '### boss',
    'You are the boss.',
    '',
    '### dev',
    'You build.'
  ].join('\n')

  const parsed = parseMarkdown(md)
  assert.ok('workflow' in parsed, JSON.stringify(parsed))
  if (!('workflow' in parsed)) return
  assert.equal(parsed.workflow.dispatch, 'boss')
  assert.equal(parsed.workflow.entry, 'dev')

  // The bullet on the role still wins where both are written.
  const both = parseMarkdown(md.replace('- talks to: dev, you', '- talks to: dev, you\n- dispatch'))
  assert.ok('workflow' in both)
  if ('workflow' in both) assert.equal(both.workflow.dispatch, 'boss')

  // A header naming a role that is not there is not a dispatch.
  const wrong = parseMarkdown(md.replace('- dispatch: boss', '- dispatch: nobody'))
  assert.ok('error' in wrong)
})

/**
 * Punctuation is not meaning. The examples use `—` between a name and what it
 * is for; people and models write `·` or `:` and the line was dropped in
 * silence, which read as "the parser ignored half my file".
 */
test('a capability, a column and a rule may be written with any separator', () => {
  const head = ['# punctuation', 'one line.', '']
  const tail = [
    '## roles',
    '',
    '### boss · the boss',
    '- agent: chief · Chief',
    '- can: speaks',
    '- talks to: dev, you',
    '- dispatch',
    '',
    '### dev · a builder',
    '- can: builds',
    '- talks to: boss',
    '- hireable',
    '',
    '## briefs',
    '',
    '### boss',
    'You are the boss.',
    '',
    '### dev',
    'You build.'
  ]
  const md = [
    ...head,
    '## capabilities',
    '- speaks · the one who answers you',
    '- builds: does the work',
    '',
    '## board',
    '- todo · to do #7fc7e8 (start)',
    '- done: done #7fd8a0 (done)',
    '',
    '## card rules',
    '- speaks → dev: opens a card',
    '- dev → speaks: done',
    '',
    ...tail
  ].join('\n')

  const parsed = parseMarkdown(md)
  assert.ok('workflow' in parsed, JSON.stringify(parsed))
  if (!('workflow' in parsed)) return
  const w = parsed.workflow
  assert.deepEqual(w.capabilities.map((c) => c.name).sort(), ['builds', 'speaks'])
  assert.equal(w.capabilities.find((c) => c.name === 'speaks')?.what, 'the one who answers you')
  assert.deepEqual(w.columns.map((c) => c.key), ['todo', 'done'])
  assert.equal(w.columns[0].label, 'to do')
  assert.equal(w.cardRules.length, 2)
  assert.equal(w.cardRules[0].status, 'open')
})


test('a bullet may be written -, * or +, and losing one is never silent', () => {
  // `+` is a markdown bullet like the other two, and every regex in the parser
  // took `[-*]`. A line written with it was not a bullet, so it was dropped -
  // and lint had nothing to complain about, because what it described was gone
  // rather than wrong. A `+ hireable` left a role nobody could be hired into;
  // a `+ builds -> checks: ...` left a card rule that never moved a card.
  const floor = (bullet: string): string =>
    [
      '# bullets',
      'one line.',
      '',
      '## capabilities',
      `${bullet} speaks - may write to "you"`,
      `${bullet} builds - does the work`,
      `${bullet} checks - decides whether it passes`,
      '',
      '## roles',
      '',
      '### boss · the boss',
      `${bullet} agent: chief · Chief`,
      `${bullet} can: speaks`,
      `${bullet} talks to: dev, you`,
      `${bullet} dispatch`,
      '',
      '### dev · a builder',
      `${bullet} can: builds`,
      `${bullet} talks to: boss`,
      `${bullet} hireable`,
      '',
      '## board',
      `${bullet} todo: todo #7fc7e8 (start)`,
      `${bullet} doing: doing #e8cf6a (working)`,
      `${bullet} done: done #7fd8a0 (done)`,
      '',
      '## card rules',
      `${bullet} speaks → builds: opens a card`,
      `${bullet} builds → speaks: done`,
      '',
      '## briefs',
      '',
      '### boss',
      'You hand work to the builder.',
      '',
      '### dev',
      'You build what you are given and report when it is done.',
      ''
    ].join('\n')

  const dashed = parseMarkdown(floor('-'))
  assert.ok('workflow' in dashed, `the dashed floor must parse: ${JSON.stringify(dashed)}`)
  if (!('workflow' in dashed)) return

  for (const bullet of ['*', '+']) {
    const other = parseMarkdown(floor(bullet))
    assert.ok('workflow' in other, `"${bullet}" must parse: ${JSON.stringify(other)}`)
    if (!('workflow' in other)) continue
    assert.deepEqual(other.workflow, dashed.workflow, `"${bullet}" read differently from "-"`)
  }
})

test('a column keeps its name whatever is in it, or says it cannot', () => {
  // The label was matched as "anything that is not a # or a bracket", so a
  // column called `C# work` matched nothing, and a line that matches nothing is
  // skipped rather than refused - the board came back one column short, and the
  // one it lost was whichever the operator had just renamed.
  const floor = (label: string): string =>
    [
      '# labels',
      'one line.',
      '',
      '## capabilities',
      '- speaks - may write to "you"',
      '- builds - does the work',
      '',
      '## roles',
      '',
      '### boss · the boss',
      '- agent: chief · Chief',
      '- can: speaks',
      '- talks to: dev, you',
      '- dispatch',
      '',
      '### dev · a builder',
      '- can: builds',
      '- talks to: boss',
      '- hireable',
      '',
      '## board',
      `- todo: ${label} #7fc7e8 (start)`,
      '- doing: doing #e8cf6a (working)',
      '- done: done #7fd8a0 (done)',
      '',
      '## briefs',
      '',
      '### boss',
      'You hand work to the builder.',
      '',
      '### dev',
      'You build it and report when done.',
      ''
    ].join('\n')

  for (const label of ['plain', 'to #do', 'C# work', 'deadbeef', 'fix #abc123 now', 'x · y']) {
    const r = parseMarkdown(floor(label))
    assert.ok('workflow' in r, `"${label}" must parse: ${JSON.stringify(r)}`)
    if (!('workflow' in r)) continue
    const todo = r.workflow.columns.find((c) => c.key === 'todo')
    assert.ok(todo, `the column called "${label}" went missing`)
    assert.equal(todo?.label, label)
    assert.equal(todo?.bar, '#7fc7e8', `"${label}" swallowed the colour`)
    assert.equal(todo?.kind, 'start')
    assert.equal(r.workflow.columns.length, 3)
  }
})

test('a threshold nobody typed a number into does not empty the floor', () => {
  // Both come from number inputs, and a cleared one is NaN. Stored, every
  // `ctxPct < hireAbovePct` was false - so nobody was ever free, every hand-off
  // hired somebody new, and the brief told a real agent to "reuse one whose
  // ctxPct is under NaN".
  assert.equal(pctOr(NaN, 70), 70)
  assert.equal(pctOr(undefined, 70), 70)
  assert.equal(pctOr(null, 70), 70)
  assert.equal(pctOr('80', 70), 70, 'a string is not a percentage')
  assert.equal(pctOr(Infinity, 70), 70)
  assert.equal(pctOr(55, 70), 55)
  assert.equal(pctOr(55.4, 70), 55, 'rounded, because a board is not that precise')
  assert.equal(pctOr(0, 70), 1, 'and clamped into a range a floor can run on')
  assert.equal(pctOr(400, 70), 100)

  // What it protects: with a usable ceiling an idle agent is pickable.
  const w = { ...DEFAULT_WORKFLOW, hireAbovePct: pctOr(NaN, 70) } as unknown as Workflow
  const role = rolesWith(w, 'builds')[0]
  const picked = pickForRole(w, role, [{ id: 'quinn', role, idle: true, ctxPct: 12 }])
  assert.equal(picked, 'quinn', 'somebody with an empty window is free')
})

test('a floor may name the four words the format kept for itself', () => {
  // Roles, columns, capabilities and briefs are already the floor's own
  // language. `opens a card`, `closes it`, `(their card)` and `when` were not,
  // so a card rule written in Vietnamese was refused and the file could not be
  // finished in the language the rest of it was in.
  const floor = [
    '# kenh',
    'Chủ kênh giao ý tưởng.',
    '',
    '- human address: chu-kenh',
    '- opens a card: mở thẻ',
    '- closes it: đóng thẻ',
    '- their card: thẻ của họ',
    '- when: khi',
    '',
    '## capabilities',
    '- dieu-phoi - nhận việc và giao xuống',
    '- viet - viết kịch bản',
    '',
    '## roles',
    '',
    '### quan-ly · quản lý',
    '- agent: michael · Michael',
    '- can: dieu-phoi',
    '- talks to: bien-kich, chu-kenh',
    '- dispatch',
    '',
    '### bien-kich · biên kịch',
    '- can: viet',
    '- talks to: quan-ly',
    '- hireable',
    '',
    '## board',
    '- y-tuong: ý tưởng #7fc7e8 (start)',
    '- dang-viet: đang viết #e8cf6a (working)',
    '- da-dang: đã đăng #7fd8a0 (done)',
    '',
    '## card rules',
    '- dieu-phoi → viet: mở thẻ · khi giao ý tưởng',
    '- viet → dieu-phoi: đang viết (thẻ của họ) · khi bắt đầu',
    '- viet → dieu-phoi: đóng thẻ · khi xong',
    '',
    '## briefs',
    '',
    '### quan-ly',
    'Bạn chuyển việc cho "bien-kich" rồi báo lại "chu-kenh".',
    '',
    '### bien-kich',
    'Bạn viết kịch bản và báo lại.',
    ''
  ].join('\n')

  const r = parseMarkdown(floor)
  assert.ok('workflow' in r, `must parse: ${JSON.stringify(r)}`)
  if (!('workflow' in r)) return
  const w = r.workflow

  assert.equal(w.human, 'chu-kenh')
  assert.deepEqual(w.says, { open: 'mở thẻ', closes: 'đóng thẻ', theirs: 'thẻ của họ', when: 'khi' })
  assert.deepEqual(
    w.cardRules.map((c) => [c.status, c.whose ?? '', c.when ?? '']),
    [
      ['open', '', 'giao ý tưởng'],
      ['dang-viet', 'to', 'bắt đầu'],
      ['closes', '', 'xong']
    ]
  )

  // Written back out in the floor's own words, and read back the same.
  const md = toMarkdown(w)
  assert.match(md, /- dieu-phoi → viet: mở thẻ · khi giao ý tưởng/)
  assert.equal(md.includes('opens a card ·'), false)
  const again = parseMarkdown(md)
  assert.ok('workflow' in again)
  if ('workflow' in again) assert.deepEqual(again.workflow, w, 'the floor changed on the way round')
})

test('a floor that names none of them still reads the words it was written in', () => {
  for (const w of PRESETS) {
    assert.equal(w.says, undefined, `"${w.name}" should not carry words it never named`)
    const back = parseMarkdown(toMarkdown(w))
    assert.ok('workflow' in back, `"${w.name}" must still parse`)
    if ('workflow' in back) assert.deepEqual(back.workflow.cardRules, w.cardRules)
  }
})

/**
 * `board` is an address, so it cannot also be somebody.
 *
 * The router checks the reserved names before it looks for an agent, so a role
 * called `board` is a role nothing can reach: every message meant for it lands
 * on the task list instead, and the role sits on the chart doing nothing with
 * no error anywhere. `you` and `hire` were already covered; this one was added
 * later and was not.
 */
test('a role may not be called by the name of a reserved address', () => {
  const w = structuredClone(DEFAULT_WORKFLOW)
  w.roles.board = structuredClone(w.roles[w.dispatch])
  delete w.roles.board.fixed
  w.roles.board.hireable = true
  w.talksTo.board = [w.dispatch]
  w.talksTo[w.dispatch] = [...(w.talksTo[w.dispatch] ?? []), 'board']
  assert.ok(
    lint(w).some((p) => p.includes('board') && p.includes('reserved address')),
    `a role called board must be refused: ${lint(w).join(' | ')}`
  )
})
