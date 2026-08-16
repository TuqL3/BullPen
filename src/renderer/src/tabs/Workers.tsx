import { Avatar } from '../Avatar'
import { LABEL, MONO } from '../theme'
import { since } from './Monitor'
import type { Agent } from '../store'

/**
 * The fleet: identity, where each agent runs, and the one destructive action.
 *
 * Not the same thing as the ephemeral workers a god agent spins up to handle an
 * inbound message and then tears down — Bullpen has no such mechanism, and the
 * note at the bottom says so rather than showing an invented `0 / 4`.
 */
export function Workers({ agents, onSelect }: { agents: Agent[]; onSelect: (id: string) => void }) {
  if (agents.length === 0) return <div style={S.empty}>No workers hired.</div>

  const live = agents.filter((a) => a.status === 'running')

  return (
    <div style={S.wrap}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
        <span style={{ ...LABEL, color: 'var(--ink)' }}>live workers</span>
        <span style={{ fontSize: 11, color: 'var(--muted)', flex: 1 }}>
          Long-lived agents, one pty each. They persist until you halt them.
        </span>
        <span style={{ ...LABEL, color: 'var(--faint)' }}>
          {live.length} / {agents.length}
        </span>
      </div>

      <div style={{ ...S.row, ...S.head }}>
        <span style={{ width: 26 }} />
        <span style={{ width: 110 }}>name</span>
        <span style={{ width: 110 }}>project</span>
        <span style={{ width: 70 }}>pid</span>
        <span style={{ width: 78 }}>size</span>
        <span style={{ width: 80 }}>uptime</span>
        <span style={{ width: 80 }}>state</span>
        <span style={{ flex: 1 }}>workspace</span>
        <span style={{ width: 50 }} />
      </div>

      {agents.map((a) => (
        <div key={a.id} style={S.row} onClick={() => onSelect(a.id)}>
          <Avatar id={a.face} shirt={a.color} size={26} />
          <span style={{ ...LABEL, color: 'var(--ink)', width: 110 }}>
            {a.name}
            {a.role === 'god' && <span style={{ color: 'var(--accent-ink)' }}> ·you</span>}
          </span>
          <span style={{ width: 110, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {a.role === 'god' ? '—' : a.project || '—'}
          </span>
          <span style={{ width: 70, color: 'var(--muted)' }}>{a.pid || '—'}</span>
          <span style={{ width: 78, color: 'var(--muted)' }}>
            {a.cols && a.rows ? `${a.cols}×${a.rows}` : '—'}
          </span>
          <span style={{ width: 80, color: 'var(--muted)' }}>{since(a.startedAt ?? 0)}</span>
          <span style={{ width: 80, color: a.status === 'exited' ? 'var(--faint)' : 'var(--muted)' }}>
            {a.status === 'exited' ? `exit ${a.exitCode ?? '?'}` : a.activity}
          </span>
          <span
            title={a.cwd}
            style={{ flex: 1, color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {a.cwd}
          </span>
          <span style={{ width: 50 }}>
            {a.status === 'running' && (
              <button
                style={S.halt}
                onClick={(e) => {
                  e.stopPropagation()
                  window.bullpen.kill(a.id)
                }}
              >
                halt
              </button>
            )}
          </span>
        </div>
      ))}

      <p style={S.note}>
        Halting kills the process. Bullpen also reaps agents left behind by a crash on its next
        start, so a worker that outlives the app does not keep spending quietly.
      </p>
      <p style={S.note}>
        <b>Not built:</b> ephemeral workers — throwaway agents your clone spawns for one inbound
        message, which reply and tear themselves down. Every agent here is long-lived and hired by
        hand.
      </p>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: { padding: 14, overflowY: 'auto', height: '100%', font: `12px ${MONO}` },
  head: { ...LABEL, color: 'var(--faint)', borderTop: 'none' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '7px 6px',
    borderTop: '1px solid var(--line)',
    cursor: 'pointer'
  },
  halt: {
    padding: '3px 8px',
    background: 'transparent',
    color: 'var(--danger)',
    border: '1px solid var(--danger)',
    cursor: 'pointer',
    font: `10px ${MONO}`
  },
  note: { fontSize: 11, color: 'var(--faint)', marginTop: 14, lineHeight: 1.6 },
  empty: { color: 'var(--faint)', padding: 18, fontSize: 11 }
}
