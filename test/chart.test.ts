import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  anchor,
  connect,
  disconnect,
  edges,
  freeRoleId,
  staffed,
  layout,
  NODE_W,
  readTalk,
  writeTalk
} from '../src/renderer/src/chart.ts'
import { DEFAULT_WORKFLOW, PRESETS } from './floors.ts'
import type { WorkflowInfo } from '../src/preload/index.ts'

const chain = DEFAULT_WORKFLOW as unknown as WorkflowInfo

test('the chart stands the floor up in the order work moves through it', () => {
  const nodes = layout(chain)
  const at = (id: string): number => nodes.find((n) => n.id === id)?.x ?? -1

  assert.ok(at('you') < at('god'), 'the human comes before the boss')
  assert.ok(at('god') < at('ba'), 'the boss before whoever assigns')
  assert.ok(at('ba') < at('dev'), 'assigns before builds')
  assert.ok(at('dev') < at('tester'), 'builds before checks')
  // Hiring is not drawn at all. It is something the floor can do rather than
  // somebody standing on it, and a tile with a name under it said otherwise.
  assert.ok(!nodes.some((n) => n.kind === 'hire'))
  assert.ok(nodes.some((n) => n.kind === 'human'), 'and `you` is on every floor there is')
  assert.equal(layout(null).length, 0)
})

test('a floor in its own words stands up the same way', () => {
  const content = PRESETS.find((w) => w.name === 'content-floor') as unknown as WorkflowInfo
  const nodes = layout(content)
  const at = (id: string): number => nodes.find((n) => n.id === id)?.x ?? -1
  // Nothing here is called dev or tester; the columns are read off capability
  // kinds, so `drafts` still stands where a builder stands.
  assert.ok(at('editor') < at('writer'))
  assert.ok(at('writer') < at('proofreader'))
})

test('an arrow is a talks-to line, and dragging one cannot invent a role', () => {
  const talksTo = { god: ['ba', 'you'], ba: ['god'] }
  assert.deepEqual(connect(talksTo, 'ba', 'dev').ba, ['god', 'dev'])
  // Already there, or pointing at itself: nothing changes, and the same object
  // comes back so a re-render is not triggered for a no-op.
  assert.equal(connect(talksTo, 'god', 'ba'), talksTo)
  assert.equal(connect(talksTo, 'god', 'god'), talksTo)

  assert.deepEqual(disconnect(talksTo, 'god', 'ba').god, ['you'])
  assert.equal(disconnect(talksTo, 'god', 'nobody'), talksTo)
})

test('only arrows that lead somewhere are drawn', () => {
  const w = { ...chain, talksTo: { ...chain.talksTo, god: ['ba', 'you', 'ghost'] } }
  const drawn = edges(w as WorkflowInfo).filter((e) => e.from === 'god')
  assert.deepEqual(drawn.map((e) => e.to), ['ba', 'you'], 'a target that does not exist is not a line')
})

test('an arrow touches both boxes and covers neither', () => {
  const a = { id: 'a', label: 'a', kind: 'role' as const, x: 0, y: 0 }
  const b = { id: 'b', label: 'b', kind: 'role' as const, x: 300, y: 0 }
  const right = anchor(a, b)
  assert.equal(right.x1, NODE_W, 'leaves from the right edge')
  assert.equal(right.x2, 300, 'arrives at the left edge')
  // And backwards, the other way round - otherwise the line crosses the tile.
  const back = anchor(b, a)
  assert.equal(back.x1, 300)
  assert.equal(back.x2, NODE_W)
})

/**
 * What a line does, typed rather than picked.
 *
 * Two dropdowns said the same thing as one line of the file in a shape that
 * only existed on that screen, so somebody who had read the file had to learn
 * it twice. These are the file's own lines with the two names taken off.
 */
test('the rules on a line read and write as the words they are', () => {
  const columns = [
    { key: 'todo', label: 'todo' },
    { key: 'wait_test', label: 'wait to test' },
    { key: 'done', label: 'done' }
  ]
  const text = [
    '- boss → builder: opens a card · when she puts somebody on it',
    '- builds → assigns: wait to test · when they say it is built',
    '- assigns → builds: todo (their card) · when a problem comes back',
    '- tests → assigns: closes it'
  ].join('\n')

  const read = readTalk(text, columns, 'boss', 'builder')
  assert.deepEqual(read, [
    { from: 'boss', to: 'builder', status: 'open', when: 'she puts somebody on it' },
    { from: 'builds', to: 'assigns', status: 'wait_test', when: 'they say it is built' },
    { from: 'assigns', to: 'builds', status: 'todo', whose: 'to', when: 'a problem comes back' },
    { from: 'tests', to: 'assigns', status: 'closes' }
  ])
  // The column's own name, not the key it is stored under.
  assert.equal(writeTalk(read, columns), text)

  // A line naming nothing this board has is left out rather than guessed at.
  assert.deepEqual(readTalk('- a → b: somewhere else · when whatever', columns, 'x', 'y'), [])
  // No names on the line means the two the arrow already shows.
  assert.deepEqual(readTalk('- done', columns, 'boss', 'you'), [
    { from: 'boss', to: 'you', status: 'done' }
  ])
})

