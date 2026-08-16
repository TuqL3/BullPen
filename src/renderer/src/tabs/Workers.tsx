import { Avatar } from '../Avatar'
import { LABEL, MONO } from '../theme'
import { since } from './Monitor'
import type { Agent } from '../store'

/** The fleet table: identity, where it runs, and the one destructive action. */
export function Workers({ agents, onSelect }: { agents: Agent[]; onSelect: (id: string) => void }) {
  if (agents.length === 0) return <div style={S.empty}>No workers hired.</div>

  return (
    <div style={S.wrap}>
      <div style={{ ...S.row, ...S.head }}>
        <span style={{ width: 26 }} />
        <span style={{ width: 110 }}>name</span>
        <span style={{ width: 70 }}>pid</span>
        <span style={{ width: 80 }}>uptime</span>
        <span style={{ width: 80 }}>state</span>
        <span style={{ flex: 1 }}>workspace</span>
        <span style={{ width: 50 }} />
      </div>

      {agents.map((a) => (
        <div key={a.id} style={S.row} onClick={() => onSelect(a.id)}>
          <Avatar id={a.face} shirt={a.color} size={26} />
          <span style={{ ...LABEL, color: 'var(--ink)', width: 110 }}>{a.name}</span>
          <span style={{ width: 70, color: 'var(--muted)' }}>{a.pid || '—'}</span>
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
  note: { fontSize: 11, color: 'var(--faint)', marginTop: 18, lineHeight: 1.6 },
  empty: { color: 'var(--faint)', padding: 18, fontSize: 11 }
}
