import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CAPABILITIES,
  generatorBrief,
  HEADER_FIELDS,
  HIRE_PARTY,
  HUMAN_PARTY,
  PLACEHOLDERS,
  ROLE_FIELDS,
  ROLE_FLAGS,
  WORKFLOW_RULES,
  WORKFLOW_SPEC
} from '../src/workflow-spec.ts'
import { lint, parseMarkdown, renderBrief } from '../src/main/workflow.ts'
import { DEFAULT_WORKFLOW, PRESETS } from '../src/main/presets.ts'

const REFERENCE = WORKFLOW_SPEC.flatMap((s) => s.rows.map(([term, what]) => `${term} ${what}`)).join('\n')
const BRIEF = generatorBrief()

/**
 * The reference and the generator's brief were two hand-written copies of one
 * format, and they drifted: the dialog documented `*`, `cwd` on a hire and
 * `$BULLPEN_AGENT_ID`, none of which the writer had been told about. Worse, a
 * generator briefed from its own copy has no way to be caught inventing - what
 * it makes up looks like a feature nobody wrote down.
 */
test('the writer is briefed on exactly what the reference documents', () => {
  for (const { title, rows } of WORKFLOW_SPEC) {
    assert.ok(BRIEF.includes(title.toUpperCase()), `the brief is missing the "${title}" section`)
    for (const [term] of rows) {
      assert.ok(BRIEF.includes(term), `the brief never mentions "${term}"`)
    }
  }
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
  for (const cap of CAPABILITIES) {
    assert.ok(REFERENCE.includes(cap), `capability "${cap}" is undocumented`)
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
    assert.ok(REFERENCE.includes(ph.replace('.<name>', '.<name>')) || REFERENCE.includes(ph.split('.<name>')[0]), `placeholder ${ph} is undocumented`)
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
  assert.ok(WORKFLOW_RULES.length > 0)

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
    ['thresholds out of range', { ...w, reuseBelowPct: 90, hireAbovePct: 10 }]
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
  for (const w of PRESETS) assert.deepEqual(lint(w), [], `"${w.name}" contradicts its own reference`)
})
