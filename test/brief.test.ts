import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBrief, writeBrief } from '../src/brief.ts'
import { lint, parseMarkdown, toMarkdown } from '../src/main/workflow.ts'
import { DEFAULT_WORKFLOW } from './floors.ts'

const HUMAN = { human: 'you', hire: 'hire' }

test('four answers become a brief an agent can actually follow', () => {
  const brief = writeBrief(
    {
      purpose: 'you write the piece the editor asked for',
      never: 'publish anything yourself',
      reportTo: 'editor',
      doneWhen: 'the proofreader passes it'
    },
    { ...HUMAN, kind: 'builds', label: 'a writer', checker: 'the proofreader' }
  )
  assert.match(brief, /^You are \{\{self\.name\}\}, a writer, on a Bullpen floor\./)
  assert.match(brief, /What this role is for: you write the piece the editor asked for\./)
  assert.match(brief, /You do not publish anything yourself/)
  // The parts nobody should have to know to write: the mailbox, and the exact
  // message to send when the work is done.
  assert.match(brief, /\$BULLPEN_MAILBOX\/outbox/)
  assert.match(brief, /"to": "editor", "subject": "done: /)
  assert.match(brief, /A task here is finished when the proofreader passes it\./)
})

test('the floor\'s voice is told to report to the human, in its own address', () => {
  const brief = writeBrief(
    { purpose: 'you stand in for the person running this floor', never: '', reportTo: '', doneWhen: '' },
    { human: 'pi', hire: 'recruit', kind: 'speaksToHuman' }
  )
  assert.match(brief, /"to": "pi", "subject": "report"/)
  // This is the rule lint enforces: a voice that is never told to report is a
  // floor that finishes its work in silence.
  const w = {
    ...DEFAULT_WORKFLOW,
    human: 'pi',
    talksTo: { ...DEFAULT_WORKFLOW.talksTo, god: ['ba', 'pi'] },
    roles: { ...DEFAULT_WORKFLOW.roles, god: { ...DEFAULT_WORKFLOW.roles.god, brief } }
  }
  assert.ok(!lint(w).some((p) => p.includes('never tells it to write')))
})

test('whoever assigns is told how to hire, and in this floor\'s words', () => {
  const brief = writeBrief(
    { purpose: 'you decide who writes what', never: '', reportTo: 'chief', doneWhen: '' },
    { human: 'you', hire: 'staff-up', kind: 'assigns', hires: 'writer' }
  )
  assert.match(brief, /"to": "staff-up", "subject": "<project>", "role": "writer"/)
  assert.match(brief, /"to": "chief", "subject": "report: /)
})

test('a written brief is a legal brief, in a floor that lints clean', () => {
  const w = structuredClone(DEFAULT_WORKFLOW)
  w.roles.dev.brief = writeBrief(
    { purpose: 'you write the code', never: 'start a second task', reportTo: 'ba', doneWhen: 'a tester passes it' },
    { ...HUMAN, kind: 'builds', checker: 'a tester' }
  )
  assert.deepEqual(lint(w), [])
  // And it survives the round trip through markdown, blank lines and all.
  const back = parseMarkdown(toMarkdown(w))
  assert.ok('workflow' in back)
  if ('workflow' in back) assert.equal(back.workflow.roles.dev.brief, w.roles.dev.brief)
})

test('the answers read back out, and an edited brief says so by omission', () => {
  const answers = {
    purpose: 'you check what was built',
    never: 'rewrite it yourself',
    reportTo: 'ba',
    doneWhen: 'you say it passes'
  }
  const brief = writeBrief(answers, { ...HUMAN, kind: 'checks' })
  assert.deepEqual(readBrief(brief), {
    purpose: answers.purpose,
    never: answers.never,
    doneWhen: answers.doneWhen
  })
  // Somebody rewrote the opening line by hand: the form no longer claims it.
  assert.equal(
    readBrief(brief.replace('What this role is for:', 'The job:')).purpose,
    undefined
  )
})
