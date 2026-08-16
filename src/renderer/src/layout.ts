/**
 * Which panels are on screen, where, and how big.
 *
 * Two bands stacked vertically, each a row of panels. A panel that is wide and
 * short - the office floor, a file list - costs the work above it nothing when
 * it sits in the bottom band, where a column of the same panel would take a
 * third of the window's width for something that needs none of it.
 *
 * Not a general layout tree: a tree buys arbitrary nesting and costs split
 * ratios, drop zones on four edges per node, and a recursive renderer. Two
 * bands answer "put the floor underneath" without any of that.
 */
export const PANELS = ['roster', 'command', 'code', 'floor'] as const
export type PanelId = (typeof PANELS)[number]
export type Band = 'top' | 'bottom'

export type Layout = {
  /** Left to right within each band. Every visible panel is in exactly one. */
  top: PanelId[]
  bottom: PanelId[]
  /** Switched off. Which band it came from is remembered while hidden. */
  hidden: PanelId[]
  /** Relative width inside a band. Only ratios matter, not the units. */
  weight: Record<PanelId, number>
  /** Share of the window height the bottom band takes, 10-80. */
  bottomPct: number
}

export const PANEL_TITLE: Record<PanelId, string> = {
  roster: 'roster',
  command: 'command center',
  code: 'code',
  floor: 'office floor'
}

export const MIN_BOTTOM = 10
export const MAX_BOTTOM = 80

/**
 * The work sits on top; the floor and the file list sit under it, where being
 * wide and short is what they want anyway.
 */
export const DEFAULT_LAYOUT: Layout = {
  top: ['roster', 'command'],
  bottom: ['code', 'floor'],
  hidden: [],
  weight: { roster: 0.22, command: 1, code: 1.4, floor: 1 },
  bottomPct: 40
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/**
 * Accept whatever was persisted without trusting it. A config written by an
 * older build, or by hand, must not leave a panel unreachable, duplicated, or
 * sized to nothing.
 */
export function normalise(raw: unknown): Layout {
  const l = (raw ?? {}) as Partial<Layout>
  const seen = new Set<PanelId>()
  const band = (v: unknown): PanelId[] => {
    const out: PanelId[] = []
    for (const p of Array.isArray(v) ? v : []) {
      if (PANELS.includes(p as PanelId) && !seen.has(p as PanelId)) {
        seen.add(p as PanelId)
        out.push(p as PanelId)
      }
    }
    return out
  }
  const top = band(l.top)
  const bottom = band(l.bottom)
  // A panel the persisted layout never mentions goes back where it started,
  // rather than vanishing with no toggle able to bring it back.
  for (const p of PANELS) {
    if (seen.has(p)) continue
    ;(DEFAULT_LAYOUT.bottom.includes(p) ? bottom : top).push(p)
  }

  const hidden = [
    ...new Set(
      (Array.isArray(l.hidden) ? l.hidden : []).filter((p): p is PanelId =>
        PANELS.includes(p as PanelId)
      )
    )
  ]

  const weight = { ...DEFAULT_LAYOUT.weight }
  for (const p of PANELS) {
    const w = (l.weight ?? {})[p]
    // Zero or negative would collapse a panel with no handle left to drag back.
    if (typeof w === 'number' && Number.isFinite(w) && w > 0.02) weight[p] = w
  }

  return {
    top,
    bottom,
    // Hiding everything leaves a window with nothing in it; the toggles are in
    // the titlebar, but there would be no reason left to trust that.
    hidden: hidden.length === PANELS.length ? [] : hidden,
    weight,
    bottomPct: clamp(
      typeof l.bottomPct === 'number' && Number.isFinite(l.bottomPct)
        ? l.bottomPct
        : DEFAULT_LAYOUT.bottomPct,
      MIN_BOTTOM,
      MAX_BOTTOM
    )
  }
}

export const bandOf = (l: Layout, id: PanelId): Band => (l.bottom.includes(id) ? 'bottom' : 'top')

export const visible = (l: Layout, b: Band): PanelId[] =>
  l[b].filter((p) => !l.hidden.includes(p))

/**
 * Move `dragged` so it sits where `target` sits. Dropping onto a panel in the
 * other band moves it between bands, which is the only way a panel changes band.
 */
export function move(l: Layout, dragged: PanelId, target: PanelId): Layout {
  if (dragged === target) return l
  const to = bandOf(l, target)
  const top = l.top.filter((p) => p !== dragged)
  const bottom = l.bottom.filter((p) => p !== dragged)
  const dest = to === 'top' ? top : bottom
  const at = dest.indexOf(target)
  if (at === -1) return l
  dest.splice(at, 0, dragged)
  return { ...l, top, bottom }
}

/** Move a panel to the end of a band. The only way into an empty band. */
export function moveToBand(l: Layout, dragged: PanelId, to: Band): Layout {
  if (bandOf(l, dragged) === to && l[to].at(-1) === dragged) return l
  const top = l.top.filter((p) => p !== dragged)
  const bottom = l.bottom.filter((p) => p !== dragged)
  ;(to === 'top' ? top : bottom).push(dragged)
  return { ...l, top, bottom }
}

export const toggle = (l: Layout, id: PanelId): Layout => ({
  ...l,
  hidden: l.hidden.includes(id) ? l.hidden.filter((p) => p !== id) : [...l.hidden, id]
})

/**
 * Drag a divider: `delta` is the fraction of the band's width the boundary
 * moved. The pair keeps its combined weight, so panels further along the row do
 * not shift while you are dragging one edge.
 */
export function resize(l: Layout, left: PanelId, right: PanelId, delta: number): Layout {
  const total = l.weight[left] + l.weight[right]
  const nextLeft = clamp(l.weight[left] + delta * total, total * 0.08, total * 0.92)
  return { ...l, weight: { ...l.weight, [left]: nextLeft, [right]: total - nextLeft } }
}

export const setBottomPct = (l: Layout, pct: number): Layout => ({
  ...l,
  bottomPct: clamp(pct, MIN_BOTTOM, MAX_BOTTOM)
})
