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
  shapeKey,
  firing,
  fillRules,
  link,
  ranks,
  takeLineOff,
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

/**
 * Left to right on the drawing is who answers to whom, and the panels say it
 * out loud. `you` is the top of every floor: the role work is dispatched to
 * reports to the human, and nothing stands above them.
 */
test('the floor is ranked from the person running it', () => {
  const r = ranks(chain)
  // Hands a task passes through, not what the role is for: the tester closes
  // the work and still stands beside the developer, because the analyst is who
  // both of them hear from.
  assert.deepEqual(
    Object.fromEntries(r),
    { you: 0, god: 1, ba: 2, dev: 3, tester: 3 },
    'counted in steps from the person running the floor'
  )
  assert.equal(ranks(null).size, 0)

  // A role nobody drew a line to is at the bottom, not level with the human.
  const stray = { ...chain, roles: { ...chain.roles, intern: chain.roles.dev } } as WorkflowInfo
  assert.equal(ranks(stray).get('intern'), 4)
})

/**
 * Deleting the line work arrives on looked like a key that did nothing: no role
 * declares it, so there was nothing to remove and the drawing put it straight
 * back. It has to land somewhere, so it moves.
 */
/**
 * A line is the pair. Drawing one wrote a single direction while taking one off
 * removed both - so deleting a line and drawing it again, which is what anybody
 * does after moving a box, left one role unable to answer the other and the
 * picture looked exactly the same.
 */
test('drawing a line writes both directions', () => {
  const w = {
    human: 'you',
    hire: 'hire',
    talksTo: { boss: ['you'], dev: [] }
  } as unknown as WorkflowInfo

  const both = link(w, 'boss', 'dev')
  assert.deepEqual(both.boss, ['you', 'dev'])
  assert.deepEqual(both.dev, ['boss'], 'and the other one can answer')

  // The human and hiring are addresses, not roles: an entry under either names
  // something `talksTo` has no key for.
  const up = link(w, 'dev', 'you')
  assert.deepEqual(up.dev, ['you'])
  assert.equal(up.you, undefined)
  assert.equal(link(w, 'boss', 'hire').hire, undefined)

  // Drawn twice is drawn once.
  assert.deepEqual(link({ ...w, talksTo: both }, 'dev', 'boss'), both)
})

/**
 * A rule about two roles that no longer talk is not a rule that fires late, it
 * is a task that never finishes. `tester → manager: closes it` on a floor where
 * the tester cannot write to the manager was exactly that, and nothing anywhere
 * said so.
 */
test('saving drops the rules about pairs that no longer talk', () => {
  const floor = {
    human: 'you',
    hire: 'hire',
    dispatch: 'boss',
    talksTo: { boss: ['ba', 'you'], ba: ['boss', 'dev'], dev: ['ba'], tester: ['dev'] },
    capabilities: [{ name: 'builds' }, { name: 'assigns' }],
    columns: [
      { key: 'todo', label: 'todo', bar: '#a3e3ff', kind: 'start' },
      { key: 'building', label: 'building', bar: '#e8cf6a', kind: 'working' },
      { key: 'done', label: 'done', bar: '#7fd8a0', kind: 'done' }
    ],
    roles: {
      boss: { label: 'the boss', can: [], brief: 'x' },
      ba: { label: 'the analyst', can: [], brief: 'y' },
      dev: { label: 'a developer', can: [], brief: 'z' },
      tester: { label: 'a tester', can: [], brief: 'w' }
    },
    cardRules: [
      { from: 'ba', to: 'dev', status: 'building' },
      { from: 'tester', to: 'boss', status: 'closes' },
      { from: 'boss', to: 'you', status: 'closes' },
      { from: 'builds', to: 'assigns', status: 'open' }
    ]
  } as unknown as WorkflowInfo

  const kept = staffed(floor).cardRules
  assert.deepEqual(
    kept.map((r) => `${r.from}→${r.to}`),
    ['ba→dev', 'boss→you', 'builds→assigns'],
    'the tester cannot write to the boss, so that rule was never going to fire'
  )

  // A rule naming something the floor no longer has goes as well. It used to
  // survive: anything that was not a role read as a word, and a deleted role is
  // not a role.
  const gone = { ...floor, roles: { ...floor.roles } } as WorkflowInfo
  delete gone.roles.dev
  assert.deepEqual(
    firing(gone).map((r) => `${r.from}→${r.to}`),
    ['boss→you', 'builds→assigns'],
    'the developer is off the floor, and so is the rule about them'
  )
})

/**
 * Deleting a line took its rules with it from the start; drawing one put none
 * back. A floor written once and then redrawn by hand ended up with arrows the
 * board does not follow.
 */
test('a new line gets the rule it is missing, and the written ones keep their place', () => {
  const floor = {
    human: 'you',
    hire: 'hire',
    dispatch: 'boss',
    talksTo: { boss: ['ba', 'you'], ba: ['boss', 'dev'], dev: ['ba'] },
    capabilities: [{ name: 'builds' }],
    roles: {
      boss: { label: 'the boss', can: [], brief: 'x' },
      ba: { label: 'the analyst', can: [], brief: 'y' },
      dev: { label: 'a developer', can: ['builds'], brief: 'z' }
    },
    cardRules: [{ from: 'boss', to: 'ba', status: 'open' }]
  } as unknown as WorkflowInfo

  const drawn = [
    { from: 'boss', to: 'ba', status: 'doing' },
    { from: 'ba', to: 'dev', status: 'open' }
  ] as WorkflowInfo['cardRules']

  const filled = fillRules(floor, drawn)
  assert.deepEqual(
    filled.map((r) => `${r.from}→${r.to}:${r.status}`),
    ['boss→ba:open', 'ba→dev:open'],
    'the pair that already had a rule keeps the one it had, and keeps it first'
  )

  // A rule written about a word covers every role that holds it, so nothing is
  // added beside it.
  const worded = { ...floor, cardRules: [{ from: 'ba', to: 'builds', status: 'open' }] } as WorkflowInfo
  assert.equal(fillRules(worded, drawn).length, 2, 'only the boss→ba rule is new')
})

