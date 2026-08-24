import type { WorkflowInfo } from '../../preload/index'

/**
 * The floor as a picture: who is on it, and who may write to whom.
 *
 * The one thing a chart is better at than any form is the shape of a chain -
 * "the boss writes to the analyst and to you, and to nobody else" is a sentence
 * you have to assemble from five rows of a table and can see at a glance here.
 *
 * Layout is computed, not stored. A position carries no meaning - the router
 * reads roles and capabilities, never coordinates - so putting them in the
 * workflow would mean a document describing an organisation, carrying one
 * machine's idea of where the boxes sit. Dragging moves a box for as long as
 * the dialog is open, and the next open lays it out again.
 */
export type ChartNode = {
  id: string
  label: string
  /** `role`, or one of the two addresses that are not roles. */
  kind: 'role' | 'human' | 'hire'
  x: number
  y: number
}

export type ChartEdge = { from: string; to: string }

/**
 * A node is a tile with its name under it, not a box with text inside.
 *
 * The name is the thing being read - "who is on this floor" - and inside a
 * 132-pixel box it was truncated at whatever fitted. Under the tile it can be
 * as long as it likes, and the tiles line up on a grid because they are all the
 * same size.
 */
export const NODE_W = 64
export const NODE_H = 64
/** How far under the tile its two lines of label sit. */
export const LABEL_H = 34
const GAP_X = 190
const GAP_Y = 118

/**
 * Which column a role belongs in: the order work moves through the floor.
 *
 * By capability kind rather than by name, the same way everything else here
 * reads a workflow - a floor whose builder is called `drafts` still stands
 * where a builder stands.
 */
function column(w: WorkflowInfo, role: string, far: Map<string, number>): number {
  if (role === w.dispatch) return 1
  const holds = (word: string): boolean =>
    word === role || (w.roles[role]?.can ?? []).includes(word)
  const inRules = (status: string): boolean =>
    (w.cardRules ?? []).some((rule) => rule.status === status && holds(rule.from))

  // The same three questions the rest of the app asks, from the same two
  // places: `talks to` says who reaches you, and the card rules say who hands
  // work out and who closes it. A label on the capability said it a fourth time.
  if ((w.talksTo[role] ?? []).includes(w.human)) return 1
  if (inRules('open')) return 2
  if (inRules('closes')) return 4
  // Nothing said where this one stands, which is the ordinary case on a floor
  // whose rules have not been written yet: without this every such role landed
  // in one column, stacked, with the lines crossing through the pile. How many
  // hops it is from dispatch is the shape that is actually drawn.
  return far.get(role) ?? 3
}

/** How many hops each role is from dispatch, following who writes to whom. */
function reach(w: WorkflowInfo): Map<string, number> {
  const far = new Map<string, number>([[w.dispatch, 1]])
  let edge = [w.dispatch]
  while (edge.length) {
    const next: string[] = []
    for (const from of edge) {
      for (const to of w.talksTo[from] ?? []) {
        if (!w.roles[to] || far.has(to)) continue
        far.set(to, (far.get(from) ?? 1) + 1)
        next.push(to)
      }
    }
    edge = next
  }
  return far
}

/**
 * How far down the floor each one stands, counting from the person running it.
 *
 * Steps along the lines, and nothing else. It read the column `layout` puts a
 * box in, which is a different question - that one asks what a role is *for*,
 * and answers 4 for anybody who closes work, so a floor of two roles came out
 * ranked 0, 1, 4. What somebody reading a rank wants is how many hands a task
 * passes through to get here, which is the drawing counted rather than
 * interpreted.
 *
 * The pair, not the arrow: a line means these two work together, so it is
 * walked in both directions. Anybody no line reaches stands below everybody
 * a line does.
 */
export function ranks(w: WorkflowInfo | null): Map<string, number> {
  if (!w) return new Map()
  const beside = new Map<string, string[]>()
  for (const { from, to } of edges(w)) {
    beside.set(from, [...(beside.get(from) ?? []), to])
    beside.set(to, [...(beside.get(to) ?? []), from])
  }

  const out = new Map<string, number>([[w.human, 0]])
  let edge = [w.human]
  while (edge.length) {
    const next: string[] = []
    for (const from of edge) {
      for (const to of beside.get(from) ?? []) {
        if (!w.roles[to] || out.has(to)) continue
        out.set(to, (out.get(from) ?? 0) + 1)
        next.push(to)
      }
    }
    edge = next
  }

  // Nobody wrote a line to these. They are on the floor and answer to no one on
  // it, which is the bottom rather than the top: the human is the top.
  const below = Math.max(...out.values()) + 1
  for (const r of Object.keys(w.roles)) if (!out.has(r)) out.set(r, below)
  return out
}

