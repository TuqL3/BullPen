/**
 * Which panels are on screen, where, and how big.
 *
 * Columns left to right; each column a stack top to bottom. That is one nesting
 * level, not a general layout tree: it is enough for "the work tree above the
 * office floor, both beside the editor", and it costs no recursive renderer, no
 * per-node split ratios and no drop zones on four edges of every node.
 */
export const PANELS = ['roster', 'command', 'tree', 'floor'] as const
export type PanelId = (typeof PANELS)[number]

export type Layout = {
  /** Left to right; each column top to bottom. No column is ever empty. */
  columns: PanelId[][]
  /** Switched off. Its place in the columns is kept while it is hidden. */
  hidden: PanelId[]
  /** Relative column widths, aligned to `columns`. Only ratios matter. */
  colWeight: number[]
  /** Relative height inside its column. Ignored for a column of one. */
  rowWeight: Record<PanelId, number>
}

export const PANEL_TITLE: Record<PanelId, string> = {
  roster: 'roster',
  command: 'command center',
  tree: 'work tree',
  floor: 'office floor'
}

export const DEFAULT_LAYOUT: Layout = {
  columns: [['roster'], ['command'], ['tree', 'floor']],
  hidden: [],
  // Ratios, not pixels: on any window this is a narrow roster, two thirds of
  // the width to the command centre, and the rest to the tree and the floor.
  // Taken from the arrangement that was settled on by hand.
  colWeight: [0.59, 3.48, 1.15],
  // The work tree takes the larger share of its column: it is a list that
  // grows, and the office floor under it is a drawing of a fixed shape.
  rowWeight: { roster: 1, command: 1, tree: 1.8, floor: 1 }
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** Smallest share a panel may be dragged to and still have a grip to drag back. */
const MIN_SHARE = 0.08

/**
 * Accept whatever was persisted without trusting it. A config written by an
 * older build, or by hand, must not leave a panel unreachable, duplicated, or
 * sized to nothing.
 */
export function normalise(raw: unknown): Layout {
  const l = (raw ?? {}) as Partial<Layout>
  const seen = new Set<PanelId>()
  const columns: PanelId[][] = []
  for (const col of Array.isArray(l.columns) ? l.columns : []) {
    const stack: PanelId[] = []
    for (const p of Array.isArray(col) ? col : []) {
      if (PANELS.includes(p as PanelId) && !seen.has(p as PanelId)) {
        seen.add(p as PanelId)
        stack.push(p as PanelId)
      }
    }
    if (stack.length) columns.push(stack)
  }
  // A panel the config never mentions goes back where it started rather than
  // vanishing with no toggle able to bring it back. "Where it started" is the
  // company it keeps, not a column index: an index shifts as soon as an earlier
  // column is missing, which put the shell in the work tree's column.
  // Walked in default column order, so panels appended as new columns land in
  // the order the default puts them rather than the order PANELS lists them.
  for (const col of DEFAULT_LAYOUT.columns) {
    for (const p of col) {
      if (seen.has(p)) continue
      const mates = col.filter((q) => q !== p)
      const home = columns.find((c) => c.some((q) => mates.includes(q)))
      if (home) home.push(p)
      else columns.push([p])
      seen.add(p)
    }
  }

  const colWeight = columns.map((_, i) => {
    const w = (Array.isArray(l.colWeight) ? l.colWeight : [])[i]
    if (typeof w === 'number' && Number.isFinite(w) && w > 0.02) return w
    // No stored width for this column: fall back to the default at the same
    // position, so a config that only records the arrangement still opens with
    // a roster-width roster rather than four equal quarters.
    return DEFAULT_LAYOUT.colWeight[i] ?? 1
  })

  const rowWeight = { ...DEFAULT_LAYOUT.rowWeight }
  for (const p of PANELS) {
    const w = (l.rowWeight ?? {})[p]
    if (typeof w === 'number' && Number.isFinite(w) && w > 0.02) rowWeight[p] = w
  }

  // An absent list is "never chosen" and takes the default; an empty one is a
  // choice - everything shown - and must not be overwritten by that default.
  // The command centre is never in it: it has no switch in the title bar, so a
  // config that hides it is a window you cannot get the main panel back in.
  const hidden = (
    Array.isArray(l.hidden)
      ? [...new Set(l.hidden.filter((p): p is PanelId => PANELS.includes(p as PanelId)))]
      : [...DEFAULT_LAYOUT.hidden]
  ).filter((p) => p !== 'command')

  return {
    columns,
    // Hiding everything leaves a window with nothing in it. The toggles are in
    // the titlebar, but there would be no reason left to believe that.
    hidden: hidden.length === PANELS.length ? [] : hidden,
    colWeight,
    rowWeight
  }
}

/**
 * Columns with every hidden panel removed, and empty columns dropped.
 *
 * `index` is where the column sits in `l.columns`, which is NOT its position on
 * screen once a column is hidden. Resizing has to address the stored column, or
 * dragging a divider silently resizes a different pair - including a hidden one.
 */
export function visible(l: Layout): { panels: PanelId[]; weight: number; index: number }[] {
  const out: { panels: PanelId[]; weight: number; index: number }[] = []
  l.columns.forEach((col, i) => {
    const panels = col.filter((p) => !l.hidden.includes(p))
    if (panels.length) out.push({ panels, weight: l.colWeight[i] ?? 1, index: i })
  })
  return out
}

const without = (columns: PanelId[][], id: PanelId): PanelId[][] =>
  columns.map((c) => c.filter((p) => p !== id))

/** Drop empty columns and keep the weights aligned to what is left. */
function compact(l: Layout, columns: PanelId[][]): Layout {
  const keep = columns.map((c, i) => ({ c, w: l.colWeight[i] ?? 1 })).filter((x) => x.c.length)
  return { ...l, columns: keep.map((x) => x.c), colWeight: keep.map((x) => x.w) }
}

/**
 * Move `dragged` next to `target`, above it or below it.
 *
 * Above and below rather than a single "swap": the whole point of the last
 * column is that two panels stack in it, and that needs a way to say which one
 * goes on top.
 */
export function moveTo(l: Layout, dragged: PanelId, target: PanelId, side: 'above' | 'below'): Layout {
  if (dragged === target) return l
  const col = l.columns.findIndex((c) => c.includes(target))
  if (col === -1) return l
  const columns = without(l.columns, dragged)
  const at = columns[col].indexOf(target)
  columns[col].splice(side === 'above' ? at : at + 1, 0, dragged)
  return compact(l, columns)
}

/** Lift `dragged` into a column of its own at `index`. */
export function moveToNewColumn(l: Layout, dragged: PanelId, index: number): Layout {
  const from = l.columns.findIndex((c) => c.includes(dragged))
  // Already alone in the column it would land in: nothing to do, and doing it
  // anyway would renumber every weight for no change.
  if (from !== -1 && l.columns[from].length === 1 && (from === index || from === index - 1)) return l
  const columns = without(l.columns, dragged)
  const at = clamp(index, 0, columns.length)
  columns.splice(at, 0, [dragged])
  const colWeight = [...l.colWeight]
  colWeight.splice(at, 0, 1)
  return compact({ ...l, colWeight }, columns)
}

export const toggle = (l: Layout, id: PanelId): Layout => ({
  ...l,
  hidden: l.hidden.includes(id) ? l.hidden.filter((p) => p !== id) : [...l.hidden, id]
})

/**
 * Drag the divider between two columns. `delta` is the fraction of the two
 * columns' own width that the boundary moved; the pair keeps its combined
 * weight, so columns further along do not shift while one edge is dragged.
 *
 * Both indices are given rather than `left` and `left + 1`: with a column
 * hidden, the two columns either side of a divider are not adjacent in storage,
 * and assuming they were resized a pair nobody was touching.
 */
export function resizeColumns(l: Layout, left: number, right: number, delta: number): Layout {
  const a = l.colWeight[left]
  const b = l.colWeight[right]
  if (a === undefined || b === undefined || left === right) return l
  const total = a + b
  const next = clamp(a + delta * total, total * MIN_SHARE, total * (1 - MIN_SHARE))
  const colWeight = [...l.colWeight]
  colWeight[left] = next
  colWeight[right] = total - next
  return { ...l, colWeight }
}

/** The same, vertically, between two panels stacked in one column. `delta` is
 *  the fraction of the pair's own height, for the same reason. */
export function resizeRows(l: Layout, above: PanelId, below: PanelId, delta: number): Layout {
  const total = l.rowWeight[above] + l.rowWeight[below]
  const next = clamp(l.rowWeight[above] + delta * total, total * MIN_SHARE, total * (1 - MIN_SHARE))
  return { ...l, rowWeight: { ...l.rowWeight, [above]: next, [below]: total - next } }
}
