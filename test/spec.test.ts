import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  generatorBrief,
  HEADER_FIELDS,
  HIRE_PARTY,
  HUMAN_PARTY,
  PLACEHOLDERS,
  ROLE_FIELDS,
  ROLE_FLAGS
} from '../src/workflow-spec.ts'
import { lint, parseMarkdown, renderBrief } from '../src/main/workflow.ts'
import { DEFAULT_WORKFLOW } from './floors.ts'
import { PRESETS as SHIPPED } from '../src/main/presets.ts'

/**
 * The rules, read the way nothing else reads them.
 *
 * Main bundles `rules.md` with `?raw`, which a node test cannot do - so this
 * reads the same file off disk. One document: the linter enforces it, the
 * dialog draws it, and the model that writes floors is briefed with it.
 */
const REFERENCE = readFileSync(join(import.meta.dirname, '..', 'src', 'rules.md'), 'utf8')
const BRIEF = generatorBrief(REFERENCE)

/**
 * The reference and the generator's brief were two hand-written copies of one
 * format, and they drifted: the dialog documented `*`, `cwd` on a hire and
 * `$BULLPEN_AGENT_ID`, none of which the writer had been told about. Worse, a
 * generator briefed from its own copy has no way to be caught inventing - what
 * it makes up looks like a feature nobody wrote down.
 */
test('the writer is briefed on exactly what the reference documents', () => {
  assert.ok(BRIEF.includes(REFERENCE), 'the writer must be handed the rules, not a summary of them')
  assert.match(BRIEF, /markdown file and nothing else/, 'and told what shape the answer takes')
  // Every section heading in the document reaches the writer, which is the
  // property that used to need checking term by term against a second copy.
  for (const heading of REFERENCE.matchAll(/^##\s+(.+)$/gm)) {
    assert.ok(BRIEF.includes(heading[1]), `the brief is missing the "${heading[1]}" section`)
  }
})

/**
 * A floor comes out in the language it was asked for in - except the parts
 * nothing reads.
 *
 * It used to come out entirely in English, on the grounds that a floor half in
 * one language reads as two documents stapled together. True of the prose, and
 * the wrong line to draw: the briefs are most of the file and all of the part
 * that decides how the floor behaves, and a brief the operator cannot read is a
 * brief they cannot correct.
 *
 * So the split is by who reads the line. A column key is stored on a card and a
 * capability's bracket is matched against four words - translate either and it
 * silently stops matching. A column *label* and a capability *name* are read by
 * a person and belong in the person's language.
 */
test('the writer answers in the language it was asked in, except the wire words', () => {
  assert.doesNotMatch(
    BRIEF,
    /in English, whatever language the request is written in/,
    'the whole-file English rule is what this replaced'
  )
  assert.match(BRIEF, /in the language the request came in/)

  // The words that are matched rather than read. Named one by one rather than
  // pattern-matched: they are ASCII like any other word, so nothing but the
  // words themselves catches one going missing from the brief.
  for (const wire of ['(speaksToHuman)', '(assigns)', '(builds)', '(checks)', '`done:`', '`fail:`']) {
    assert.ok(BRIEF.includes(wire), `the brief no longer tells the writer to keep ${wire}`)
  }

  // A key is what a card is stored under and a rule is matched against, so it
  // is ASCII whatever the label beside it says. The brief has to say so in the
  // same breath as it says the label is free, or the writer takes the freedom
  // and applies it to both.
  assert.match(BRIEF, /Column \*\*keys\*\*/)
})

/**
 * Anything the parser reads has to be documented, or a person writing a floor
 * by hand cannot know it exists. This is the direction that catches a feature
 * added to the code and never written down.
 */
test('every line the parser reads is in the reference', () => {
  for (const field of ROLE_FIELDS) {
    assert.ok(REFERENCE.includes(`- ${field}`), `role field "${field}" is undocumented`)
  }
  for (const flag of ROLE_FLAGS) {
    assert.ok(REFERENCE.includes(`- ${flag}`), `role flag "${flag}" is undocumented`)
  }
  for (const field of HEADER_FIELDS) {
    assert.ok(REFERENCE.includes(`- ${field}`), `header field "${field}" is undocumented`)
  }
  for (const party of [HUMAN_PARTY, HIRE_PARTY]) {
    assert.ok(REFERENCE.includes(party), `address "${party}" is undocumented`)
  }
})

/**
 * And the other direction: the reference must not promise a placeholder the
 * renderer does not fill, which would leave `{{...}}` standing in a real
 * agent's system prompt.
 */
test('every placeholder the reference names is one that gets filled', () => {
  const w = DEFAULT_WORKFLOW
  for (const ph of PLACEHOLDERS) {
    assert.ok(REFERENCE.includes(ph), `placeholder ${ph} is undocumented`)
    // Substitute a real role name for the wildcard before rendering.
    const real = ph.replace('<name>', 'ba')
    const out = renderBrief({ ...w, roles: { ...w.roles, god: { ...w.roles.god, brief: real } } }, 'god', {
      id: 'michael',
      name: 'Michael',
      reportTo: 'ba'
    })
    assert.ok(!out.includes('{{'), `${ph} was documented but is not filled in - it would reach an agent as-is`)
  }
})

/**
 * Every rule stated to the writer must be one the linter actually enforces -
 * a rule nothing checks is advice, and advice in a spec reads as a guarantee.
 */
test('the rules the writer is given are rules the linter enforces', () => {
  // None are switched on, but the ids on offer have to be real ones.
  const offered = [...REFERENCE.slice(REFERENCE.indexOf('## law')).matchAll(/`([\w-]+)`/g)]
  assert.ok(offered.length > 0, 'the document must name the checks it can run')

  // Each of these breaks one stated rule, and each must be caught.
  const w = DEFAULT_WORKFLOW
  const breaks: [string, typeof w][] = [
    [
      'dispatch without an agent',
      { ...w, roles: { ...w.roles, god: { ...w.roles.god, fixed: undefined } } }
    ],
    ['nobody speaks to the human', { ...w, talksTo: { ...w.talksTo, god: ['ba'] } }],
    [
      'a brief writing somewhere talks-to refuses',
      { ...w, talksTo: { ...w.talksTo, god: ['you'] } }
    ],
    ['thresholds out of range', { ...w, hireAbovePct: 0 }]
  ]
  for (const [what, broken] of breaks) {
    assert.ok(lint(broken).length > 0, `lint let "${what}" through, but the writer is told it is a rule`)
  }

  // A blank left in is refused, as the rules say.
  const withBlank = parseMarkdown('# «name»\n\n## a\n- can: builds\n- talks to: you\n- dispatch\n- agent: a · A\n\nbrief')
  assert.ok('workflow' in withBlank)
  if ('workflow' in withBlank) {
    assert.ok(lint(withBlank.workflow).some((p) => p.includes('«')))
  }
})

test('the shipped floors satisfy the spec they are shipped beside', () => {
  // Bar the rules, which are nobody's business but the operator's: a shipped
  // floor draws the organisation and leaves what its arrows do to the board
  // blank on purpose.
  for (const w of SHIPPED) {
    const left = lint(w).filter((p) => !/card|assigns/i.test(p))
    assert.deepEqual(left, [], `"${w.name}" contradicts its own reference`)
  }
})
