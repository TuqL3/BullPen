import { useEffect, useState } from 'react'
import { Avatar } from '../Avatar'
import { LABEL, MONO } from '../theme'
import type { Question } from '../../../preload/index'
import type { Agent, Approval } from '../store'

/**
 * Everything waiting on a human, from any agent, in one queue.
 *
 * Two kinds land here and they are different things. An **approval** is the
 * safety hook holding a tool call open - answer it and the call proceeds or
 * dies. A **question** is an agent that addressed `you` through the hive; the
 * reply is routed back into its inbox like any other message, so there is no
 * second delivery path to keep working.
 */
export function AskMe({ approvals, agents }: { approvals: Approval[]; agents: Agent[] }) {
  const [questions, setQuestions] = useState<Question[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  useEffect(() => {
    window.bullpen.askList().then(setQuestions)
    return window.bullpen.onAsk(setQuestions)
  }, [])

  const agentOf = (id: string) => agents.find((a) => a.id === id)
  const nameOf = (id: string) => agentOf(id)?.name ?? id

  const answer = async (q: Question): Promise<void> => {
    const text = (drafts[q.id] ?? '').trim()
    if (!text) return
    await window.bullpen.askAnswer(q.id, text)
    setDrafts((d) => ({ ...d, [q.id]: '' }))
  }

  const nothing = approvals.length === 0 && questions.length === 0

  return (
    <div style={S.wrap}>
      {nothing && (
        <div style={S.empty}>
          Nothing is waiting on you. Agents run unblocked until they touch something destructive, a
          credential path, or write outside their sandbox — or until one writes to{' '}
          <code>$BULLPEN_MAILBOX/outbox</code> addressed to <code>you</code>.
        </div>
      )}

      {questions.map((q) => {
        const agent = agentOf(q.from)
        return (
          <div key={q.id} style={S.card}>
            <div style={S.head}>
              <Avatar id={agent?.face ?? q.from} shirt={agent?.color} size={22} />
              <span style={{ ...LABEL, color: 'var(--ink)' }}>{nameOf(q.from)}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>asks</span>
              <span style={{ flex: 1, color: 'var(--ink)' }}>{q.subject}</span>
              <button style={S.linkBtn} onClick={() => window.bullpen.askDismiss(q.id)}>
                ×
              </button>
            </div>
            <pre style={S.body}>{q.body}</pre>
            <textarea
              style={S.answer}
              rows={3}
              value={drafts[q.id] ?? ''}
              placeholder="Your answer — sent straight back to their inbox (Ctrl+Enter)"
              onChange={(e) => setDrafts((d) => ({ ...d, [q.id]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey)) answer(q)
              }}
            />
            <button style={{ ...S.btn, ...S.btnPrimary }} onClick={() => answer(q)}>
              respond &amp; unblock
            </button>
          </div>
        )
      })}

      {approvals.map((a) => {
        const agent = agentOf(a.agentId)
        return (
          <div key={a.id} style={S.card}>
            <div style={S.head}>
              <Avatar id={agent?.face ?? a.agentId} shirt={agent?.color} size={22} />
              <span style={{ ...LABEL, color: 'var(--ink)' }}>{nameOf(a.agentId)}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>wants to run</span>
              <span style={{ ...LABEL, color: 'var(--ink)' }}>{a.toolName}</span>
              <span style={{ flex: 1 }} />
              <span style={{ ...LABEL, color: 'var(--faint)' }}>
                {new Date(a.createdAt).toLocaleTimeString()}
              </span>
            </div>
            <div style={{ color: 'var(--warn)', fontSize: 12, margin: '6px 0 8px' }}>{a.reason}</div>
            <pre style={S.body}>{a.detail}</pre>
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

      {!nothing && (
        <p style={S.note}>
          Allowing a tool call is for that call only — there is no remembered rule, on purpose. An
          agent stays blocked in its hook until you answer, and an unanswered request is denied if
          Bullpen exits.
        </p>
      )}
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: { padding: 14, overflowY: 'auto', height: '100%', font: `12px ${MONO}` },
  card: { border: '1px solid var(--line)', background: 'var(--panel)', padding: 12, marginBottom: 12 },
  head: { display: 'flex', alignItems: 'center', gap: 8 },
  body: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 200,
    overflow: 'auto',
    background: 'var(--sunk)',
    border: '1px solid var(--line)',
    padding: 9,
    margin: '8px 0',
    font: `12px ${MONO}`,
    lineHeight: 1.55,
    color: 'var(--ink)'
  },
  answer: {
    width: '100%',
    boxSizing: 'border-box',
    resize: 'vertical',
    padding: 8,
    marginBottom: 8,
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    font: `12px ${MONO}`
  },
  btn: {
    padding: '6px 12px',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    cursor: 'pointer',
    font: `11px ${MONO}`
  },
  btnPrimary: { background: 'var(--accent)', color: '#241f1a', borderColor: 'var(--accent)' },
  deny: { color: 'var(--danger)', borderColor: 'var(--danger)' },
  linkBtn: { background: 'transparent', border: 'none', color: 'var(--faint)', cursor: 'pointer' },
  note: { fontSize: 11, color: 'var(--faint)', marginTop: 14, lineHeight: 1.6 },
  empty: { color: 'var(--faint)', padding: 18, fontSize: 11, lineHeight: 1.7 }
}
