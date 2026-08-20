import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { lawOn, readRules, readType, type Field, type Rules } from '../src/rules.ts'

/** What the settings pane used to ask for, now that nothing but this does. */
const entityOf = (r: Rules, name: string) => r.entities.find((e) => e.name === name) ?? null
const fieldsOf = (r: Rules, name: string): Field[] =>
  entityOf(r, name)?.fields.filter((f) => !f.open) ?? []
const isOpen = (r: Rules, name: string): boolean =>
  Boolean(entityOf(r, name)?.fields.some((f) => f.open))
import { lint } from '../src/main/workflow.ts'
import { DEFAULT_WORKFLOW } from './floors.ts'

const RULES = readRules(readFileSync(join(import.meta.dirname, '..', 'src', 'rules.md'), 'utf8'))

test('a type reads the way it is written', () => {
  assert.deepEqual(readType('text'), { kind: 'text' })
  assert.deepEqual(readType('percent'), { kind: 'percent' })
  assert.deepEqual(readType('role'), { kind: 'ref', to: ['role'] })
  assert.deepEqual(readType('list of capability'), {
    kind: 'list',
    of: { kind: 'ref', to: ['capability'] }
  })
  assert.deepEqual(readType('one of start, working, done'), {
    kind: 'oneOf',
    of: ['start', 'working', 'done']
  })
  // Either a word from a list or the name of something: what `then` is.
  assert.deepEqual(readType('one of opens, closes or column'), {
    kind: 'oneOf',
    of: ['opens', 'closes', 'column']
  })
  assert.deepEqual(readType('list of role or address'), {
    kind: 'list',
    of: { kind: 'ref', to: ['role', 'address'] }
  })
})

test('the rules describe the things a floor is made of', () => {
  assert.deepEqual(
    RULES.entities.map((e) => e.name),
    ['capability', 'role', 'column', 'card rule', 'floor']
  )

  const role = entityOf(RULES, 'role')
  assert.ok(role)
  const named = fieldsOf(RULES, 'role').map((f) => f.name)
  assert.deepEqual(named, [
    'id',
    'label',
    'does',
    'can',
    'talks to',
    'agent',
    'hireable',
    'cli',
    'cwd',
    'never',
    'brief'
  ])

  const id = role!.fields.find((f) => f.name === 'id')!
  assert.equal(id.required, true)
  assert.equal(id.unique, true)
  assert.equal(id.match, '^[\\w-]+$')

  const talks = role!.fields.find((f) => f.name === 'talks to')!
  assert.deepEqual(talks.type, { kind: 'list', of: { kind: 'ref', to: ['role', 'address'] } })

  // A role takes lines the rules never named, and they become placeholders.
  assert.equal(isOpen(RULES, 'role'), true)
  assert.equal(isOpen(RULES, 'capability'), false)
})

test('a floor carries its own defaults, said once', () => {
  const floor = fieldsOf(RULES, 'floor')
  const by = (n: string) => floor.find((f) => f.name === n)!
  assert.equal(by('human address').fallback, 'you')
  assert.equal(by('hire address').fallback, 'hire')
  assert.equal(by('reuse below').fallback, '50')
  assert.deepEqual(by('reuse below').type, { kind: 'percent' })
  assert.equal(by('dispatch').required, true)
  assert.deepEqual(by('dispatch').type, { kind: 'ref', to: ['role'] })
})

/**
 * A law is a check with a switch. The words are the rules' to change; whether
 * the check runs at all is the rules' too - taking the line out turns it off,
 * which is the difference between a rule and a description of one.
 */
test('laws are listed with an id and the sentence a person is shown', () => {
  // One ships: the boss has to be able to hand work to somebody. A floor is
  // otherwise whatever was drawn, and the mechanism is what is tested here.
  assert.deepEqual(
    RULES.laws.map((l) => l.id),
    ['dispatch-hands-off', 'lines-have-rules']
  )
  const mine = readRules(
    RULES.text + '\n- `must-open` — at least one card rule must open a card\n'
  )
  assert.ok(lawOn(mine, 'must-open'))
  assert.ok(!lawOn(mine, 'no-such-law'))
  assert.match(
    mine.laws.find((l) => l.id === 'must-open')?.says ?? '',
    /card rule must open a card/
  )
})