/** Every node, laid out in columns, with the human in front and hiring behind. */
export function layout(w: WorkflowInfo | null): ChartNode[] {
  if (!w) return []
  const roles = Object.keys(w.roles)
  const far = reach(w)
  const columns = new Map<number, string[]>()
  for (const r of roles) {
    const c = column(w, r, far)
    columns.set(c, [...(columns.get(c) ?? []), r])
  }

  const tallest = Math.max(1, ...[...columns.values()].map((list) => list.length))
  const centre = ((tallest - 1) * GAP_Y) / 2

  const nodes: ChartNode[] = []
  for (const [c, list] of columns) {
    list.forEach((role, i) => {
      const top = centre - ((list.length - 1) * GAP_Y) / 2
      nodes.push({
        id: role,
        label: w.roles[role].label || role,
        kind: 'role',
        x: c * GAP_X,
        y: top + i * GAP_Y
      })
    })
  }

  // The human stands where the work comes from and goes back to. Hiring used to
  // stand here too and no longer does: it is a thing the floor can do, not
  // somebody on it, and a tile with a name under it said otherwise. It is still
  // in the file, and a role may still write to it.
  nodes.push({ id: w.human, label: 'you', kind: 'human', x: 0, y: centre })
  return nodes
}

/** Every allowed message, as an arrow. */
export function edges(w: WorkflowInfo | null): ChartEdge[] {
  if (!w) return []
  const known = new Set([...Object.keys(w.roles), w.human, w.hire])
  const drawn = Object.entries(w.talksTo).flatMap(([from, tos]) =>
    (tos ?? []).filter((to) => known.has(to)).map((to) => ({ from, to }))
  )
  // The one line no role declares: work arriving. `talks to` is written by
  // agents about agents, and the operator has no entry in it - so the arrow
  // they use most, handing a task to whoever takes it, was the one arrow the
  // drawing did not have, and the rule on it had nowhere to be written.
  if (w.roles[w.dispatch] && !drawn.some((e) => e.from === w.human && e.to === w.dispatch)) {
    drawn.unshift({ from: w.human, to: w.dispatch })
  }
  return drawn
}

/**
 * Add or remove one arrow, and hand back the whole table.
 *
 * Neither is allowed to invent a key: `talksTo` with an entry for a role that
 * does not exist lints as a broken floor, and dragging an arrow is not a way to
 * create one.
 */
export function connect(
  talksTo: Record<string, string[]>,
  from: string,
  to: string
): Record<string, string[]> {
  if (from === to) return talksTo
  const list = talksTo[from] ?? []
  if (list.includes(to)) return talksTo
  return { ...talksTo, [from]: [...list, to] }
}

/**
 * Draw a line, both ways.
 *
 * `connect` writes one direction, and the drawing has never had one: two roles
 * that write to each other are one dot on one line, and the panel on it talks
 * about the pair. So deleting a line and drawing it again - which is what
 * anybody does after moving a box - left a role able to write to somebody who
 * could not write back, and the picture said nothing about it. Every card rule
 * about the missing direction went quiet with it.
 *
 * The human is the exception: `talks to` is written by roles about roles, and
 * an entry under `you` names a role that does not exist. They are refused by
 * nobody anyway.
 */
export function link(
  w: Pick<WorkflowInfo, 'talksTo' | 'human' | 'hire'>,
  from: string,
  to: string
): Record<string, string[]> {
  const party = (r: string): boolean => r === w.human || r === w.hire
  let out = party(from) ? w.talksTo : connect(w.talksTo, from, to)
  if (!party(to)) out = connect(out, to, from)
  return out
}

/**
 * Take a line off, both ways, and say what that does to the floor.
 *
 * The dot is the pair rather than one arrow, so removing one direction and
 * leaving the other is not what anybody clicking it meant. Work arriving is the
 * exception: no role declares it, so there is nothing to remove and `edges`
 * draws it again on the next render - which is how the line between you and
 * dispatch came to look like a key that did nothing. A floor has to be
 * dispatched to somebody, so that arrow moves instead: to whoever else answers
 * the human, and failing that to anybody else at all.
 */
