import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dryRun } from '../src/main/dryrun.ts'
import { DEFAULT_WORKFLOW, PRESETS } from './floors.ts'
import { toMarkdown, parseMarkdown, type Workflow } from '../src/main/workflow.ts'

/**
 * The point of a dry run is that it is the same two functions the live floor
 * uses. A walkthrough written separately would agree with the floor right up
 * until somebody changed a card rule, and then it would lie confidently.
 */
test('a task walks the chain and ends where the workflow says it ends', () => {
  const run = dryRun(DEFAULT_WORKFLOW, 'ship the parser')
  const hops = run.steps.map((s) => `${s.from}→${s.to}`)
  assert.deepEqual(hops, [
    'you→god',
    'god→ba',
    'ba→dev',
    'dev→ba',
    'ba→tester',
    'tester→dev',
    'dev→tester',
    'tester→ba',
    'ba→god',
    'god→you'
  ])
  assert.ok(run.steps.every((s) => !s.refused), 'the shipped chain must not refuse itself')
  assert.match(run.ends, /a tester decides it is finished/)
  // The columns it names are the floor's own words, not the keys underneath.
  assert.ok(run.steps.some((s) => s.card.includes('wait to test')))
})

test('a floor with nobody checking is shorter, and says so', () => {
  const solo = PRESETS.find((w) => w.name === 'solo') as Workflow
  const run = dryRun(solo, 'fix the footer')
  assert.deepEqual(
    run.steps.map((s) => `${s.from}→${s.to}`),
    ['you→god', 'god→dev', 'dev→god', 'god→you']
  )
  assert.match(run.ends, /a developer decides it is finished/)
})

test('a floor in its own words is walked in its own words', () => {
  const content = PRESETS.find((w) => w.name === 'content-floor') as Workflow
  const run = dryRun(content, 'launch post')
  assert.ok(run.steps.some((s) => s.card.includes('in review')), 'this floor has no wait_test')
  assert.ok(run.steps.some((s) => s.to === 'proofreader'))
})

/**
 * The failure this is for: a chain that looks right in the file and has one
 * hop the router will not carry. Nothing about that shows up until real agents
 * are running and one of them is quietly handed its own message back.
 */
test('a broken chain is found without spending a model turn', () => {
  const md = toMarkdown(DEFAULT_WORKFLOW).replace(
    '- talks to: god, dev, tester, hire',
    '- talks to: god, dev, hire'
  )
  const parsed = parseMarkdown(md)
  assert.ok('workflow' in parsed)
  if (!('workflow' in parsed)) return

  const run = dryRun(parsed.workflow, 'anything')
  const refused = run.steps.find((s) => s.refused)
  assert.ok(refused, 'the analyst can no longer reach the tester, and that has to show')
  assert.equal(refused?.to, 'tester')
  assert.match(run.ends, /refused/)
})
