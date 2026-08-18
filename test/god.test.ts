import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  BA_ID,
  baBrief,
  floorPath,
  godBrief,
  publishFloor,
  refuseMail,
  workerBrief,
  writeBriefing,
  type FloorAgent
} from '../src/main/god.ts'

const home = (): string => mkdtempSync(join(tmpdir(), 'bp-god-'))

const rows = (activity: string): FloorAgent[] => [
  {
    id: 'dwight',
    name: 'Dwight',
    project: 'beets',
    cwd: '/tmp/beets',
    status: 'running',
    activity,
    pid: 42
  }
]

test('the snapshot is what Michael reads, so it must be complete and parseable', () => {
  const dir = home()
  try {
    assert.equal(publishFloor(dir, rows('working'), 1000), true)
    const floor = JSON.parse(readFileSync(floorPath(dir), 'utf8'))
    assert.equal(floor.you, 'michael')
    assert.equal(floor.updated, 1000)
    assert.deepEqual(floor.agents, rows('working'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unchanged floor is not rewritten - an idle app must not churn the file', () => {
  const dir = home()
  try {
    assert.equal(publishFloor(dir, rows('idle'), 1000), true)
    assert.equal(publishFloor(dir, rows('idle'), 2000), false)
    // Status changing is the whole point of the file, so it must get through.
    assert.equal(publishFloor(dir, rows('working'), 3000), true)
    assert.equal(JSON.parse(readFileSync(floorPath(dir), 'utf8')).agents[0].activity, 'working')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a truncated snapshot is replaced rather than treated as up to date', () => {
  const dir = home()
  try {
    writeFileSync(floorPath(dir), '{"agents": [{"id": "dwi')
    assert.equal(publishFloor(dir, rows('idle'), 1000), true)
    assert.deepEqual(JSON.parse(readFileSync(floorPath(dir), 'utf8')).agents, rows('idle'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the briefing is written once - after that the file is the operator to edit', () => {
  const dir = home()
  try {
    const path = writeBriefing(dir, '/tmp/floor.json')
    assert.match(readFileSync(path, 'utf8'), /BULLPEN_FLOOR/)
    writeFileSync(path, '# mine now')
    writeBriefing(dir, '/tmp/floor.json')
    assert.equal(readFileSync(path, 'utf8'), '# mine now')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a hired agent is told who it reports to, and how', () => {
  const brief = workerBrief('morgan', 'michael')
  // The three things that make a report possible at all: who it is, where the
  // outbox is, and the exact shape of the message. Agents finished work and
  // said so only in their own terminal before this existed.
  assert.match(brief, /"from": "morgan"/)
  assert.match(brief, /"to": "michael"/)
  assert.match(brief, /\$BULLPEN_MAILBOX\/outbox/)
  // Blocked and refused are reports too, or the floor only ever hears the
  // happy path and silence means two different things.
  assert.match(brief, /blocked/)
})

test('a developer is told that finishing hands the work to a tester, not to done', () => {
  const brief = workerBrief('morgan', BA_ID, 'dev')
  assert.match(brief, /"to": "ba"/)
  assert.match(brief, /tester/i, 'the loop only works if the developer knows it exists')
  // The bug traffic goes straight back, or the analyst becomes a relay for
  // every reproduction step and nothing moves without her.
  assert.match(brief, /reply to the tester/i)
})

test('a tester is told to take bugs to the developer and to close the loop itself', () => {
  const brief = workerBrief('quinn', BA_ID, 'tester')
  assert.match(brief, /"to": "<developer id>"/)
  assert.match(brief, /pass: /)
  assert.match(brief, /fail: /, 'a test that cannot pass is a report too')
  // A tester that quietly rewrites the feature is not a second opinion.
  assert.doesNotMatch(brief, /You build\./)
})

test('Michael relays and reports; he does not hire or assign', () => {
  const brief = godBrief()
  assert.match(brief, /"to": "ba"/)
  assert.match(brief, /"to": "you"/)
  assert.match(brief, /never hire/i)
  // Existing floors keep the CLAUDE.md they already have, which still tells him
  // to hire people. This is the only thing that overrides it.
  assert.match(brief, /supersedes/i)
})

test('the analyst assigns, hires by role, and reports only to Michael', () => {
  const brief = baBrief()
  assert.match(brief, /"to": "hire"/)
  assert.match(brief, /"role": "dev"/)
  assert.match(brief, /"role": "tester"/)
  assert.match(brief, /ctxPct/, 'reuse-or-hire is her call now, so she needs the rule')
  assert.match(brief, /"to": "michael"/)
  assert.match(brief, /Never write to "you"/, 'two people reporting the same thing is one too many')
})

test('a fresh floor tells Michael where work goes before he can guess wrong', () => {
  const dir = home()
  try {
    const text = readFileSync(writeBriefing(dir, '/tmp/floor.json'), 'utf8')
    assert.match(text, /\bba\b/)
    assert.match(text, /You do not hire/)
    // The whole point of the chain: built is not finished.
    assert.match(text, /waits to be tested|wait/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the floor has four one-way doors, and the shortcuts are shut', () => {
  // The boss talks to the analyst and to the human, and to nobody else: a task
  // he hands a developer directly is a task nobody analysed or tested.
  assert.equal(refuseMail('god', 'ba'), null)
  assert.equal(refuseMail('god', 'you'), null)
  assert.ok(refuseMail('god', 'dev'))
  assert.ok(refuseMail('god', 'tester'))
  assert.ok(refuseMail('god', 'hire'), 'hiring is the analyst’s')

  // The analyst is the only one who reaches all of it.
  for (const to of ['god', 'dev', 'tester', 'hire'] as const) {
    assert.equal(refuseMail('ba', to), null)
  }
  assert.ok(refuseMail('ba', 'you'), 'two people reporting to the human is one too many')

  // A developer and a tester have each other and the analyst.
  assert.equal(refuseMail('dev', 'tester'), null)
  assert.equal(refuseMail('dev', 'ba'), null)
  assert.ok(refuseMail('dev', 'god'))
  assert.ok(refuseMail('dev', 'you'))
  assert.equal(refuseMail('tester', 'dev'), null)
  assert.equal(refuseMail('tester', 'ba'), null)
  assert.ok(refuseMail('tester', 'god'))

  // A refusal an agent cannot act on is just silence, so it names the way out.
  assert.match(refuseMail('dev', 'god')!, /the analyst|a tester/)
})