export function takeLineOff(
  w: WorkflowInfo,
  from: string,
  to: string
): Partial<WorkflowInfo> {
  let talksTo = w.talksTo
  if (from !== w.human) talksTo = disconnect(talksTo, from, to)
  if (to !== w.human) talksTo = disconnect(talksTo, to, from)

  const arriving =
    (from === w.human && to === w.dispatch) || (to === w.human && from === w.dispatch)
  const others = Object.keys(w.roles).filter((r) => r !== w.dispatch)
  const next = arriving
    ? (others.find((r) => (talksTo[r] ?? []).includes(w.human)) ?? others[0])
    : undefined

  const moved = {
    ...w,
    talksTo,
    ...(next ? { dispatch: next } : {})
  }
  return {
    talksTo,
    // The rules about this pair go with the line. Left behind, they are a rule
    // the router walks past forever on a pair that cannot exchange a message.
    cardRules: firing(moved),
    ...(next ? { dispatch: next } : {}),
    ...(next && w.entry === w.dispatch ? { entry: next } : {})
  }
}

export function disconnect(
  talksTo: Record<string, string[]>,
  from: string,
  to: string
): Record<string, string[]> {
  const list = talksTo[from]
  if (!list?.includes(to)) return talksTo
  return { ...talksTo, [from]: list.filter((x) => x !== to) }
}

/**
 * Where an arrow starts and ends: the edge of each box rather than its middle,
 * so a line between two boxes touches both and covers neither.
 */
export function anchor(a: ChartNode, b: ChartNode): { x1: number; y1: number; x2: number; y2: number } {
  const right = b.x >= a.x
  return {
    x1: a.x + (right ? NODE_W : 0),
    y1: a.y + NODE_H / 2,
    x2: b.x + (right ? 0 : NODE_W),
    y2: b.y + NODE_H / 2
  }
}

/**
 * What one line says, as the file's own lines.
 *
 * Two dropdowns and a text box said the same thing as one line of the file, in
 * a shape that only existed on this screen - and a person who had seen the file
 * had to learn it twice. So this is the file: the same `## card rules` lines,
 * both names and all, which is what makes them worth learning once.
 *
 *   - boss → builder: opens a card · when she puts somebody on it
 *   - builds → assigns: done · when it is finished
 *   - assigns → builds: drafting (their card) · when they send a problem back
 *
 * Both names are editable because a rule is often not about these two roles at
 * all: `builds → assigns` is every builder and every assigner, and typing that
 * over the pair's own names is the upgrade from one arrow to a floor's law.
 */
export type Talk = { from: string; to: string; status: string; whose?: string; when?: string }

const flat = (s: string): string => s.trim().toLowerCase().replace(/[\s-]+/g, '_')

/** The same line the file's parser reads, minus the leading dash. */
const RULE_LINE = /^(.+?)\s*(?:→|->|=>)\s*(.+?)\s*:\s*(.+)$/

/**
 * The words this floor uses for the things a rule can say that are not columns.
 *
 * Read from the floor rather than written here, because the rest of it is: a
 * floor whose board is `chờ duyệt` writes its rules in the same language, and
 * the panel that draws them has to read and write the same words the file does.
 * The format's own are the fallback, so nothing written before this stopped.
 */
export type Says = { open?: string; closes?: string; theirs?: string; when?: string }
const opensWord = (s?: Says): string => s?.open?.trim() || 'opens a card'
const closesWord = (s?: Says): string => s?.closes?.trim() || 'closes it'
const theirsWord = (s?: Says): string => s?.theirs?.trim() || 'their card'
const whenWord = (s?: Says): string => s?.when?.trim() || 'when'
const esc = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Read the lines somebody typed. A line that names no column is left out - it
 * is half-typed rather than wrong, and refusing it mid-keystroke would delete
 * the rule the moment they reached for a different column.
 */
export function readTalk(
  text: string,
  columns: { key: string; label: string }[],
  from: string,
  to: string,
  says?: Says
): Talk[] {
  const theirsAtEnd = new RegExp(`\\((${esc(theirsWord(says))}|their card|theirs)\\)\\s*$`, 'i')
  const leadingWhen = new RegExp(`^\\s*(?:${esc(whenWord(says))}|when)\\s+`, 'i')
  const out: Talk[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*[-*+]\s*/, '').trim()
    if (!line) continue
    const m = RULE_LINE.exec(line)
    // No `a → b:` on the line means they left the names to the arrow.
    const said = m ? m[3] : line
    const [head, ...rest] = said.split('·')
    const when = rest.join('·').replace(leadingWhen, '').trim()
    const theirs = theirsAtEnd.test(head)
    const words = head.replace(theirsAtEnd, '').trim()

    const low = words.toLowerCase()
    const status = low.startsWith(opensWord(says).toLowerCase()) || /^opens?\b/i.test(low)
      ? 'open'
      : low.startsWith(closesWord(says).toLowerCase()) || /^closes?\b/i.test(low)
        ? 'closes'
        : (columns.find((c) => c.key === flat(words) || flat(c.label) === flat(words))?.key ?? '')
    if (!status) continue
    out.push({
      from: m ? m[1].trim() : from,
      to: m ? m[2].trim() : to,
      status,
      ...(theirs ? { whose: 'to' } : {}),
      ...(when ? { when } : {})
    })
  }
  return out
}