test('the boss must have somebody to hand work to', () => {
  const w = structuredClone(DEFAULT_WORKFLOW)
  // Every line out of dispatch cut but the one back to the human: the floor
  // still reads, still has roles, and stops every task at the first desk.
  w.talksTo = { ...w.talksTo, [w.dispatch]: [w.human] }
  const said = lint(w, RULES)
  assert.ok(
    said.some((p) => p.includes(w.dispatch) && p.includes('draw a line')),
    said.join(' | ')
  )

  // Asking for a hire is not having somebody: there is no other role to hire
  // into on a floor like this.
  w.talksTo = { ...w.talksTo, [w.dispatch]: [w.human, w.hire] }
  assert.ok(lint(w, RULES).some((p) => p.includes('draw a line')))

  // And the floor as it stands is fine, on this law and on the whole rulebook.
  assert.deepEqual(lint(structuredClone(DEFAULT_WORKFLOW), RULES), [])
})

test('a rules file that will not parse is empty, not an exception', () => {
  const nothing = readRules('just some prose, no headings at all')
  assert.deepEqual(nothing.entities, [])
  assert.deepEqual(nothing.laws, [])
})

/**
 * The difference between a rule and a description of one: taking the line out
 * stops the check running. Everything the linter does answers to a law here, so
 * a floor that is refused was refused by something written down.
 */
test('a law that is not in the rules is a check that does not run', () => {
  const w = structuredClone(DEFAULT_WORKFLOW)
  // Break two different things at once.
  w.reuseBelowPct = 90
  w.hireAbovePct = 10
  w.cardRules = w.cardRules.filter((r) => r.status !== 'open')

  // Neither law ships switched on, so nothing is said about either. Filtered
  // to those two: taking the `open` rules off leaves lines with no rule, which
  // is a law that does ship and is right to complain.
  const about = (p: string): boolean => p.includes('thresholds') || p.includes('reach the board')
  assert.deepEqual(lint(w, RULES).filter(about), [])

  // Write the two laws in and the same floor is refused on both counts.
  const full = lint(
    w,
    readRules(
      RULES.text +
        '\n- `thresholds-ordered` — 0 < reuse below <= hire above <= 100\n' +
        '- `must-open` — at least one card rule must open a card\n'
    )
  )
  assert.ok(full.some((p) => p.includes('thresholds')), full.join(' | '))
  assert.ok(full.some((p) => p.includes('reach the board')), full.join(' | '))

  const quiet = lint(w, RULES)
  assert.ok(!quiet.some((p) => p.includes('thresholds')), quiet.join(' | '))
  assert.ok(!quiet.some((p) => p.includes('reach the board')), quiet.join(' | '))

  // And with no rules at all everything runs: a missing rulebook is not
  // permission.
  assert.ok(lint(w).some((p) => p.includes('thresholds')))
})

/**
 * The other direction. A law nothing enforces is advice dressed as a rule, and
 * the rules are the reference - so every id in the file has to be one the
 * linter asks about.
 */
test('every law the rules name is a law the linter asks about', () => {
  const asked = new Set(
    [...readFileSync(join(import.meta.dirname, '..', 'src', 'main', 'workflow.ts'), 'utf8')
      .matchAll(/on\('([\w-]+)'\)/g)].map((m) => m[1])
  )
  // The ids the rules offer, listed in the prose under `## law`.
  const offered = [...RULES.text.matchAll(/`([\w-]+)`/g)].map((m) => m[1])
  const known = offered.filter((id) => asked.has(id))
  assert.ok(known.length >= 10, `the rules should name checks that exist, got ${offered.join(' ')}`)
  for (const law of RULES.laws) {
    assert.ok(asked.has(law.id), `"${law.id}" is written in the rules and nothing checks it`)
  }
})

/**
 * The dialog edits this as a form, so what it hands back has to still be the
 * rules: a file to read, diff and keep, not a blob only this app can open.
 */
