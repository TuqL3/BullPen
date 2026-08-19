import { useEffect, useRef, useState } from 'react'
import type { WorkflowInfo } from '../../preload/index'
import {
  anchor,
  connect,
  disconnect,
  edges,
  LABEL_H,
  layout,
  NODE_H,
  NODE_W,
  readTalk,
  writeTalk,
  type ChartNode
} from './chart'
import { readBrief, writeBrief } from '../../brief'
import { useStore } from './store'
import { LABEL, MONO } from './theme'

/**
 * The floor, built by dragging.
 *
 * Everything about a floor used to be a tab: roles here, capabilities there,
 * the board somewhere else, and the card rules in a fourth place - six screens
 * describing one thing, and a person expected to hold the shape in their head
 * while moving between them.
 *
 * One screen instead. The chart is the floor; whatever is selected is what the
 * panel on the right edits. Add a box, drag a line, fill in the panel, save -
 * and what gets written is still the same markdown file, because that is what
 * the router reads and what you would hand to somebody else.
 */
export function OrgChart({
  workflow,
  onApplied
}: {
  workflow: WorkflowInfo | null
  onApplied: (w: WorkflowInfo, markdown?: string) => void
}) {
  /** The whole floor, edited in one place and saved in one go. */
  const [draft, setDraft] = useState<WorkflowInfo | null>(workflow)
  const [nodes, setNodes] = useState<ChartNode[]>([])
  /**
   * What is open, and where.
   *
   * A panel down the side was on screen whether or not anybody was editing
   * anything - a column of boxes describing the floor next to a drawing of the
   * same floor. Now nothing is open until something is clicked, and what opens
   * appears where the click was.
   */
  const [panel, setPanel] = useState<
    | {
        kind: 'role' | 'file' | 'edge' | 'floors' | 'try'
        id?: string
        to?: string
        x: number
        y: number
      }
    | null
  >(null)
  /** Right-click: what can be done here, at the pointer. */
  const [menu, setMenu] = useState<{ x: number; y: number; role?: string } | null>(null)
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null)
  const [wire, setWire] = useState<{ from: string; x: number; y: number } | null>(null)
  const [note, setNote] = useState('')
  /** Whether the file is open beside the drawing. */
  const [reading, setReading] = useState(false)
  /**
   * Where the canvas is being looked at from: scale, and the corner it starts
   * at. Scrollbars are the wrong instrument for a drawing - they move one axis
   * at a time and cannot make anything smaller - so the middle button drags it
   * around and the wheel zooms, the way every other canvas works.
   */
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 })
  const [pan, setPan] = useState<{ x: number; y: number } | null>(null)
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [error, setError] = useState('')
  const svg = useRef<SVGSVGElement>(null)
  const board = useRef<HTMLDivElement>(null)
  const gesture = useRef(false)

  /**
   * Where the boxes were left last time.
   *
   * Laying the floor out from scratch on every open is correct and unhelpful:
   * somebody arranges twelve boxes the way they think about them, closes the
   * dialog, and opens it to find the arrangement gone. The positions live in
   * this machine's config, per floor - not in the workflow, which describes an
   * organisation and should not carry one screen's idea of where it sits.
   */
  useEffect(() => {
    let live = true
    ;(async () => {
      const prefs = await window.bullpen.uiPrefs()
      if (!live) return
      const saved = prefs.chart?.[workflow?.name ?? ''] ?? {}
      const seen = prefs.view?.[workflow?.name ?? '']
      setDraft(workflow)
      setNodes(layout(workflow).map((n) => ({ ...n, ...(saved[n.id] ?? {}) })))
      if (seen) setView(seen)
    })()
    return () => {
      live = false
    }
  }, [workflow])

  /** And where it was being looked at from, so a zoom survives the dialog. */
  const rememberView = (next: { k: number; tx: number; ty: number }): void => {
    const name = draft?.name ?? workflow?.name
    if (name) window.bullpen.setUiPrefs({ view: { [name]: next } })
  }

  /** Remember them as they are put down, not on some later save. */
  const remember = (placed: ChartNode[]): void => {
    const name = draft?.name ?? workflow?.name
    if (!name) return
    const where = Object.fromEntries(placed.map((n) => [n.id, { x: Math.round(n.x), y: Math.round(n.y) }]))
    window.bullpen.setUiPrefs({ chart: { [name]: where } })
  }

  if (!draft) return <div style={S.wrap} />

  const set = (patch: Partial<WorkflowInfo>): void => setDraft({ ...draft, ...patch })

  /**
   * Lay a floor out again without losing where anything was put.
   *
   * A box that is already on screen keeps its spot; one that has just appeared
   * - or come back, which is what undo does - gets the spot the layout would
   * give it. Undo used to restore the floor and not the drawing, so an undone
   * delete left the role in the file with no box anywhere.
   */
  const relayout = (w: WorkflowInfo): void => {
    setNodes((was) => {
      const kept = new Map(was.map((n) => [n.id, n]))
      return layout(w).map((n) => {
        const had = kept.get(n.id)
        return had ? { ...n, x: had.x, y: had.y } : n
      })
    })
  }

  /**
   * The other direction: what was typed in the file becomes the drawing.
   *
   * Half-typed text does not parse, and a parse that fails is left alone rather
   * than shown as an error - they are mid-word, not wrong.
   */
  const fromText = (markdown: string, said: (ok: boolean, problems: string[]) => void): void => {
    if (typing.current) clearTimeout(typing.current)
    typing.current = setTimeout(() => {
      window.bullpen.lintWorkflow(markdown).then((r) => {
        said(Boolean(r.preview), r.problems ?? [])
        if (!r.preview) return
        setDraft(r.preview)
        relayout(r.preview)
      })
    }, 400)
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(workflow)
  const at = (id: string): ChartNode | undefined => nodes.find((n) => n.id === id)

  const point = (e: React.PointerEvent): { x: number; y: number } => {
    // The rect is already scaled, so the offset into it is too: divide it back
    // out and the answer is in the drawing's own coordinates, at any zoom.
    const box = svg.current?.getBoundingClientRect()
    return {
      x: (e.clientX - (box?.left ?? 0)) / view.k - 30 + off.x,
      y: (e.clientY - (box?.top ?? 0)) / view.k - 30 + off.y
    }
  }

  /**
   * Everything on screen at once.
   *
   * Panning has no edges - the canvas is as big as somebody drags it - so the
   * one thing that must always work is getting back. This is that.
   */
  const fit = (): void => {
    const box = board.current?.getBoundingClientRect()
    if (!box || !nodes.length) return setView({ k: 1, tx: 0, ty: 0 })
    // The whole box the drawing occupies, which since boxes drag anywhere can
    // start left of and above the origin.
    const at = { x: Math.min(0, ...nodes.map((n) => n.x)), y: Math.min(0, ...nodes.map((n) => n.y)) }
    const left = Math.min(...nodes.map((n) => n.x)) - at.x + 30
    const top = Math.min(...nodes.map((n) => n.y)) - at.y + 30
    const right = Math.max(...nodes.map((n) => n.x)) - at.x + NODE_W + 60
    const bottom = Math.max(...nodes.map((n) => n.y)) - at.y + NODE_H + LABEL_H + 60
    const k = Math.min(1, box.width / (right - left), box.height / (bottom - top))
    const next = { k, tx: -left * k + 12, ty: -top * k + 12 }
    setView(next)
    rememberView(next)
  }

  /** Zoom about the pointer, so what is under it stays under it. */
  const zoom = (e: React.WheelEvent): void => {
    const box = e.currentTarget.getBoundingClientRect()
    const at = { x: e.clientX - box.left, y: e.clientY - box.top }
    const k = Math.min(2.5, Math.max(0.3, view.k * (1 - e.deltaY / 600)))
    const next = {
      k,
      tx: at.x - ((at.x - view.tx) / view.k) * k,
      ty: at.y - ((at.y - view.ty) / view.k) * k
    }
    setView(next)
    rememberView(next)
  }

  const move = (e: React.PointerEvent): void => {
    const p = point(e)
    if (drag || wire) gesture.current = true
    if (drag) {
      const x = p.x - drag.dx
      const y = p.y - drag.dy
      setNodes(nodes.map((n) => (n.id === drag.id ? { ...n, x, y } : n)))
    } else if (wire) setWire({ ...wire, x: p.x, y: p.y })
  }

  const drop = (e: React.PointerEvent): void => {
    if (wire) {
      const p = point(e)
      // The tile and its name, plus a margin. A 64-pixel square is a small
      // thing to let go of a line on, and letting go two pixels under it - on
      // the name, which reads as part of the box - did nothing at all.
      const near = 16
      const hit = nodes.find(
        (n) =>
          p.x >= n.x - near &&
          p.x <= n.x + NODE_W + near &&
          p.y >= n.y - near &&
          p.y <= n.y + NODE_H + LABEL_H + near
      )
      if (hit && hit.id !== wire.from) set({ talksTo: connect(draft.talksTo, wire.from, hit.id) })
    }
    // Only when there was one. Setting state on every pointerup re-rendered the
    // drawing between the press and the release, and a browser does not raise
    // `click` when the element under the pointer has been replaced - so a line
    // could be pressed and released and never counted as clicked.
    if (drag) {
      setDrag(null)
      remember(nodes)
    }
    if (wire) setWire(null)
  }

  /** A new role, with enough in it to be a legal one. */
  const addRole = (): void => {
    const id = `role_${Object.keys(draft.roles).length + 1}`
    const builds = draft.capabilities[0]?.name
    set({
      roles: {
        ...draft.roles,
        [id]: {
          label: 'a new role',
          does: '',
          can: builds ? [builds] : [],
          hireable: true,
          brief: ''
        }
      },
      talksTo: { ...draft.talksTo, [id]: [] }
    })
    setNodes([...nodes, { id, label: 'a new role', kind: 'role', x: 40, y: 40 + nodes.length * 20 }])
    setPanel({ kind: 'role', id, x: 60, y: 60 })
  }

  const dropRole = (id: string): void => {
    const roles = { ...draft.roles }
    delete roles[id]
    const talksTo = Object.fromEntries(
      Object.entries(draft.talksTo)
        .filter(([from]) => from !== id)
        .map(([from, tos]) => [from, tos.filter((t) => t !== id)])
    )
    set({ roles, talksTo })
    setNodes(nodes.filter((n) => n.id !== id))
    setPanel(null)
  }

  const save = async (): Promise<void> => {
    setError('')
    setNote('')
    const res = await window.bullpen.patchWorkflow(staffed(draft))
    if (res.error) return setError(res.error)
    if (res.workflow) {
      onApplied(res.workflow, res.markdown)
      // Saved either way; what is unfinished is said, not enforced.
      setNote(
        res.problems?.length
          ? `Saved. Still unfinished: ${res.problems[0]}`
          : 'Saved. The file is written; the floor runs it.'
      )
    }
  }

  /**
   * Where the drawing starts, which is not always 0,0.
   *
   * Boxes drag anywhere, so the extent can begin left of and above the origin.
   * Everything painted is shifted by this much - the SVG cannot draw outside
   * its own box, and negative coordinates fall outside it.
   */
  const off = {
    x: Math.min(0, ...nodes.map((n) => n.x)),
    y: Math.min(0, ...nodes.map((n) => n.y))
  }

  /**
   * Hold the picture still when its origin moves.
   *
   * Dragging one box past the left edge shifts everything that is painted by
   * the same amount, so every other box appeared to jump sideways while one was
   * being moved. Taking the shift back out of the view leaves them where they
   * look like they are.
   */
  /**
   * Who is actually standing in each role right now.
   *
   * A box is a role; a session is a running Claude in one. They are not the
   * same thing and the drawing said nothing about the difference - a floor
   * where nobody has been hired yet looked exactly like one with four agents
   * on it. The dot on the tile is the answer: filled if somebody is there,
   * coloured by what they are doing.
   */
  const live = useStore((st) => st.agents)
  const sessions = (role: string): typeof live =>
    live.filter((a) => a.role === role && a.status === 'running')

  const wasOff = useRef(off)
  useEffect(() => {
    const dx = off.x - wasOff.current.x
    const dy = off.y - wasOff.current.y
    wasOff.current = off
    if (dx || dy) setView((v) => ({ ...v, tx: v.tx + dx * v.k, ty: v.ty + dy * v.k }))
  }, [off.x, off.y])

  /**
   * Whatever is open is what is selected, so `delete` deletes it.
   *
   * Removing a role meant open the box, scroll past the brief, find a button;
   * removing a line meant open the line and find another. Both are one key now,
   * and the panel that is open says which one it will take.
   */
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      const on = e.target as HTMLElement | null
      if (on && /^(INPUT|TEXTAREA)$/.test(on.tagName)) return
      if (e.key === 'Escape') return setPanel(null)
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (!panel) return
      if (panel.kind === 'role' && panel.id) {
        e.preventDefault()
        dropRole(panel.id)
      }
      if (panel.kind === 'edge' && panel.id && panel.to) {
        e.preventDefault()
        // Both ways: the dot is the line between two of them, and the line is
        // gone. The one arrow nobody drew - work arriving - stays.
        let talksTo = draft.talksTo
        if (panel.id !== draft.human) talksTo = disconnect(talksTo, panel.id, panel.to)
        if (panel.to !== draft.human) talksTo = disconnect(talksTo, panel.to, panel.id)
        set({ talksTo })
        setPanel(null)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const drawn = edges(draft)
  /**
   * One dot per pair, not per direction.
   *
   * Two roles that write to each other are one line on the drawing, and it had
   * two dots on it a few pixels apart opening two near-identical panels. What
   * somebody wants is what these two say to each other - both ways, in one
   * place - so the dot is the pair and the panel has a box per direction.
   */
  const pairs = ((): { from: string; to: string }[] => {
    const seen = new Set<string>()
    return drawn.filter(({ from, to }) => {
      const key = [from, to].sort().join('\u0000')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })()

  /** Where each line's handle sits, in the drawing's own coordinates. */
  const handles = pairs.flatMap(({ from, to }) => {
    const a = at(from)
    const b = at(to)
    if (!a || !b) return []
    const { x1, y1, x2, y2 } = anchor(a, b)
    const mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }
    // A node takes up its tile *and* the two lines of name under it, and a
    // handle that lands there sits in the middle of somebody's label. Try the
    // midpoint, then a few places beside it, and take the first that is clear.
    const busy = (px: number, py: number): boolean =>
      nodes.some(
        (n) =>
          px > n.x - 14 &&
          px < n.x + NODE_W + 14 &&
          py > n.y - 14 &&
          py < n.y + NODE_H + LABEL_H + 6
      )
    const tries = [
      mid,
      { x: mid.x + NODE_W, y: mid.y },
      { x: mid.x - NODE_W, y: mid.y },
      { x: mid.x, y: mid.y + NODE_H + LABEL_H + 16 }
    ]
    const spot = tries.find((t) => !busy(t.x, t.y)) ?? tries[3]
    const { x, y } = spot
    // The first thing this pair says, if anything: the label on the line.
    const when = draft.cardRules.find(
      (r) =>
        r.when &&
        ((matchesRole(draft, from, r.from) && matchesRole(draft, to, r.to)) ||
          (matchesRole(draft, to, r.from) && matchesRole(draft, from, r.to)))
    )?.when
    return [{ from, to, x, y, when }]
  })

  return (
    <div style={S.wrap}>
      <div style={S.bar}>
        <span style={{ color: 'var(--faint)', flex: 1 }}>
          Click a box or a line to open it, <kbd>delete</kbd> to take it off. Drag from the dot on
          a box to whoever it may write to. Right-click for a new one, double-click the background
          to fit everything on screen.
        </span>
        {error && <span style={{ color: 'var(--danger)' }}>{error.split('\n')[0]}</span>}
        {note && !dirty && (
          <span style={{ color: note.startsWith('Saved. Still') ? 'var(--muted)' : 'var(--ok)' }}>
            {note}
          </span>
        )}
        <button
          style={{ ...S.btn, ...(reading ? S.btnOn : {}) }}
          onClick={() => setReading(!reading)}
        >
          read it
        </button>
        <button style={S.btn} onClick={() => setPanel({ kind: 'floors', x: 40, y: 40 })}>
          floors
        </button>
        {dirty && (
          <>
            <button
              style={S.btn}
              onClick={() => {
                setDraft(workflow)
                if (workflow) relayout(workflow)
                setPanel(null)
              }}
            >
              undo
            </button>
            <button style={{ ...S.btn, ...S.btnGo }} onClick={save}>
              save the floor
            </button>
          </>
        )}
      </div>

      <div style={S.body}>
        <div
          ref={board}
          style={{ ...S.board, cursor: pan ? 'grabbing' : 'default' }}
          onWheel={zoom}
          onDoubleClick={fit}
          onPointerDown={(e) => {
            if (e.button !== 1) return
            e.preventDefault()
            setPan({ x: e.clientX - view.tx, y: e.clientY - view.ty })
          }}
          onPointerMove={(e) => {
            if (!pan) return
            setView({ ...view, tx: e.clientX - pan.x, ty: e.clientY - pan.y })
          }}
          onPointerUp={() => {
            if (pan) rememberView(view)
            setPan(null)
          }}
          onPointerLeave={() => {
            if (pan) rememberView(view)
            setPan(null)
          }}
          onClick={() => {
            setMenu(null)
            if (!gesture.current) setPanel(null)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            const box = e.currentTarget.getBoundingClientRect()
            setMenu({ x: e.clientX - box.left, y: e.clientY - box.top })
          }}
        >
          <div
            style={{
              transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`,
              transformOrigin: '0 0',
              width: 'max-content'
            }}
          >
          <svg
            ref={svg}
            width={Math.max(700, ...nodes.map((n) => n.x - off.x + NODE_W + 90))}
            height={Math.max(340, ...nodes.map((n) => n.y - off.y + NODE_H + 90))}
            onPointerMove={move}
            onPointerUp={drop}
            onPointerLeave={drop}
            style={{ display: 'block', touchAction: 'none' }}
          >
            <defs>
              <marker
                id="head"
                markerUnits="userSpaceOnUse"
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8 z" fill="var(--faint)" />
              </marker>
              {/* The same head, pointing back the way the line came. A pair who
                  write to each other is one line that means both, and drawn
                  with one arrow it read as a one-way street. */}
              <marker
                id="tail"
                markerUnits="userSpaceOnUse"
                markerWidth="8"
                markerHeight="8"
                refX="1"
                refY="4"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L8,4 L0,8 z" fill="var(--faint)" />
              </marker>
            </defs>
            <g transform={`translate(${30 - off.x},${30 - off.y})`}>
              {pairs.map(({ from, to }) => {
                const a = at(from)
                const b = at(to)
                if (!a || !b) return null
                const { x1, y1, x2, y2 } = anchor(a, b)
                const bend = (x1 + x2) / 2
                const d = `M${x1},${y1} C${bend},${y1} ${bend},${y2} ${x2},${y2}`
                // A line says these two may write to each other; an arrow at
                // each end says which of them actually does.
                const back = drawn.some((e) => e.from === to && e.to === from)
                return (
                  <g key={`${from}->${to}`}>
                    <path
                      d={d}
                      fill="none"
                      stroke="var(--faint)"
                      strokeWidth={1.5}
                      markerEnd="url(#head)"
                      markerStart={back ? 'url(#tail)' : undefined}
                      pointerEvents="none"
                    />
                  </g>
                )
              })}

              {wire &&
                (() => {
                  const a = at(wire.from)
                  if (!a) return null
                  return (
                    <line
                      x1={a.x + NODE_W}
                      y1={a.y + NODE_H / 2}
                      x2={wire.x}
                      y2={wire.y}
                      stroke="var(--accent-ink)"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      pointerEvents="none"
                    />
                  )
                })()}

              {nodes.map((n) => {
                const def = draft.roles[n.id]
                const open = panel?.kind === 'role' && panel.id === n.id
                return (
                  <g key={n.id} transform={`translate(${n.x},${n.y})`}>
                    <rect
                      width={NODE_W}
                      height={NODE_H}
                      rx={10}
                      fill={n.kind === 'role' ? 'var(--panel)' : 'var(--sunk)'}
                      stroke={open ? 'var(--accent-ink)' : 'var(--line)'}
                      strokeWidth={open ? 2 : 1}
                      // `you` and `hire` are addresses, not people: a dashed
                      // outline says the tile is a thing the floor can write
                      // to rather than somebody standing there.
                      strokeDasharray={n.kind === 'role' ? undefined : '4 3'}
                      style={{ cursor: 'grab' }}
                      onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId)
                        const p = point(e)
                        setDrag({ id: n.id, dx: p.x - n.x, dy: p.y - n.y })
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (gesture.current) {
                          gesture.current = false
                          return
                        }
                        // Only people have anything to open. `you` is where
                        // the work comes from on every floor there is.
                        if (n.kind === 'role') {
                          setPanel({
                            kind: 'role',
                            id: n.id,
                            x: (n.x - off.x + NODE_W + 40) * view.k + view.tx,
                            y: (n.y - off.y) * view.k + view.ty
                          })
                        }
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setMenu({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY, role: n.id })
                      }}
                    />
                    {/* Who is in this role, if anybody: one dot per running
                        session, coloured by what it is doing. Two dots means
                        two Claudes are doing this job right now. */}
                    {n.kind === 'role' &&
                      sessions(n.id)
                        .slice(0, 4)
                        .map((a, i) => (
                          <circle
                            key={a.id}
                            cx={11 + i * 9}
                            cy={10}
                            r={3}
                            fill={
                              a.activity === 'working'
                                ? 'var(--accent-ink)'
                                : a.activity === 'blocked'
                                  ? 'var(--danger)'
                                  : 'var(--ok)'
                            }
                            pointerEvents="none"
                          />
                        ))}
                    {n.kind === 'role' && (
                      <title>
                        {sessions(n.id).length
                          ? sessions(n.id)
                              .map(
                                (a) =>
                                  `${a.name || a.id} · ${a.activity}${a.ctx ? ` · ${a.ctx.pct}%` : ''}`
                              )
                              .join('\n')
                          : 'nobody here yet - somebody is hired when there is work for this role'}
                      </title>
                    )}
                    {/* One letter rather than an icon set: this app draws its
                        own pixels and has no library of glyphs for jobs nobody
                        has invented yet. */}
                    <text
                      x={NODE_W / 2}
                      y={NODE_H / 2 + (n.kind === 'role' ? 8 : 5)}
                      style={n.kind === 'role' ? S.glyph : S.mark}
                      pointerEvents="none"
                    >
                      {n.kind === 'role' ? (n.id[0] ?? '?').toUpperCase() : '☞'}
                    </text>
                    {/* What they are called first, in the words somebody
                        actually says out loud; the id underneath, because it is
                        what a brief writes to and what the file calls them. */}
                    <text x={NODE_W / 2} y={NODE_H + 16} style={S.name} pointerEvents="none">
                      {(def?.label ?? n.label).slice(0, 24)}
                    </text>
                    <text x={NODE_W / 2} y={NODE_H + 30} style={S.what} pointerEvents="none">
                      {n.id}
                    </text>
                    {n.kind !== 'human' && (
                      <circle
                        cx={NODE_W}
                        cy={NODE_H / 2}
                        r={5}
                        fill="var(--accent-ink)"
                        style={{ cursor: 'crosshair' }}
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          e.currentTarget.setPointerCapture(e.pointerId)
                          const p = point(e)
                          setWire({ from: n.id, x: p.x, y: p.y })
                        }}
                      >
                        <title>drag to whoever this one may write to</title>
                      </circle>
                    )}
                    <circle
                      cx={0}
                      cy={NODE_H / 2}
                      r={4}
                      fill="var(--sunk)"
                      stroke="var(--line)"
                      pointerEvents="none"
                    />
                  </g>
                )
              })}
            </g>
          </svg>

          {/* The handles, as buttons over the drawing.
              Inside the SVG they took the pointer and never produced a click -
              press and release both landed, `click` never did - so the one
              thing on this canvas nothing could open was the flow itself. An
              HTML button is not clever, and it works. */}
          {/* What the line is for, beside it: the rule's own words. */}
          {handles.map(({ from, to, x, y, when }) =>
            when ? (
              <span
                key={`${from}->${to}:label`}
                style={{ ...S.edgeLabel, left: x - off.x + 44, top: y - off.y + 22 }}
              >
                {when}
              </span>
            ) : null
          )}
          {handles.map(({ from, to, x, y }) => (
            <button
              key={`${from}->${to}`}
              title={`${from} → ${to} · click to say how they talk`}
              style={{
                ...S.handle,
                left: x - off.x + 30 - 9,
                top: y - off.y + 30 - 9,
                borderColor:
                  panel?.kind === 'edge' && panel.id === from && panel.to === to
                    ? 'var(--accent-ink)'
                    : 'var(--line)'
              }}
              onClick={(e) => {
                e.stopPropagation()
                setPanel({
                  kind: 'edge',
                  id: from,
                  to,
                  x: (x - off.x + 26) * view.k + view.tx,
                  y: (y - off.y) * view.k + view.ty
                })
              }}
            />
          ))}
          </div>

          {menu && (
            <div
              style={{ ...S.menu, left: menu.x, top: menu.y }}
              onWheel={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {menu.role ? (
                <>
                  <button
                    style={S.menuItem}
                    onClick={() => {
                      setPanel({ kind: 'role', id: menu.role, x: menu.x + 10, y: menu.y })
                      setMenu(null)
                    }}
                  >
                    what this one does…
                  </button>
                  <button
                    style={S.menuItem}
                    onClick={() => {
                      dropRole(menu.role as string)
                      setMenu(null)
                    }}
                  >
                    remove it
                  </button>
                </>
              ) : (
                <>
                  <button
                    style={S.menuItem}
                    onClick={() => {
                      addRole()
                      setMenu(null)
                    }}
                  >
                    add a role
                  </button>
                  <button
                    style={S.menuItem}
                    onClick={() => {
                      setPanel({ kind: 'try', x: menu.x, y: menu.y })
                      setMenu(null)
                    }}
                  >
                    try a task…
                  </button>
                  <button
                    style={S.menuItem}
                    onClick={() => {
                      const fresh = layout(draft)
                      setNodes(fresh)
                      remember(fresh)
                      setMenu(null)
                    }}
                  >
                    tidy up
                  </button>
                </>
              )}
            </div>
          )}

          {panel && (
            <div
              style={{
                ...S.panel,
                // The floors are cards with a floor drawn on each, and they
                // wrap to three lines in a column meant for a form.
                width: panel.kind === 'floors' ? 420 : PANEL_W,
                left: Math.max(
                  8,
                  Math.min(
                    panel.x,
                    (board.current?.clientWidth ?? 700) -
                      (panel.kind === 'floors' ? 420 : PANEL_W) -
                      8
                  )
                ),
                top: Math.max(
                  8,
                  Math.min(panel.y, (board.current?.clientHeight ?? 500) - PANEL_H - 8)
                )
              }}
              onWheel={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.stopPropagation()}
            >
              <button style={S.close} title="close" onClick={() => setPanel(null)}>
                ×
              </button>
              {panel.kind === 'try' ? (
                <TryPanel dirty={dirty} />
              ) : panel.kind === 'floors' ? (
                <FloorsPanel
                  running={draft.name}
                  dirty={dirty}
                  onRan={(w, md) => {
                    onApplied(w, md)
                    setPanel(null)
                  }}
                />
              ) : panel.kind === 'edge' && panel.id && panel.to ? (
                <TalkInspector
                  // Per pair, so the box is re-read when another line is
                  // clicked: without it React keeps the same instance, the
                  // text state never re-initialises, and the second line
                  // opened shows the first one's rules.
                  key={`${panel.id}->${panel.to}`}
                  floor={draft}
                  from={panel.id}
                  to={panel.to}
                  onChange={set}
                />
              ) : panel.id && draft.roles[panel.id] ? (
                <RoleInspector floor={draft} role={panel.id} onChange={set} />
              ) : null}
            </div>
          )}
        </div>

        {/* The file, beside the drawing rather than over it: reading it while
            moving a box is the point, and a panel that covers the canvas has
            to be closed before the next change can be made. */}
        {reading && (
          <div style={S.side}>
            <FilePanel
              floor={staffed(draft)}
              onText={fromText}
              onClose={() => setReading(false)}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Who is standing on this floor when it opens, and who is hired when needed.
 *
 * Only the one the operator types at. Anybody else is a context window being
 * paid for before there is work for them - and work handed to a role that has
 * nobody in it now puts somebody in it, so standing them up in advance buys
 * nothing. A floor that genuinely wants three agents at launch can still say so
 * in the file; this is what the drawing means when it says nothing.
 */
function staffed(floor: WorkflowInfo): WorkflowInfo {
  const standing = new Set([floor.dispatch])
  const roles = Object.fromEntries(
    Object.entries(floor.roles).map(([id, def]) => {
      if (standing.has(id)) {
        return [
          id,
          { ...def, hireable: undefined, fixed: def.fixed ?? { id, name: def.label || id } }
        ]
      }
      return [id, { ...def, fixed: undefined, hireable: true }]
    })
  )
  return { ...floor, roles }
}

/**
 * One role: a name, and what it does. Nothing else.
 *
 * The panel here had eleven controls - capabilities to tick, who fills it, the
 * command it runs, tools it may not touch, two questions and a brief. Every one
 * of them was a decision somebody had to make before they could draw the second
 * box, and none of them is the thing they came to say, which is "this one
 * writes the piece" and "this one reads it".
 *
 * So: two boxes of text. Everything the router still needs is worked out when
 * the floor is saved - a role the human writes to needs an agent standing at
 * it, and everything else is hired - and anything past that is in the file for
 * whoever wants to open it.
 */
function RoleInspector({
  floor,
  role,
  onChange
}: {
  floor: WorkflowInfo
  role: string
  onChange: (patch: Partial<WorkflowInfo>) => void
}) {
  const def = floor.roles[role]
  const set = (patch: Partial<typeof def>): void =>
    onChange({ roles: { ...floor.roles, [role]: { ...def, ...patch } } })

  return (
    <div>
      <div style={{ ...LABEL, color: 'var(--accent-ink)' }}>{role}</div>

      <Row label="called">
        <input
          style={S.field}
          value={def.label}
          placeholder="a writer"
          onChange={(e) => set({ label: e.target.value })}
        />
      </Row>

      <div style={{ ...LABEL, marginTop: 8 }}>what this one does</div>
      <div style={{ color: 'var(--faint)', lineHeight: 1.6, margin: '2px 0 4px' }}>
        Written to them, not about them: what they are for, what they must not do, what they send
        when a task is finished, and who they send it to. The first line is what the floor shows
        everywhere else.
      </div>
      <textarea
        style={{ ...S.area, height: 240 }}
        value={def.brief}
        spellCheck={false}
        placeholder={
          'You write the piece the editor asks for.\n\n' +
          'One at a time: finish the one you were given, say so, and stop.\n\n' +
          'When it is done: {"from": "{{self.id}}", "to": "editor", "subject": "done: <the piece>", "body": "<what you wrote>"}\n\n' +
          'Say the same when you are stuck, and why.'
        }
        onChange={(e) => set({ brief: e.target.value, does: firstLine(e.target.value) })}
      />
      <div style={{ color: 'var(--faint)', marginTop: 8 }}>
        <kbd>delete</kbd> takes this one off the floor.
      </div>
    </div>
  )
}

/** The opening sentence, which is what a role is described by everywhere else. */
const firstLine = (brief: string): string =>
  brief
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
    ?.slice(0, 160) ?? ''

/**
 * The floor as the file it is.
 *
 * Everything the drawing does not show - what the work is called, what the
 * columns are, what a message does to a card - lives here rather than in a
 * panel of dropdowns beside the picture. Somebody who wants to change it can
 * read the whole floor in one place, and everybody else never opens it.
 */
function FilePanel({
  floor,
  onText,
  onClose
}: {
  floor: WorkflowInfo
  onText: (markdown: string, said: (ok: boolean, problems: string[]) => void) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [was, setWas] = useState('')
  const [problems, setProblems] = useState<string[]>([])
  const [error, setError] = useState('')
  /**
   * Whether they are typing in here right now.
   *
   * Both directions are live, which is two writers on one string: re-rendering
   * the file under somebody mid-word moves their cursor to the end. So the box
   * follows the drawing whenever it is not the thing being typed in, and the
   * drawing follows the box whenever it is.
   */
  const [writing, setWriting] = useState(false)
  /**
   * Whether the last thing typed here parsed.
   *
   * It must not be thrown away when it does not: half a file is what somebody
   * typing a file has, and re-rendering the drawing over it on blur would
   * delete the work and say nothing.
   */
  const [bad, setBad] = useState(false)

  useEffect(() => {
    if (writing || bad) return
    let live = true
    window.bullpen.previewWorkflow(floor).then((r) => {
      if (!live) return
      setText(r.markdown)
      setWas(r.markdown)
      setProblems(r.problems ?? [])
    })
    return () => {
      live = false
    }
  }, [floor, writing, bad])

  const save = async (): Promise<void> => {
    const res = await window.bullpen.setWorkflow(text)
    if (res.error) return setError(res.error)
    setWas(res.markdown ?? text)
    onClose()
    reopen()
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ ...LABEL, color: 'var(--accent-ink)' }}>the whole file</div>
      <div style={{ color: 'var(--faint)', lineHeight: 1.6, margin: '2px 0 6px' }}>
        The drawing, as it reads. Type in it and the drawing changes with it.
      </div>
      <textarea
        style={{ ...S.area, flex: 1, minHeight: 300 }}
        value={text}
        spellCheck={false}
        onFocus={() => setWriting(true)}
        onBlur={() => setWriting(false)}
        onChange={(e) => {
          setText(e.target.value)
          onText(e.target.value, (ok, said) => {
            setBad(!ok)
            setProblems(said)
          })
        }}
      />
      {error ? (
        <div style={{ color: 'var(--danger)', lineHeight: 1.6 }}>{error.split('\n')[0]}</div>
      ) : bad ? (
        <div style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
          {problems[0] ?? 'Not a floor yet - the drawing is waiting for this to read.'}
        </div>
      ) : problems.length ? (
        <div style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
          {problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      ) : null}
      <button
        style={{ ...S.btn, ...(text !== was ? S.btnGo : S.btnOff), marginTop: 6 }}
        disabled={text === was}
        onClick={save}
      >
        save the file
      </button>
    </div>
  )
}

/**
 * One task, walked through the floor without running it.
 *
 * The chart says who may write to whom; this says what actually happens when
 * somebody uses those lines - and it costs nothing, because it is the same two
 * functions the live floor uses, read out loud.
 */
function TryPanel({ dirty }: { dirty: boolean }) {
  const [task, setTask] = useState('')
  const [run, setRun] = useState<{
    steps?: { fromName: string; toName: string; says: string; card: string; refused?: string }[]
    ends?: string
    error?: string
  } | null>(null)

  const go = async (): Promise<void> => {
    const { markdown } = await window.bullpen.workflow()
    setRun(await window.bullpen.dryRunWorkflow(markdown, task))
  }

  return (
    <div>
      <div style={{ ...LABEL, color: 'var(--accent-ink)' }}>try a task</div>
      <div style={{ color: 'var(--faint)', lineHeight: 1.6, margin: '2px 0 6px' }}>
        Type something you would give this floor and see where it goes. Nothing runs - no agents,
        no model, no cost.
        {dirty && ' Unsaved changes are not included; save the floor first.'}
      </div>
      <div style={S.line}>
        <input
          style={S.field}
          value={task}
          placeholder="write the launch post"
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
        <button style={{ ...S.btn, ...S.btnGo }} onClick={go}>
          walk it
        </button>
      </div>
      {run?.error && <div style={{ color: 'var(--danger)' }}>{run.error.split('\n')[0]}</div>}
      {run?.steps?.map((step, i) => (
        <div key={i} style={{ ...S.line, alignItems: 'baseline' }}>
          <span style={{ color: 'var(--faint)', width: 14 }}>{i + 1}</span>
          <span style={{ color: 'var(--ink)', width: 150 }}>
            {step.fromName} → {step.toName}
          </span>
          <span style={{ color: step.refused ? 'var(--danger)' : 'var(--muted)', flex: 1 }}>
            {step.refused ?? step.card}
          </span>
        </div>
      ))}
      {run?.ends && <div style={{ color: 'var(--ok)', marginTop: 6 }}>· {run.ends}</div>}
    </div>
  )
}

/** The floors you have, and which one is running. */
/**
 * Take the whole window back to the floor that is now running.
 *
 * Applying a floor changes what every screen is about: the board's columns, who
 * is on the roster, what the router will allow. Main is told at once and the
 * agents follow (§28), but the renderer keeps whatever it read when it opened -
 * a task list under the old columns, a roster with roles this floor does not
 * have. Reloading is cheap here: main owns the agents and the terminals, and
 * nothing in the window is worth more than being right.
 */
const reopen = (): void => {
  setTimeout(() => window.location.reload(), 200)
}

function FloorsPanel({
  running,
  dirty,
  onRan
}: {
  running: string
  dirty: boolean
  onRan: (w: WorkflowInfo, markdown?: string) => void
}) {
  const [saved, setSaved] = useState<
    { name: string; description: string; markdown: string; builtin: boolean }[]
  >([])
  /** Each floor as a floor, not as a filename: what it looks like drawn. */
  const [shape, setShape] = useState<Record<string, WorkflowInfo>>({})
  const [said, setSaid] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const list = (): void => {
    window.bullpen.workflowList().then(async (all) => {
      setSaved(all)
      const read = await Promise.all(
        all.map(async (w) => [w.name, (await window.bullpen.lintWorkflow(w.markdown)).preview] as const)
      )
      setShape(Object.fromEntries(read.filter(([, w]) => w)) as Record<string, WorkflowInfo>)
    })
  }
  useEffect(list, [])

  const run = async (markdown: string): Promise<void> => {
    if (dirty && !confirm('The floor has unsaved changes. Switch anyway and lose them?')) return
    setError('')
    const res = await window.bullpen.setWorkflow(markdown)
    if (res.error) return setError(res.error)
    if (res.workflow) {
      onRan(res.workflow, res.markdown)
      reopen()
    }
  }

  /** A chart with the two parties every floor has, and nothing else. */
  const blank = async (): Promise<void> => {
    setBusy('new')
    await run(await window.bullpen.workflowBlank())
    setBusy('')
  }

  /**
   * Say what the floor does and let the model draw it.
   *
   * A real model turn, so it is slow and it can come back unfinished - the
   * problems are shown and the floor is applied anyway, because a drawing with
   * something missing is still faster to fix than a blank canvas.
   */
  const describe = async (): Promise<void> => {
    const want = said.trim()
    if (!want) return
    setBusy('describe')
    setError('')
    const res = await window.bullpen.generateWorkflow(want)
    setBusy('')
    if (res.error) return setError(res.error)
    if (res.markdown) {
      await run(res.markdown)
      setSaid('')
      list()
      if (res.problems?.length) setError(`Drawn, with something left: ${res.problems[0]}`)
    }
  }

  return (
    <div>
      <div style={{ ...LABEL, color: 'var(--accent-ink)' }}>another floor</div>
      <div style={{ color: 'var(--faint)', lineHeight: 1.6, margin: '2px 0 6px' }}>
        Switching changes what the app runs. Agents already up keep the shape they started on
        until they are restarted.
      </div>

      <textarea
        style={{ ...S.area, height: 62 }}
        value={said}
        spellCheck={false}
        placeholder="an editor who hands pieces to a writer, and a proofreader who lets them through"
        onChange={(e) => setSaid(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 6, margin: '6px 0 10px' }}>
        <button
          style={{ ...S.btn, ...(said.trim() ? S.btnGo : S.btnOff) }}
          disabled={!said.trim() || busy !== ''}
          onClick={describe}
        >
          {busy === 'describe' ? 'drawing it…' : 'describe one'}
        </button>
        <button style={S.btn} disabled={busy !== ''} onClick={blank}>
          {busy === 'new' ? 'starting…' : 'a new one'}
        </button>
      </div>

      {saved.map((w) => {
        const here = w.name === running
        return (
          <div
            key={w.name}
            role="button"
            title={here ? 'this is the floor running' : `run ${w.name}`}
            style={{ ...S.card, ...(here ? S.cardOn : {}), cursor: here ? 'default' : 'pointer' }}
            onClick={() => !here && run(w.markdown)}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ color: here ? 'var(--ok)' : 'var(--ink)', flex: 1 }}>{w.name}</span>
              {!here && (
                <button
                  style={S.linkBtn}
                  title={
                    w.builtin
                      ? 'take this one off the list - it ships with Bullpen and is not deleted'
                      : 'delete this floor'
                  }
                  onClick={async (e) => {
                    e.stopPropagation()
                    const res = await window.bullpen.deleteWorkflow(w.name)
                    if (res.error) return setError(res.error)
                    list()
                  }}
                >
                  remove
                </button>
              )}
            </div>
            <div style={{ color: 'var(--faint)', lineHeight: 1.5 }}>{w.description}</div>
            <Shape floor={shape[w.name]} />
          </div>
        )
      })}
      {/* Removing a shipped floor only takes it off the list, and without this
          there was no way back to it short of editing the config by hand. */}
      <button
        style={{ ...S.linkBtn, marginTop: 4 }}
        onClick={async () => {
          await window.bullpen.unhideWorkflows()
          list()
        }}
      >
        show the ones I removed
      </button>
      {error && <div style={{ color: 'var(--danger)' }}>{error.split('\n')[0]}</div>}
    </div>
  )
}

/**
 * A floor in one line: who it goes through, in the order work moves.
 *
 * The list used to be a name and 34 characters of description, which is the
 * same amount somebody can learn about a floor by reading its filename. This is
 * the drawing, flattened - the same columns `layout` puts the boxes in.
 */
function Shape({ floor }: { floor?: WorkflowInfo }) {
  if (!floor) return null
  const placed = layout(floor)
  const columns = new Map<number, string[]>()
  for (const n of placed) {
    const label = n.kind === 'role' ? (floor.roles[n.id]?.label ?? n.id) : 'you'
    columns.set(n.x, [...(columns.get(n.x) ?? []), label])
  }
  const order = [...columns.keys()].sort((a, b) => a - b)

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 6 }}>
      {order.map((x, i) => (
        <span key={x} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {i > 0 && <span style={{ color: 'var(--faint)' }}>→</span>}
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {(columns.get(x) ?? []).map((label) => (
              <span key={label} style={S.step}>
                {label}
              </span>
            ))}
          </span>
        </span>
      ))}
      <span style={{ color: 'var(--faint)', marginLeft: 4 }}>
        {Object.keys(floor.roles).length} roles · {floor.cardRules.length} rules
      </span>
    </div>
  )
}

/** Whether a role answers to a word a card rule uses. */
function matchesRole(floor: WorkflowInfo, role: string, word: string): boolean {
  if (word === 'anyone') return true
  if (word === role) return true
  if (word === 'staff') return !(floor.talksTo[role] ?? []).includes(floor.human)
  return (floor.roles[role]?.can ?? []).includes(word)
}

/**
 * How two of them talk, said where the line is.
 *
 * A line means "may write to", which is half a sentence: it does not say when,
 * or what that does to the work. Both were in a table three screens away, so
 * nobody connected the arrow to the rule - and the arrow is the thing people
 * draw first.
 *
 * Two names and a box. The paragraph that stood here explained what a line is,
 * what happens to a message the router refuses, and the whole syntax of the box
 * below - four sentences to read every time, above the one field that does
 * anything. The placeholder says the same thing in the place it is needed.
 */
function TalkInspector({
  floor,
  from,
  to,
  onChange
}: {
  floor: WorkflowInfo
  from: string
  to: string
  onChange: (patch: Partial<WorkflowInfo>) => void
}) {
  const name = (r: string): string => (r === floor.human ? 'you' : (floor.roles[r]?.label ?? r))
  /** Whether that direction is a line on this floor at all. */
  const drawn = (a: string, b: string): boolean =>
    (floor.talksTo[a] ?? []).includes(b) || (a === floor.human && b === floor.dispatch)

  return (
    <div>
      <div style={{ ...LABEL, color: 'var(--accent-ink)' }}>
        {name(from)} ⇄ {name(to)}
      </div>
      <TalkBox floor={floor} from={from} to={to} onChange={onChange} />
      {drawn(to, from) && <TalkBox floor={floor} from={to} to={from} onChange={onChange} />}
      <div style={{ color: 'var(--faint)', marginTop: 6 }}>
        <kbd>delete</kbd> takes the line away.
      </div>
    </div>
  )
}

/**
 * One direction of one line, as the file's own lines.
 *
 * Both names are editable because a rule is often not about these two roles at
 * all: `builds → assigns` is every builder and every assigner, and typing that
 * over the pair's own names is the upgrade from one arrow to a floor's law.
 */
function TalkBox({
  floor,
  from,
  to,
  onChange
}: {
  floor: WorkflowInfo
  from: string
  to: string
  onChange: (patch: Partial<WorkflowInfo>) => void
}) {
  const belongs = (r: (typeof floor.cardRules)[number]): boolean =>
    matchesRole(floor, from, r.from) &&
    (to === floor.human ? r.to === floor.human : matchesRole(floor, to, r.to))

  const mine = floor.cardRules.filter(belongs)
  const [text, setText] = useState(() => writeTalk(mine, floor.columns))
  const name = (r: string): string => (r === floor.human ? 'you' : (floor.roles[r]?.label ?? r))

  return (
    <div style={{ marginTop: 6 }}>
      <div style={LABEL}>
        {name(from)} → {name(to)}
      </div>
      <textarea
        style={{ ...S.area, height: 84 }}
        value={text}
        spellCheck={false}
        placeholder={`- ${from} → ${to === floor.human ? floor.human : to}: opens a card · when she puts somebody on it`}
        onChange={(e) => {
          setText(e.target.value)
          // Everything that is not about this direction, worked out again
          // rather than by index: the list moves under this with every
          // keystroke, and the other box is writing to it too.
          const kept = floor.cardRules.filter((r) => !belongs(r))
          const mineNow = readTalk(
            e.target.value,
            floor.columns,
            from,
            to === floor.human ? floor.human : to
          )
          onChange({ cardRules: [...kept, ...mineNow] as typeof floor.cardRules })
        }}
      />
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={S.line}>
      <span style={{ color: 'var(--muted)', width: 96, flex: '0 0 auto' }}>{label}</span>
      {children}
    </div>
  )
}

/** The floating panel's box, which two places have to agree on. */
const PANEL_W = 330
const PANEL_H = 460

const S: Record<string, React.CSSProperties> = {
  wrap: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden' },
  bar: { display: 'flex', gap: 6, alignItems: 'center', flex: '0 0 auto' },
  body: { flex: 1, display: 'flex', gap: 10, minHeight: 0 },
  side: {
    flex: '0 0 420px',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'auto',
    padding: 10,
    border: '1px solid var(--line)',
    background: 'var(--panel)'
  },
  board: {
    flex: 1,
    position: 'relative',
    // Not `auto`: the drawing is dragged and zoomed, and a scrollbar beside a
    // canvas that pans is two ways to do the same thing that disagree.
    overflow: 'hidden',
    border: '1px solid var(--line)',
    // The dotted ground belongs to the canvas, not to the drawing on it. As a
    // rect inside the SVG it stopped where the drawing did - the grid covered
    // the corner the boxes happened to be in and nothing else.
    background: 'var(--sunk)',
    backgroundImage: 'radial-gradient(var(--line) 1px, transparent 1px)',
    backgroundSize: '16px 16px',
    backgroundPosition: '30px 30px'
  },
  edgeLabel: {
    position: 'absolute',
    zIndex: 1,
    color: 'var(--faint)',
    font: `10px ${MONO}`,
    pointerEvents: 'none',
    whiteSpace: 'nowrap'
  },
  handle: {
    position: 'absolute',
    zIndex: 1,
    width: 18,
    height: 18,
    padding: 0,
    borderRadius: 9,
    border: '1px solid var(--line)',
    background: 'var(--panel)',
    cursor: 'pointer'
  },
  menu: {
    position: 'absolute',
    zIndex: 6,
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 156
  },
  menuItem: {
    background: 'none',
    border: 0,
    color: 'var(--ink)',
    font: 'inherit',
    textAlign: 'left',
    padding: '5px 10px',
    cursor: 'pointer'
  },
  /** Over the drawing, near what was clicked - not a column that is always there. */
  panel: {
    position: 'absolute',
    // Above the drawing and above the line labels: at z-index 2 the lines and
    // their handles were painted over the top of it.
    zIndex: 5,
    width: PANEL_W,
    maxHeight: PANEL_H,
    // Padding and border inside the width, so the number the clamp uses is the
    // number the panel is - it hung 22px off the right edge otherwise.
    boxSizing: 'border-box',
    overflow: 'auto',
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    boxShadow: '0 4px 18px rgba(0,0,0,0.45)',
    padding: 10
  },
  close: {
    position: 'absolute',
    right: 6,
    top: 4,
    background: 'none',
    border: 0,
    color: 'var(--faint)',
    cursor: 'pointer',
    font: 'inherit'
  },
  line: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 },
  card: {
    border: '1px solid var(--line)',
    background: 'var(--sunk)',
    padding: '6px 8px',
    marginBottom: 6
  },
  cardOn: { borderColor: 'var(--ok)' },
  step: {
    border: '1px solid var(--line)',
    background: 'var(--panel)',
    padding: '0 5px',
    color: 'var(--muted)',
    whiteSpace: 'nowrap'
  },
  field: {
    flex: 1,
    minWidth: 0,
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    color: 'var(--ink)',
    font: 'inherit',
    padding: '3px 5px'
  },
  area: {
    width: '100%',
    boxSizing: 'border-box',
    resize: 'none',
    background: 'var(--sunk)',
    border: '1px solid var(--line)',
    color: 'var(--ink)',
    font: `11px ${MONO}`,
    lineHeight: 1.5,
    padding: 6
  },
  colour: { width: 30, height: 22, padding: 0, border: '1px solid var(--line)', cursor: 'pointer' },
  chips: { display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 },
  chip: { padding: '2px 7px', border: '1px solid var(--line)', color: 'var(--muted)', cursor: 'pointer' },
  chipOn: { borderColor: 'var(--accent-ink)', color: 'var(--ink)', background: 'var(--panel)' },
  x: { background: 'none', border: 0, color: 'var(--faint)', cursor: 'pointer', font: 'inherit' },
  mark: {
    fill: 'var(--muted)',
    font: `18px ${MONO}`,
    textAnchor: 'middle' as const
  },
  glyph: {
    fill: 'var(--accent-ink)',
    font: `20px ${MONO}`,
    textAnchor: 'middle' as const,
    fontWeight: 700
  },
  name: { fill: 'var(--ink)', font: `12px ${MONO}`, textAnchor: 'middle' as const },
  what: { fill: 'var(--faint)', font: `11px ${MONO}`, textAnchor: 'middle' as const },
  btn: {
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    color: 'var(--ink)',
    font: 'inherit',
    padding: '3px 9px',
    cursor: 'pointer'
  },
  btnGo: { borderColor: 'var(--accent-ink)', color: 'var(--accent-ink)' },
  btnOn: { borderColor: 'var(--accent-ink)', color: 'var(--accent-ink)' },
  btnOff: { opacity: 0.45, cursor: 'default' },
  linkBtn: {
    background: 'none',
    border: 0,
    color: 'var(--danger)',
    cursor: 'pointer',
    font: 'inherit',
    padding: 0
  }
}
