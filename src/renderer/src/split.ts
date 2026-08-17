/**
 * Columns of stacks, and the four things you can do to them.
 *
 * One nesting level, deliberately: left-to-right columns, each a top-to-bottom
 * stack. It is what the panel layout already is, and it is enough to arrange
 * terminals without a recursive tree, per-node ratios, or drop zones on every
 * edge of every node. Ids are opaque strings so the same code arranges panels
 * and shells - the rules are about geometry, not about what is being arranged.
 */
export type Grid = {
  columns: string[][]
  /** Relative widths, aligned to `columns`. Only ratios matter. */
  colWeight: number[]
  /** Relative height inside its column. Ignored for a column of one. */
  rowWeight: Record<string, number>
}

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** Smallest share a cell may be dragged to and still have a grip to drag back. */
export const MIN_SHARE = 0.08

const without = (columns: string[][], id: string): string[][] =>
  columns.map((c) => c.filter((p) => p !== id))

/** Drop empty columns and keep the weights aligned to what is left. */
export function compact(g: Grid, columns: string[][]): Grid {
  const keep = columns.map((c, i) => ({ c, w: g.colWeight[i] ?? 1 })).filter((x) => x.c.length)
  return { ...g, columns: keep.map((x) => x.c), colWeight: keep.map((x) => x.w) }
}

/**
 * Move `dragged` next to `target`, above it or below it.
 *
 * Above and below rather than a single "swap": the point of a stack is choosing
 * which one is on top.
 */
export function moveTo(g: Grid, dragged: string, target: string, side: 'above' | 'below'): Grid {
  if (dragged === target) return g
  const col = g.columns.findIndex((c) => c.includes(target))
  if (col === -1) return g
  const columns = without(g.columns, dragged)
  const at = columns[col].indexOf(target)
  columns[col].splice(side === 'above' ? at : at + 1, 0, dragged)
  return compact(g, columns)
}

/** Lift `dragged` into a column of its own at `index`. */
export function moveToNewColumn(g: Grid, dragged: string, index: number): Grid {
  const from = g.columns.findIndex((c) => c.includes(dragged))
  // Already alone in the column it would land in: nothing to do, and doing it
  // anyway would renumber every weight for no change.
  if (from !== -1 && g.columns[from].length === 1 && (from === index || from === index - 1)) return g
  const columns = without(g.columns, dragged)
  const at = clamp(index, 0, columns.length)
  columns.splice(at, 0, [dragged])
  const colWeight = [...g.colWeight]
  colWeight.splice(at, 0, 1)
  return compact({ ...g, colWeight }, columns)
}

/**
 * Drag the divider between two columns. `delta` is the fraction of those two
 * columns' own width that the boundary moved; the pair keeps its combined
 * weight, so columns further along do not shift while one edge is dragged.
 *
 * Both indices are given rather than `left` and `left + 1`: with something
 * hidden between them the two columns either side of a divider are not adjacent
 * in storage, and assuming they were resized a pair nobody was touching.
 */
export function resizeColumns(g: Grid, left: number, right: number, delta: number): Grid {
  const a = g.colWeight[left]
  const b = g.colWeight[right]
  if (a === undefined || b === undefined || left === right) return g
  const total = a + b
  const next = clamp(a + delta * total, total * MIN_SHARE, total * (1 - MIN_SHARE))
  const colWeight = [...g.colWeight]
  colWeight[left] = next
  colWeight[right] = total - next
  return { ...g, colWeight }
}

/** The same, vertically, between two cells stacked in one column. */
export function resizeRows(g: Grid, above: string, below: string, delta: number): Grid {
  const total = (g.rowWeight[above] ?? 1) + (g.rowWeight[below] ?? 1)
  const next = clamp((g.rowWeight[above] ?? 1) + delta * total, total * MIN_SHARE, total * (1 - MIN_SHARE))
  return { ...g, rowWeight: { ...g.rowWeight, [above]: next, [below]: total - next } }
}

/** Append a cell as a column of its own, on the right. */
export function addColumn(g: Grid, id: string): Grid {
  if (g.columns.some((c) => c.includes(id))) return g
  return {
    columns: [...g.columns, [id]],
    colWeight: [...g.colWeight, 1],
    rowWeight: { ...g.rowWeight, [id]: 1 }
  }
}

/** Take a cell out. An emptied column goes with it rather than leaving a gap. */
export function remove(g: Grid, id: string): Grid {
  const rowWeight = { ...g.rowWeight }
  delete rowWeight[id]
  return { ...compact(g, without(g.columns, id)), rowWeight }
}

export const EMPTY: Grid = { columns: [], colWeight: [], rowWeight: {} }
