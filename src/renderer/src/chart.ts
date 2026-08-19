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
 * Read the lines somebody typed. A line that names no column is left out - it
 * is half-typed rather than wrong, and refusing it mid-keystroke would delete
 * the rule the moment they reached for a different column.
 */
export function readTalk(
  text: string,
  columns: { key: string; label: string }[],
  from: string,
  to: string
): Talk[] {
  const out: Talk[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*[-*]\s*/, '').trim()
    if (!line) continue
    const m = RULE_LINE.exec(line)
    // No `a → b:` on the line means they left the names to the arrow.
    const said = m ? m[3] : line
    const [head, ...rest] = said.split('·')
    const when = rest.join('·').replace(/^\s*when\s+/i, '').trim()
    const theirs = /\((their card|theirs)\)\s*$/i.test(head)
    const words = head.replace(/\((their card|theirs)\)\s*$/i, '').trim()

    const status = /^opens?\b/i.test(words)
      ? 'open'
      : /^closes?\b/i.test(words)
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
export function writeTalk(rules: Talk[], columns: { key: string; label: string }[]): string {
  return rules
    .map((r) => {
      const said =
        r.status === 'open'
          ? 'opens a card'
          : r.status === 'closes'
            ? 'closes it'
            : (columns.find((c) => c.key === r.status)?.label ?? r.status)
      const tail = `${said}${r.whose === 'to' ? ' (their card)' : ''}${r.when ? ` · when ${r.when}` : ''}`
      return `- ${r.from} → ${r.to}: ${tail}`
    })
    .join('\n')
}

