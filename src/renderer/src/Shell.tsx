import { Fragment, useEffect, useRef, useState } from 'react'
import { Splitter } from './App'
import { paneSize, TerminalDeck } from './Terminal'
import { LABEL, MONO } from './theme'
import {
  EMPTY,
  addColumn,
  moveTo,
  moveToNewColumn,
  remove,
  resizeColumns,
  resizeRows,
  type Grid
} from './split'
import type { Agent } from './store'

/** Ids under this prefix are shells, not agents. Kept in step with main. */
export const SHELL_PREFIX = 'shell:'
export const isShellId = (id: string): boolean => id.startsWith(SHELL_PREFIX)

/** `shell:michael#3` is shell 3. Read off the id, not off the position, so a
 *  cell keeps its number when it is dragged somewhere else. */
const shellNumber = (id: string): number => Number(/#(\d+)$/.exec(id)?.[1] ?? 1)

/**
 * Shells in the selected agent's workspace - as many as you want, arranged.
 *
 * Separate from the agent's own terminal on purpose: that one is Claude Code's
 * TUI, and typing `git log` into it is a prompt, not a command. This is where
 * the operator runs things themselves, in the same directory the agent works in.
 *
 * A grid per agent rather than one shared one: a shell belongs to a workspace,
 * and switching agent must not show you a prompt sitting in someone else's
 * directory. The arrangement is per agent for the same reason.
 */
export function Shell({ agent }: { agent: Agent | null }) {
  const [grids, setGrids] = useState<Record<string, Grid>>({})
  const [exited, setExited] = useState<Record<string, number>>({})
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState<string | null>(null)
  const host = useRef<HTMLDivElement>(null)

  const grid = agent ? (grids[agent.id] ?? EMPTY) : EMPTY
  const ids = grid.columns.flat()
  const apply = (next: Grid): void => {
    if (agent) setGrids((g) => ({ ...g, [agent.id]: next }))
  }

  /** `fresh` is the "new shell" button; false is "show me a shell at all". */
  const start = async (fresh = false): Promise<void> => {
    if (!agent) return
    const { cols, rows } = paneSize(host.current)
    try {
      const s = await window.bullpen.openShell(agent.id, agent.cwd, { cols, rows }, fresh)
      setExited((x) => {
        const next = { ...x }
        delete next[s.id]
        return next
      })
      setGrids((g) => ({ ...g, [agent.id]: addColumn(g[agent.id] ?? EMPTY, s.id) }))
      setError('')
    } catch (err) {
      // A shell that fails to start silently looks exactly like one that
      // started and printed nothing.
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Opening on select rather than on a button: a terminal panel that needs a
  // click before it is a terminal is a panel showing an empty box.
  useEffect(() => {
    if (agent && !(grids[agent.id]?.columns.length ?? 0)) start()
  }, [agent?.id, agent?.cwd])

  useEffect(() => {
    return window.bullpen.onExit((who, code) => {
      if (isShellId(who)) setExited((x) => ({ ...x, [who]: code }))
    })
  }, [])

  if (!agent) return <div style={S.empty}>Pick an agent to open a shell in its workspace.</div>

  const close = (id: string): void => {
    apply(remove(grid, id))
    window.bullpen.kill(id)
  }

  return (
    <div style={S.wrap}>
      <div style={S.bar}>
        <span style={{ ...LABEL, color: 'var(--ink)' }}>{agent.cwd}</span>
        <span style={{ flex: 1 }} />
        <span style={{ ...LABEL, color: 'var(--faint)' }}>
          {ids.length} shell{ids.length === 1 ? '' : 's'} · drag a title to rearrange
        </span>
        <button style={S.btn} onClick={() => start(true)}>
          new shell
        </button>
      </div>
      {error && <div style={S.error}>{error}</div>}

      <div ref={host} style={S.body}>
        {ids.length === 0 ? (
          <div style={S.empty}>No shell open. &quot;new shell&quot; starts one.</div>
        ) : (
          <div style={S.grid}>
            {grid.columns.map((col, i) => (
              <Fragment key={col[0]}>
                {i > 0 && (
                  <Splitter
                    dragging={dragging}
                    onDrag={(f) => apply(resizeColumns(grid, i - 1, i, f))}
                    onDropPanel={(from) => apply(moveToNewColumn(grid, from, i))}
                    kind="text/shell"
                  />
                )}
                <ShellColumn
                  ids={col}
                  grid={grid}
                  weight={grid.colWeight[i] ?? 1}
                  exited={exited}
                  dragging={dragging}
                  onDragStart={setDragging}
                  onDragEnd={() => setDragging(null)}
                  onDropOn={(from, target, side) => apply(moveTo(grid, from, target, side))}
                  onResize={(above, below, f) => apply(resizeRows(grid, above, below, f))}
                  onClose={close}
                />
              </Fragment>
            ))}
            {/* Dropped past the last column: a column of its own, on the end. */}
            <Splitter
              dragging={dragging}
              onDrag={() => {}}
              onDropPanel={(from) => apply(moveToNewColumn(grid, from, grid.columns.length))}
              kind="text/shell"
            />
          </div>
        )}
      </div>
    </div>
  )
}

function ShellColumn({
  ids,
  grid,
  weight,
  exited,
  dragging,
  onDragStart,
  onDragEnd,
  onDropOn,
  onResize,
  onClose
}: {
  ids: string[]
  grid: Grid
  weight: number
  exited: Record<string, number>
  dragging: string | null
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onDropOn: (from: string, target: string, side: 'above' | 'below') => void
  onResize: (above: string, below: string, delta: number) => void
  onClose: (id: string) => void
}) {
  const total = ids.reduce((n, id) => n + (grid.rowWeight[id] ?? 1), 0) || 1
  return (
    <div style={{ ...S.column, flexGrow: weight }}>
      {ids.map((id, i) => (
        <Fragment key={id}>
          {i > 0 && (
            <Splitter
              vertical
              dragging={dragging}
              onDrag={(f) => onResize(ids[i - 1], id, f)}
              kind="text/shell"
            />
          )}
          <ShellCell
            id={id}
            share={(grid.rowWeight[id] ?? 1) / total}
            exitCode={exited[id]}
            dragging={dragging}
            onDragStart={() => onDragStart(id)}
            onDragEnd={onDragEnd}
            onDrop={(from, side) => onDropOn(from, id, side)}
            onClose={() => onClose(id)}
          />
        </Fragment>
      ))}
    </div>
  )
}

/** One shell, with a title you drag onto another to place it. */
function ShellCell({
  id,
  share,
  exitCode,
  dragging,
  onDragStart,
  onDragEnd,
  onDrop,
  onClose
}: {
  id: string
  share: number
  exitCode?: number
  dragging: string | null
  onDragStart: () => void
  onDragEnd: () => void
  onDrop: (from: string, side: 'above' | 'below') => void
  onClose: () => void
}) {
  const [side, setSide] = useState<'above' | 'below' | null>(null)
  const isTarget = side !== null && dragging !== null && dragging !== id

  const half = (e: React.DragEvent): 'above' | 'below' => {
    const box = e.currentTarget.getBoundingClientRect()
    return e.clientY < box.top + box.height / 2 ? 'above' : 'below'
  }

  return (
    <section
      style={{
        ...S.cell,
        flexGrow: share,
        ...(isTarget ? (side === 'above' ? S.cellTargetTop : S.cellTargetBottom) : null)
      }}
      onDragOver={(e) => {
        if (!dragging || dragging === id) return
        e.preventDefault()
        setSide(half(e))
      }}
      onDragLeave={() => setSide(null)}
      onDrop={(e) => {
        e.preventDefault()
        const from = e.dataTransfer.getData('text/shell')
        setSide(null)
        if (from && from !== id) onDrop(from, half(e))
      }}
    >
      <div
        style={S.cellBar}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/shell', id)
          e.dataTransfer.effectAllowed = 'move'
          onDragStart()
        }}
        onDragEnd={onDragEnd}
      >
        <span style={{ ...LABEL, color: 'var(--muted)' }}>shell {shellNumber(id)}</span>
        {exitCode !== undefined && (
          <span style={{ ...LABEL, color: 'var(--faint)' }}>exited {exitCode}</span>
        )}
        <span style={{ flex: 1 }} />
        <button style={S.close} title="close this shell" onClick={onClose}>
          ×
        </button>
      </div>
      {/* One deck per cell: the deck moves the xterm element into whichever host
          is mounted, so a shell must be shown in exactly one place. */}
      <div style={S.termHost}>
        <TerminalDeck ids={[id]} selected={id} />
      </div>
    </section>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '5px 10px',
    borderBottom: '1px solid var(--line)'
  },
  body: { flex: 1, minHeight: 0, display: 'flex' },
  grid: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'stretch' },
  column: { display: 'flex', flexDirection: 'column', minWidth: 0, flexBasis: 0 },
  cell: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flexBasis: 0,
    border: '1px solid var(--line)',
    background: 'var(--term-bg)'
  },
  cellTargetTop: { boxShadow: 'inset 0 3px 0 var(--accent)' },
  cellTargetBottom: { boxShadow: 'inset 0 -3px 0 var(--accent)' },
  cellBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '2px 6px',
    borderBottom: '1px solid var(--line)',
    background: 'var(--panel)',
    cursor: 'grab'
  },
  termHost: { flex: 1, minHeight: 0 },
  close: {
    background: 'transparent',
    border: 'none',
    color: 'var(--faint)',
    cursor: 'pointer',
    font: `12px ${MONO}`,
    padding: '0 2px'
  },
  btn: {
    padding: '3px 9px',
    background: 'transparent',
    color: 'var(--muted)',
    border: '1px solid var(--line)',
    cursor: 'pointer',
    font: `10px ${MONO}`
  },
  error: { padding: '4px 10px', color: 'var(--danger)', font: `11px ${MONO}` },
  empty: { padding: 16, color: 'var(--faint)', font: `11px ${MONO}` }
}