/** And back out, in the same words the file uses. */
export function writeTalk(
  rules: Talk[],
  columns: { key: string; label: string }[],
  says?: Says
): string {
  return rules
    .map((r) => {
      const said =
        r.status === 'open'
          ? opensWord(says)
          : r.status === 'closes'
            ? closesWord(says)
            : (columns.find((c) => c.key === r.status)?.label ?? r.status)
      const tail = `${said}${r.whose === 'to' ? ` (${theirsWord(says)})` : ''}${
        r.when ? ` · ${whenWord(says)} ${r.when}` : ''
      }`
      return `- ${r.from} → ${r.to}: ${tail}`
    })
    .join('\n')
}


/**
 * An id for a role nobody has named yet.
 *
 * Counting the roles was wrong: add two, delete an earlier one, add a third,
 * and the count lands back on an id that already exists - which the spread that
 * writes it silently overwrote, taking that role's brief and its arrows with
 * it. The first free number instead, so it is free whatever was deleted.
 */
export function freeRoleId(roles: Record<string, unknown>, stem = 'role'): string {
  for (let n = 1; ; n++) {
    const id = `${stem}_${n}`
    if (!(id in roles)) return id
  }
}

/**
 * Who is standing on this floor when it opens, and who is hired when needed.
 *
 * Dispatch always stands: it is who the operator types at. Everyone else is
 * hired when there is work for them, unless the floor said otherwise - and the
 * "unless" is the whole of this. It used to force `fixed: undefined` on every
 * other role, so a floor that named a second agent to stand from launch had
 * that stripped the moment somebody opened the drawing and pressed save.
 */
/**
 * Whether any written rule moves a card between these two.
 *
 * A line drawn on a floor that has written its own rules gets none: the format
 * cannot guess what a new arrow is for, and a pair with no rule is a pair whose
 * messages leave the board exactly where it was. Said on the line rather than
 * found out later.
 */
export function ruled(floor: WorkflowInfo, a: string, b: string): boolean {
  const side = (role: string, word: string): boolean => sideOf(floor, role, word)
  return (floor.cardRules ?? []).some(
    (r) => (side(a, r.from) && side(b, r.to)) || (side(b, r.from) && side(a, r.to))
  )
}

/**
 * The rules a floor is missing for the lines it has just grown.
 *
 * Deleting takes the rules with it and always has; drawing did not put any
 * back, so a floor edited after it was written ended up with arrows the board
 * does not follow - a line drawn between two roles, and a card that sits where
 * it was. Whatever is already written stays and keeps its place, because the
 * router takes the first rule that fits and a hand-written one is the answer
 * somebody meant.
 */
export function fillRules(
  floor: WorkflowInfo,
  drawn: WorkflowInfo['cardRules']
): WorkflowInfo['cardRules'] {
  const covers = (a: string, b: string): boolean =>
    (floor.cardRules ?? []).some((r) => sideOf(floor, a, r.from) && sideOf(floor, b, r.to))
  return [...(floor.cardRules ?? []), ...drawn.filter((r) => !covers(r.from, r.to))]
}

/** Whether a role answers to a word one side of a rule uses. */
const sideOf = (floor: WorkflowInfo, role: string, word: string): boolean => {
  if (role === floor.human) return word === floor.human
  return (
    word === 'anyone' ||
    word === role ||
    (word === 'staff' && !(floor.talksTo[role] ?? []).includes(floor.human)) ||
    (floor.roles[role]?.can ?? []).includes(word)
  )
}

/**
 * The part of a floor its card rules are about: who is on it, and who writes to
 * whom. Sorted, because a line drawn and drawn again arrives in a different
 * order and means the same thing.
 */
