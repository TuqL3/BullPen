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

test('a trigger stays due until it is actually delivered', () => {
  const { board, root } = fresh()
  const t = board.addTrigger('michael', 'hourly standup', 60)!
  const t0 = 1_000_000_000

  assert.equal(board.due(t0).length, 1, 'lastRun 0 means it is due immediately')
  // Asked twice without delivering: still due. `due()` used to stamp the clock
  // itself, so a trigger the caller dropped - a busy agent - spent its whole
  // interval on a prompt nobody received.
  assert.equal(board.due(t0).length, 1, 'unclaimed, so still waiting')

  board.markRun(t.id, t0)
  assert.equal(board.due(t0).length, 0, 'delivered, so the interval starts here')
  assert.equal(board.due(t0 + 59 * 60_000).length, 0, 'still inside the interval')
  assert.equal(board.due(t0 + 60 * 60_000).length, 1, 'due again after the interval')
  assert.equal(board.triggers('michael')[0].id, t.id)
  rmSync(root, { recursive: true, force: true })
})

test('the scheduler only spends an interval on a trigger that went in', () => {
  const { board, root } = fresh()
  const t = board.addTrigger('michael', 'standup', 1)!
  // Refused: the agent was busy. The board must not treat that as delivery.
  let seen = 0
  board.start((fired) => {
    seen++
    return fired.id === t.id && seen > 1
  }, 5)
  return new Promise<void>((done) => {
    setTimeout(() => {
      board.stop()
      assert.ok(seen >= 2, `fire was called ${seen} times`)
      assert.ok(board.triggers('michael')[0].lastRun > 0, 'the accepted one was stamped')
      rmSync(root, { recursive: true, force: true })
      done()
    }, 60)
  })
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

  // The columns are the workflow's, and this file is never given one - so a
  // name it has never heard of is a column somebody configured, not a typo to
  // refuse. Refusing them is what would leave the board disagreeing with the
  // one on screen.
  board.setTaskStatus(t.id, 'in_review')
  assert.equal(board.tasks()[0].status, 'in_review', "a floor's own column name is stored")
  board.setTaskStatus(t.id, '   ')
  assert.equal(board.tasks()[0].status, 'in_review', 'an empty column name is still nothing')
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

test('a context rule fires once per fill, not once per reading', () => {
  const { board, root } = fresh()
  assert.equal(board.setRule('michael', 5, 'compact'), null, 'too low to be useful')
  assert.equal(board.setRule('michael', 120, 'compact'), null, 'never reachable')

  const rule = board.setRule('michael', 80, 'compact')!
  assert.equal(rule.action, 'compact')
  assert.equal(board.ruleDue('michael', 79), null, 'under the line')
  assert.ok(board.ruleDue('michael', 80), 'at the line')
  // Still over it on the next turn: a second /compact for the same fill would
  // compact what the first one just compacted.
  assert.equal(board.ruleDue('michael', 92), null, 'already spent for this fill')
  assert.equal(board.ruleDue('michael', 77), null, 'inside the hysteresis band')
  assert.equal(board.ruleDue('michael', 74), null, 're-arms, does not fire on the way down')
  assert.ok(board.ruleDue('michael', 88), 'and fires again on the next fill')

  board.toggleRule('michael')
  assert.equal(board.ruleDue('michael', 99), null, 'off means off')
  board.removeRule('michael')
  assert.deepEqual(board.rules('michael'), [])
  rmSync(root, { recursive: true, force: true })
})

test('a card waiting for a tester survives a restart in that column', () => {
  const { board, root } = fresh()
  try {
    const t = board.addTask('morgan', 'add the sitemap route')!
    board.setTaskStatus(t.id, 'wait_test')
    // Built is a status a restart must not round back to done: the whole point
    // of the column is that nobody but the developer has vouched for it yet.
    const again = new Board(boardPath(root))
    assert.equal(again.tasks('morgan')[0].status, 'wait_test')
    assert.equal(again.tasks('morgan')[0].done, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
