import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Board, boardPath } from '../src/main/board.ts'

const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), 'bullpen-board-'))
  return { board: new Board(boardPath(root)), root }
}

test('tasks survive a restart', () => {
  const { board, root } = fresh()
  board.addTask('michael', 'call the client')
  board.addTask('dwight', 'beet inventory')

  const reopened = new Board(boardPath(root))
  assert.equal(reopened.tasks().length, 2)
  assert.deepEqual(
    reopened.tasks('michael').map((t) => t.text),
    ['call the client']
  )
  rmSync(root, { recursive: true, force: true })
})

test('blank tasks and prompts are refused', () => {
  const { board, root } = fresh()
  assert.equal(board.addTask('michael', '   '), null)
  assert.equal(board.addTrigger('michael', '', 5), null)
  assert.equal(board.tasks().length, 0)
  assert.equal(board.triggers().length, 0)
  rmSync(root, { recursive: true, force: true })
})

test('a trigger interval under a minute is refused', () => {
  // Guard on real money: a 0-minute trigger fires every tick, forever, against
  // a paid CLI.
  const { board, root } = fresh()
  for (const bad of [0, -5, 0.5, NaN, Infinity]) {
    assert.equal(board.addTrigger('michael', 'status?', bad), null, `interval ${bad}`)
  }
  assert.ok(board.addTrigger('michael', 'status?', 5))
  rmSync(root, { recursive: true, force: true })
})

test('due() fires on schedule and never twice for one interval', () => {
  const { board, root } = fresh()
  const t = board.addTrigger('michael', 'hourly standup', 60)!
  const t0 = 1_000_000_000

  assert.equal(board.due(t0).length, 1, 'lastRun 0 means it is due immediately')
  assert.equal(board.due(t0).length, 0, 'must not re-fire in the same window')
  assert.equal(board.due(t0 + 59 * 60_000).length, 0, 'still inside the interval')
  assert.equal(board.due(t0 + 60 * 60_000).length, 1, 'due again after the interval')
  assert.equal(board.triggers('michael')[0].id, t.id)
  rmSync(root, { recursive: true, force: true })
})

test('a disabled trigger never fires', () => {
  const { board, root } = fresh()
  const t = board.addTrigger('michael', 'noisy', 1)!
  board.toggleTrigger(t.id)
  assert.equal(board.due(Date.now() + 10 * 60_000).length, 0)
  board.toggleTrigger(t.id)
  assert.equal(board.due(Date.now() + 10 * 60_000).length, 1)
  rmSync(root, { recursive: true, force: true })
})

test('toggle and remove persist', () => {
  const { board, root } = fresh()
  const a = board.addTask('michael', 'one')!
  const b = board.addTask('michael', 'two')!
  board.toggleTask(a.id)
  board.removeTask(b.id)

  const reopened = new Board(boardPath(root))
  assert.equal(reopened.tasks().length, 1)
  assert.equal(reopened.tasks()[0].done, true)
  rmSync(root, { recursive: true, force: true })
})

test('a corrupt board file does not stop the app booting', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullpen-board-'))
  writeFileSync(boardPath(root), '{ this is not json')
  const board = new Board(boardPath(root))
  assert.deepEqual(board.tasks(), [])
  assert.ok(board.addTask('michael', 'still works'))
  rmSync(root, { recursive: true, force: true })
})

test('the file on disk is readable JSON, not an opaque blob', () => {
  const { board, root } = fresh()
  board.addTask('michael', 'inspectable with cat')
  const raw = JSON.parse(readFileSync(boardPath(root), 'utf8'))
  assert.equal(raw.tasks[0].text, 'inspectable with cat')
  rmSync(root, { recursive: true, force: true })
})

test('a card moves between columns and done stays in step', () => {
  const { board, root } = fresh()
  const t = board.addTask('michael', 'ship it')!
  assert.equal(t.status, 'todo')

  board.setTaskStatus(t.id, 'doing')
  assert.equal(board.tasks()[0].status, 'doing')
  assert.equal(board.tasks()[0].done, false)

  board.setTaskStatus(t.id, 'done')
  assert.equal(board.tasks()[0].done, true, 'done must track the column, not drift from it')

  board.setTaskStatus(t.id, 'nonsense' as never)
  assert.equal(board.tasks()[0].status, 'done', 'an unknown column is ignored')
  rmSync(root, { recursive: true, force: true })
})

test('a board written before statuses existed still loads', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullpen-board-'))
  writeFileSync(
    boardPath(root),
    JSON.stringify({
      tasks: [
        { id: '1', agentId: 'michael', text: 'old open', done: false, createdAt: 1 },
        { id: '2', agentId: 'michael', text: 'old closed', done: true, createdAt: 2 }
      ],
      triggers: []
    })
  )
  const board = new Board(boardPath(root))
  assert.deepEqual(
    board.tasks().map((t) => t.status),
    ['todo', 'done'],
    'the column is derived from done rather than left undefined'
  )
  rmSync(root, { recursive: true, force: true })
})

test('a card can be reassigned', () => {
  const { board, root } = fresh()
  const t = board.addTask('michael', 'hand over')!
  board.assignTask(t.id, 'dwight')
  assert.equal(board.tasks('dwight').length, 1)
  assert.equal(board.tasks('michael').length, 0)
  rmSync(root, { recursive: true, force: true })
})
