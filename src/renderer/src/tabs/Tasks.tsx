import { useEffect, useState } from 'react'
import { LABEL, MONO } from '../theme'
import type { Agent } from '../store'

type Status = 'todo' | 'doing' | 'blocked' | 'done'
type Task = { id: string; agentId: string; text: string; status: Status; createdAt: number }

const COLUMNS: { key: Status; label: string; bar: string }[] = [
  { key: 'todo', label: 'todo', bar: '#7fc7e8' },
  { key: 'doing', label: 'doing', bar: '#e8cf6a' },
  { key: 'blocked', label: 'blocked', bar: '#e8917f' },
  { key: 'done', label: 'done', bar: '#7fd8a0' }
]

/** The board is the whole floor's, not one agent's - that is the point of it. */
export function Tasks({ agents }: { agents: Agent[] }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [text, setText] = useState('')
  const [owner, setOwner] = useState('')

  const refresh = (): void => {
    window.bullpen.tasks().then((t) => setTasks(t as Task[]))
  }
  useEffect(refresh, [])

  const add = async (): Promise<void> => {
    if (!text.trim()) return
    await window.bullpen.addTask(owner || agents[0]?.id || '', text.trim())
    setText('')
    refresh()
  }

  const move = async (id: string, status: Status): Promise<void> => {
    await window.bullpen.setTaskStatus(id, status)
    refresh()
  }

  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id ?? 'unassigned'

  return (
    <div style={S.wrap}>
      <div style={S.addRow}>
        <input
          style={S.input}
          value={text}
          placeholder="add a card"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <select style={S.select} value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">unassigned</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button style={S.btn} onClick={add}>
          add
        </button>
        <span style={{ ...LABEL, color: 'var(--faint)', marginLeft: 'auto' }}>
          {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
      </div>

      <div style={S.board}>
        {COLUMNS.map((col) => {
          const cards = tasks.filter((t) => t.status === col.key)
          return (
            <div key={col.key} style={S.column}>
              <div style={{ ...S.colHead, background: col.bar }}>
                <span style={{ ...LABEL, color: '#241f1a', fontWeight: 700 }}>{col.label}</span>
                <span style={{ ...LABEL, color: '#241f1a' }}>{cards.length}</span>
              </div>
              <div style={S.cards}>
                {cards.map((t) => (
                  <div key={t.id} style={{ ...S.card, borderLeft: `3px solid ${col.bar}` }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <span style={{ flex: 1, lineHeight: 1.45 }}>{t.text}</span>
                      <button
                        style={S.linkBtn}
                        title="delete card"
                        onClick={async () => {
                          await window.bullpen.removeTask(t.id)
                          refresh()
                        }}
                      >
                        ×
                      </button>
                    </div>
                    <div style={S.cardFoot}>
                      <span style={{ ...LABEL, color: 'var(--accent-ink)' }}>{nameOf(t.agentId)}</span>
                      <span style={{ flex: 1 }} />
                      {COLUMNS.filter((c) => c.key !== t.status).map((c) => (
                        <button
                          key={c.key}
                          style={S.moveBtn}
                          title={`move to ${c.label}`}
                          onClick={() => move(t.id, c.key)}
                        >
                          {c.label[0]}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {cards.length === 0 && <div style={S.emptyCol}>—</div>}
              </div>
            </div>
          )
        })}
      </div>

      <p style={S.note}>
        Cards are yours: nothing here is sent to an agent on its own. Assigning names an owner for
        your own tracking — to make an agent act, message it, dispatch through your clone, or set a
        trigger.
      </p>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: { padding: 14, height: '100%', overflowY: 'auto', font: `12px ${MONO}` },
  addRow: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14 },
  input: {
    flex: 1,
    padding: '6px 9px',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    font: `12px ${MONO}`
  },
  select: {
    padding: '6px',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    font: `11px ${MONO}`
  },
  btn: {
    padding: '6px 12px',
    background: 'var(--accent)',
    color: '#241f1a',
    border: '1px solid var(--accent)',
    cursor: 'pointer',
    font: `11px ${MONO}`
  },
  board: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 },
  column: { minWidth: 0 },
  colHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 8px'
  },
  cards: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6 },
  card: {
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    padding: '7px 8px',
    fontSize: 11
  },
  cardFoot: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 },
  moveBtn: {
    width: 16,
    height: 16,
    lineHeight: '14px',
    textAlign: 'center',
    background: 'var(--sunk)',
    color: 'var(--faint)',
    border: '1px solid var(--line)',
    cursor: 'pointer',
    font: `9px ${MONO}`,
    padding: 0
  },
  linkBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--faint)',
    cursor: 'pointer',
    font: `12px ${MONO}`
  },
  emptyCol: { color: 'var(--faint)', textAlign: 'center', padding: 8 },
  note: { fontSize: 11, color: 'var(--faint)', marginTop: 18, lineHeight: 1.6 }
}