/**
 * A floor ships with no card rules, so the columns cannot be read off them.
 * Everything that was not dispatch and did not speak to the human landed in the
 * same column - four boxes in a vertical pile with the lines crossing through
 * it - which is what a new operator saw first.
 */
test('a floor with no rules is still laid out in the order it talks', () => {
  const bare = { ...chain, cardRules: [] } as unknown as WorkflowInfo
  const placed = layout(bare)
  const x = (id: string): number => placed.find((n) => n.id === id)?.x ?? -1

  assert.ok(x('god') < x('ba'), 'the analyst stands after the boss')
  assert.ok(x('ba') < x('dev'), 'the developer stands after the analyst')
  assert.ok(x('ba') < x('tester'), 'so does the tester')
  // And nobody is stacked on top of somebody they talk to.
  const stacked = placed.filter((n) => n.x === x('dev') && n.id !== 'dev')
  assert.deepEqual(stacked.map((n) => n.id), ['tester'], 'only the two peers share a column')
})

/**
 * The operator hands work to whoever takes it, and that arrow is in no role's
 * `talks to` - it is the app's own doing. Without it the rule that says what a
 * dispatch does to the board had no line to be written on.
 */
test('the line from the operator to dispatch is always drawn', () => {
  const drawn = edges(chain)
  assert.ok(
    drawn.some((e) => e.from === chain.human && e.to === chain.dispatch),
    'you → dispatch is on the chart'
  )
  // And it is not doubled when a floor happens to declare it.
  const said = { ...chain, talksTo: { ...chain.talksTo, [chain.human]: [chain.dispatch] } }
  const twice = edges(said as unknown as WorkflowInfo).filter(
    (e) => e.from === chain.human && e.to === chain.dispatch
  )
  assert.equal(twice.length, 1)
})


test('a new role never lands on an id somebody already has', () => {
  // Counting the roles was the bug: add two, delete the first of them, add a
  // third, and the count comes back round to an id that is still in use - and
  // the object spread that writes it overwrote that role without a word.
  let roles: Record<string, unknown> = { boss: {}, builder: {} }
  const a = freeRoleId(roles)
  roles = { ...roles, [a]: {} }
  const b = freeRoleId(roles)
  roles = { ...roles, [b]: {} }
  assert.notEqual(a, b)

  delete roles[a]
  const c = freeRoleId(roles)
  assert.equal(c in roles, false, `${c} is already taken`)
  assert.notEqual(c, b)
})

test('a floor writes its card rules in its own words, both ways', () => {
  // Roles, columns, briefs and capabilities are all the floor's own language
  // already. These four were the format's: a rule written `mở thẻ` was refused,
  // so a floor could not be finished in the language the rest of it was in.
  const columns = [
    { key: 'dang_lam', label: 'đang làm' },
    { key: 'cho_duyet', label: 'chờ duyệt' }
  ]
  const says = { open: 'mở thẻ', closes: 'đóng thẻ', theirs: 'thẻ của họ', when: 'khi' }
  const rules = [
    { from: 'a', to: 'b', status: 'open', when: 'giao việc' },
    { from: 'b', to: 'a', status: 'cho_duyet', when: 'làm xong' },
    { from: 'a', to: 'b', status: 'dang_lam', whose: 'to', when: 'trả lại' },
    { from: 'b', to: 'a', status: 'closes' }
  ]

  const text = writeTalk(rules, columns, says)
  assert.match(text, /mở thẻ · khi giao việc/)
  assert.match(text, /đóng thẻ/)
  assert.match(text, /\(thẻ của họ\)/)
  assert.equal(text.includes('opens a card'), false, 'the format\'s own words are not written')

  assert.deepEqual(readTalk(text, columns, 'a', 'b', says), rules)

  // And a floor that never named them still reads the words it was written in.
  const plain = writeTalk(rules, columns)
  assert.match(plain, /opens a card · when giao việc/)
  assert.deepEqual(readTalk(plain, columns, 'a', 'b'), rules)
})

test('saving the drawing fills in who stands, and never takes it away', () => {
  // It used to force `fixed: undefined, hireable: true` on everyone but
  // dispatch - so a floor that said it wanted a second agent standing from
  // launch had that stripped the moment somebody opened the drawing and saved,
  // and there was no way to say it again that survived.
  const floor = {
    dispatch: 'boss',
    roles: {
      boss: { label: 'the boss', can: [], brief: 'x' },
      writer: { label: 'a writer', can: [], brief: 'y', fixed: { id: 'writer', name: 'Iris' } },
      hand: { label: 'a hand', can: [], brief: 'z' }
    }
  } as unknown as WorkflowInfo

  const out = staffed(floor)
  assert.deepEqual(out.roles.boss.fixed, { id: 'boss', name: 'the boss' }, 'dispatch always stands')
  assert.equal(out.roles.boss.hireable, undefined)
  assert.deepEqual(out.roles.writer.fixed, { id: 'writer', name: 'Iris' }, 'and so does whoever was named')
  assert.equal(out.roles.writer.hireable, undefined)
  assert.equal(out.roles.hand.fixed, undefined, 'anybody the floor did not name is hired')
  assert.equal(out.roles.hand.hireable, true)

  // Saving twice changes nothing more.
  assert.deepEqual(staffed(out), out)
})
