import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { floorPath, publishFloor, workerBrief, writeBriefing, type FloorAgent } from '../src/main/god.ts'

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
