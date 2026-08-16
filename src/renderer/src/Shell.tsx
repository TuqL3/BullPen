import { useEffect, useRef, useState } from 'react'
import { paneSize, TerminalDeck } from './Terminal'
import { LABEL, MONO } from './theme'
import type { Agent } from './store'

/** Ids under this prefix are shells, not agents. Kept in step with main. */
export const SHELL_PREFIX = 'shell:'
export const isShellId = (id: string): boolean => id.startsWith(SHELL_PREFIX)

/**
 * A plain shell in the selected agent's workspace.
 *
 * Separate from the agent's own terminal on purpose: that one is Claude Code's
 * TUI, and typing `git log` into it is a prompt, not a command. This is where
 * the operator runs things themselves, in the same directory the agent works in.
 *
 * One shell per workspace rather than one global shell: a single shell would
 * have to `cd` on every selection, which loses whatever was half-typed and
 * cannot follow a shell the operator has already `cd`'d somewhere else.
 */
export function Shell({ agent }: { agent: Agent | null }) {
  const [open, setOpen] = useState<string[]>([])
  const [exited, setExited] = useState<Record<string, number>>({})
  const [error, setError] = useState('')
  const host = useRef<HTMLDivElement>(null)

  const id = agent ? SHELL_PREFIX + agent.id : null

  const start = async (): Promise<void> => {
    if (!agent || !id) return
    const { cols, rows } = paneSize(host.current)
    try {
      await window.bullpen.openShell(agent.id, agent.cwd, { cols, rows })
      setExited((x) => {
        const next = { ...x }
        delete next[id]
        return next
      })
      setOpen((ids) => (ids.includes(id) ? ids : [...ids, id]))
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
    start()
  }, [agent?.id, agent?.cwd])

  useEffect(() => {
    return window.bullpen.onExit((who, code) => {
      if (isShellId(who)) setExited((x) => ({ ...x, [who]: code }))
    })
  }, [])

  if (!agent) return <div style={S.empty}>Pick an agent to open a shell in its workspace.</div>

  const dead = id !== null && id in exited

  return (
    <div style={S.wrap}>
      <div style={S.bar}>
        <span style={{ ...LABEL, color: 'var(--ink)' }}>{agent.cwd}</span>
        <span style={{ flex: 1 }} />
        {dead && (
          <span style={{ ...LABEL, color: 'var(--faint)' }}>exited {exited[id!]}</span>
        )}
        <button style={S.btn} onClick={start}>
          {dead ? 'restart' : 'new shell'}
        </button>
      </div>
      {error && <div style={S.error}>{error}</div>}
      <div ref={host} style={S.term}>
        <TerminalDeck ids={open} selected={id} />
      </div>
    </div>
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
  term: { flex: 1, minHeight: 0, background: 'var(--term-bg)' },
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