/**
 * What has to be reconciled before a floor is written, and what does not.
 *
 * The drawing and the rules are one thing described two ways, so editing either
 * leaves the other saying something else and `write it` is what makes them
 * agree. A threshold or a colour says nothing about how the floor works, and
 * standing in front of the save for one would be a rule with nothing behind it.
 */
test('what needs the floor written again, and what does not', () => {
  const floor = {
    human: 'you',
    hire: 'hire',
    dispatch: 'boss',
    entry: 'boss',
    hireAbovePct: 70,
    capabilities: [{ name: 'builds' }],
    columns: [
      { key: 'todo', label: 'todo', bar: '#a3e3ff', kind: 'start' },
      { key: 'done', label: 'done', bar: '#7fd8a0', kind: 'done' }
    ],
    talksTo: { boss: ['dev', 'you'], dev: ['boss'] },
    roles: {
      boss: { label: 'the boss', can: [], brief: 'x' },
      dev: { label: 'a developer', can: ['builds'], brief: 'y', hireable: true }
    },
    cardRules: [{ from: 'boss', to: 'dev', status: 'open' }]
  } as unknown as WorkflowInfo

  const was = shapeKey(floor)
  const moved = (patch: Partial<WorkflowInfo>): boolean => shapeKey({ ...floor, ...patch }) !== was

  // Everything the router acts on.
  assert.ok(moved({ talksTo: { boss: ['you'], dev: ['boss'] } }), 'a line taken off')
  assert.ok(moved({ cardRules: [{ from: 'boss', to: 'dev', status: 'done' }] }), 'a rule typed')
  assert.ok(moved({ cardRules: [] }), 'a rule deleted')
  assert.ok(
    moved({ columns: [{ ...floor.columns[0], key: 'briefed' }, floor.columns[1]] }),
    'a column renamed - a rule names it by key'
  )
  assert.ok(
    moved({ roles: { ...floor.roles, dev: { ...floor.roles.dev, can: [] } } }),
    'a role given different work'
  )

  // And what says nothing about how it works.
  assert.ok(!moved({ hireAbovePct: 40 }), 'a threshold')
  assert.ok(!moved({ hireAbovePct: 90 }), 'the other threshold')
  assert.ok(
    !moved({ columns: [{ ...floor.columns[0], bar: '#123456' }, floor.columns[1]] }),
    'a colour'
  )
  assert.ok(
    !moved({ columns: [{ ...floor.columns[0], label: 'the question' }, floor.columns[1]] }),
    "a column's label - the key is what a rule names"
  )
  assert.ok(
    !moved({ roles: { ...floor.roles, dev: { ...floor.roles.dev, brief: 'z' } } }),
    'a brief rewritten by hand'
  )
})

test('taking a line off removes both directions, and moves the one that cannot go', () => {
  const w = {
    ...chain,
    dispatch: 'dev',
    entry: 'dev',
    talksTo: { god: ['ba', 'you'], ba: ['god', 'dev'], dev: ['ba', 'you'], tester: ['ba'] }
  } as unknown as WorkflowInfo

  // An ordinary pair goes, both ways, and nothing else moves.
  const gone = takeLineOff(w, 'ba', 'dev')
  assert.deepEqual(gone.talksTo?.ba, ['god'])
  assert.deepEqual(gone.talksTo?.dev, ['you'])
  assert.equal(gone.dispatch, undefined, 'nothing about dispatch changed')

  // Work arriving cannot be removed, so it is handed to whoever else answers
  // the human - and inbound work follows it, because it was pointed there too.
  const moved = takeLineOff(w, 'dev', 'you')
  assert.equal(moved.dispatch, 'god')
  assert.equal(moved.entry, 'god')
  assert.deepEqual(moved.talksTo?.dev, ['ba'], 'the written half still goes')

  // Nobody else on the floor: it stays where it is rather than going nowhere.
  const alone = { ...w, roles: { dev: w.roles.dev } } as unknown as WorkflowInfo
  assert.equal(takeLineOff(alone, 'dev', 'you').dispatch, undefined)
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
  // Michael, not `boss · the boss`: the desk work is dispatched to is the same
  // desk on every floor, and naming its agent after whatever the role was
  // called stood up a different person, with a different face, for each one.
  assert.deepEqual(out.roles.boss.fixed, { id: 'michael', name: 'Michael' }, 'dispatch always stands')

  // And it is that desk however the file was typed. This used to only fill a
  // gap, so a floor whose dispatch role named somebody else - by hand in the
  // file column, the one path the generator does not pass through - kept them.
  const renamed = {
    ...floor,
    roles: { ...floor.roles, boss: { ...floor.roles.boss, fixed: { id: 'bob', name: 'Bob' } } }
  } as unknown as WorkflowInfo
  assert.deepEqual(staffed(renamed).roles.boss.fixed, { id: 'michael', name: 'Michael' })
  assert.equal(out.roles.boss.hireable, undefined)
  assert.deepEqual(out.roles.writer.fixed, { id: 'writer', name: 'Iris' }, 'and so does whoever was named')
  assert.equal(out.roles.writer.hireable, undefined)
  assert.equal(out.roles.hand.fixed, undefined, 'anybody the floor did not name is hired')
  assert.equal(out.roles.hand.hireable, true)

  // Saving twice changes nothing more.
  assert.deepEqual(staffed(out), out)
})