export const shapeKey = (w: WorkflowInfo | null): string =>
  !w
    ? ''
    : JSON.stringify({
        // What each one is called and what it may do, not only who it writes
        // to. A role given a capability it did not have is a role whose brief
        // is now about the wrong job, and the file was left saying the old one
        // because nothing here had moved.
        roles: Object.entries(w.roles)
          .map(([id, def]) => [id, def.label, [...(def.can ?? [])].sort().join(',')].join('·'))
          .sort(),
        dispatch: w.dispatch,
        entry: w.entry,
        talksTo: Object.fromEntries(
          Object.entries(w.talksTo)
            .map(([from, tos]) => [from, [...tos].sort()] as const)
            .sort(([a], [b]) => a.localeCompare(b))
        ),
        // The rules themselves, so that typing one into the file counts the
        // same as moving a line does. The drawing and the rules are one thing
        // described two ways, and editing either leaves the other saying
        // something else - `write it` is what makes them agree again, and it
        // makes them agree by writing the rules the drawing says.
        rules: [...w.cardRules]
          .map((r) => [r.from, r.to, r.status, r.whose ?? ''].join('\u0000'))
          .sort(),
        // The board by key and by kind, which is what a rule names and what
        // decides where work goes. Not the label and not the colour: renaming a
        // column or picking another shade says nothing about how the floor
        // works, and stopping a save over it would be a rule with nothing
        // behind it.
        board: w.columns.map((c) => [c.key, c.kind ?? ''].join('\u0000'))
      })

/**
 * The rules that can still fire, given the floor as it is now drawn.
 *
 * A floor is drawn and redrawn - a line comes off, a box is deleted, an arrow
 * is drawn again somewhere else - and the rules stay exactly as they were
 * written. What that leaves is a rule the router walks past forever: `tester →
 * manager: closes it` on a floor where the tester cannot write to the manager
 * is not a rule that fires late, it is a task that never finishes, and nothing
 * anywhere says so.
 *
 * Two ways to be dead, and they took different shapes:
 *
 * A rule naming something this floor no longer has - a role that was deleted -
 * goes. This used to keep anything that was not a role, to protect rules
 * written about words (`builds → assigns`, `anyone → staff`), which meant a
 * deleted role read as a word and survived every save.
 *
 * A rule between two roles that no longer have a line goes too. Rules about
 * words are left alone: the drawing has nothing to say about which roles a word
 * will match tomorrow.
 */
export function firing(floor: WorkflowInfo): WorkflowInfo['cardRules'] {
  const crowds = new Set(['anyone', 'staff'])
  /** Whether anything on this floor answers to a word a rule uses. */
  const answers = (word: string): boolean =>
    crowds.has(word) ||
    word === floor.human ||
    word === floor.hire ||
    Boolean(floor.roles[word]) ||
    (floor.capabilities ?? []).some((c) => c.name === word)

  const talks = (a: string, b: string): boolean =>
    (floor.talksTo?.[a] ?? []).includes(b) || (a === floor.human && b === floor.dispatch)

  // A column can be renamed or taken off the board under a rule that sends
  // cards to it, and the file that names a stage the board does not have will
  // not read back at all.
  const keys = new Set((floor.columns ?? []).map((c) => c.key))
  return (floor.cardRules ?? []).filter((r) => {
    if (r.status !== 'open' && r.status !== 'closes' && !keys.has(r.status)) return false
    if (!answers(r.from) || !answers(r.to)) return false
    if (!floor.roles[r.from] || !floor.roles[r.to]) return true
    return talks(r.from, r.to)
  })
}

export function staffed(floor: WorkflowInfo): WorkflowInfo {
  const roles = Object.fromEntries(
    Object.entries(floor.roles).map(([id, def]) => {
      // Dispatch is the one role that cannot be hired into: it is who the
      // operator types at, and there has to be somebody there at launch.
      if (id === floor.dispatch) {
        // And it is Michael, whatever the file says. The fallback was the
        // role's own id and label, so a floor drawn from scratch stood up an
        // agent called `boss` - a different person on every floor, with a
        // different face, for a desk that is always the same one.
        //
        // Taken rather than defaulted, because `??` only filled the gap: the
        // generator forces this desk on the way out of the model, the blank
        // floor writes it in, and a floor typed by hand in the file column was
        // the one way left to end up with somebody else sitting at it.
        return [id, { ...def, hireable: undefined, fixed: { id: 'michael', name: 'Michael' } }]
      }
      // Filled in, never overwritten. This used to force `fixed: undefined,
      // hireable: true` on everyone else - so a floor that said it wanted a
      // second agent standing from launch had that stripped the moment somebody
      // opened the drawing and pressed save, and there was no way to say it
      // again that survived.
      if (def.fixed) return [id, { ...def, hireable: undefined }]
      return [id, { ...def, hireable: true }]
    })
  )
  return { ...floor, roles, cardRules: firing(floor) }
}
