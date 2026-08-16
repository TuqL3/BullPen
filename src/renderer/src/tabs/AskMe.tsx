import { Avatar } from '../Avatar'
import { LABEL, MONO } from '../theme'
import type { Agent, Approval } from '../store'

/**
 * Everything an agent is waiting on a human for. Today that is the approvals
 * queue; it lives here rather than in its own tab because "an agent is blocked
 * on you" is one idea, not two.
 */
export function AskMe({ approvals, agents }: { approvals: Approval[]; agents: Agent[] }) {
  const faceOf = (id: string) => agents.find((a) => a.id === id)

  if (approvals.length === 0)
    return (
      <div style={S.wrap}>
        <div style={S.empty}>
          Nothing waiting. Agents run unblocked until they touch something destructive, a credential
          path, or write outside their sandbox.
        </div>
      </div>
    )

  return (
    <div style={S.wrap}>
      {approvals.map((a) => {
        const agent = faceOf(a.agentId)
        return (
          <div key={a.id} style={S.card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Avatar id={agent?.face ?? a.agentId} shirt={agent?.color} size={24} />
              <span style={{ ...LABEL, color: 'var(--ink)' }}>{agent?.name ?? a.agentId}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>wants to run</span>
              <span style={{ ...LABEL, color: 'var(--ink)' }}>{a.toolName}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: 'var(--faint)' }}>
                {new Date(a.createdAt).toLocaleTimeString()}
              </span>
            </div>
            <div style={{ color: 'var(--warn)', fontSize: 12, marginBottom: 8 }}>{a.reason}</div>
            <pre style={S.detail}>{a.detail}</pre>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                style={{ ...S.btn, ...S.deny, flex: 1 }}
                onClick={() => window.bullpen.decide(a.id, 'deny')}
              >
                deny
              </button>
              <button style={{ ...S.btn, flex: 1 }} onClick={() => window.bullpen.decide(a.id, 'allow')}>
                allow once
              </button>
            </div>
          </div>
        )
      })}
      <p style={S.note}>
        Allowing is for this call only — there is no remembered rule, on purpose. The agent is
        blocked in its hook until you answer, and an unanswered request is denied if Bullpen exits.
      </p>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: { padding: 14, overflowY: 'auto', height: '100%', font: `12px ${MONO}` },
  card: { border: '1px solid var(--line)', background: 'var(--panel)', padding: 12, marginBottom: 10 },
  detail: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    maxHeight: 140,
    overflow: 'auto',
    background: 'var(--sunk)',
    border: '1px solid var(--line)',
    padding: 8,
    margin: '0 0 10px',
    font: `12px ${MONO}`
  },
  btn: {
    padding: '6px 10px',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    cursor: 'pointer',
    font: `11px ${MONO}`
  },
  deny: { color: 'var(--danger)', borderColor: 'var(--danger)' },
  note: { fontSize: 11, color: 'var(--faint)', marginTop: 14, lineHeight: 1.6 },
  empty: { color: 'var(--faint)', padding: 18, fontSize: 11, lineHeight: 1.6 }
}
