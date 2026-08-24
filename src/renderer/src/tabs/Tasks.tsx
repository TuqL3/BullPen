import { useEffect, useState } from 'react'
import { onEnter } from '../keys'
import { ago } from '../fleet'
import { LABEL, MONO } from '../theme'
import type { ActivityItem } from '../../../preload/index'
import type { Agent } from '../store'
import { columns as boardColumns } from '../shape'

/** A column key. Which keys exist is the workflow's answer, not this file's. */
type Status = string
type Task = {
  id: string
  /** Empty means nobody has taken it: a card posted for a role, not a person. */
  agentId: string
  text: string
  status: Status
  createdAt: number
  /** What kind of agent it is work for, on a card nobody holds yet. */
  role?: string
  /** Who handed it over, and who is waiting on it. */
  by?: string
}

/**
 * One agent's board: the cards belonging to whoever is selected.
 *
 * The whole floor's cards in four columns was four agents' work interleaved,
 * all with the same assignment text - unreadable exactly when there is most of
 * it. The floor-wide view is the monitor; this answers "what is this one on".
 */
export function Tasks({
  agents,
  agent,
  dispatch
}: {
  agents: Agent[]
  agent: Agent | null
  /** The workflow's dispatch role - the only one whose work is not a board. */
  dispatch: string
}) {
  // The columns, their names and their colours are the workflow's: a floor of
  // writers has a card in "in review", not in "wait to test", and one where
  // nobody checks has no such column at all.
  const columns = boardColumns()

  // Dispatch relays: what reaches it goes straight back out, and every one of
  // those is done the moment it is done - a board of them would be four columns
  // with everything in the last one.
  //
  // Whoever assigns is not in that position. Work arrives, is analysed, is put
  // on somebody, and waits to come back: that is a card with a state, and it is
  // read the same way as anyone else's.
  if (agent && agent.role === dispatch) return <Ledger agent={agent} />

  const [all, setAll] = useState<Task[]>([])
  const [text, setText] = useState('')
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<Status | null>(null)
  const tasks = agent ? all.filter((t) => t.agentId === agent.id) : all

  const refresh = (): void => {
    window.bullpen.tasks().then((t) => setAll(t as Task[]))
  }
  // Subscribed, not fetched once: cards appear on their own now - an agent
  // given work gets one, and it moves as the agent does.
  useEffect(() => {
    refresh()
    return window.bullpen.onTasks((t) => setAll(t as Task[]))
  }, [])

  const add = async (): Promise<void> => {
    if (!text.trim() || !agent) return
    // A card typed on an agent's board is that agent's: the owner dropdown was
    // a second place to say what the tab already says.
    await window.bullpen.addTask(agent.id, text.trim())
    setText('')
    refresh()
  }

  // Where a card lands when it is typed. The floor's word for it, not `todo`:
  // one board's first column is another's second.
  const startKey = columns.find((c) => c.kind === 'start')?.key ?? columns[0]?.key
  const waiting = tasks.filter((t) => t.status === startKey)

  /**
   * Say yes to the list, once.
   *
   * The confirm sat on `add` and asked per card, which is a dialog between you
   * and the keyboard while you are still writing the list. Adding is free;
   * this is the press that spends, so it is its own press - and it covers
   * everything queued rather than the one card you happened to finish typing.
   */
  const start = async (): Promise<void> => {
    if (!agent || waiting.length === 0) return
    const list = waiting.map((t) => `- ${t.text}`).join('\n')
    if (
      !window.confirm(
        `Start ${agent.name} on ${waiting.length} card${waiting.length === 1 ? '' : 's'}?\n\n${list}\n\n` +
          'They are worked one at a time, the next going out as the last one closes.'
      )
    ) {
      return
    }
    for (const t of waiting) await window.bullpen.releaseTask(t.id)
    refresh()
  }

  const move = async (id: string, status: Status): Promise<void> => {
    await window.bullpen.setTaskStatus(id, status)
    refresh()
  }

  // `?? 'unassigned'` never fired: an unheld card carries an empty string, which
  // is not nullish, so the foot of every posted card rendered blank.
  const nameOf = (id: string): string =>
    id ? (agents.find((a) => a.id === id)?.name ?? id) : 'unclaimed'

  return (
    <div style={S.wrap}>
      <div style={S.addRow}>
        <input
          style={S.input}
          value={text}
          placeholder={agent ? `add a card for ${agent.name}` : 'pick an agent first'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onEnter(add)}
        />
        <button style={S.btn} onClick={add}>
          add
        </button>
        <button
          style={{ ...S.btn, ...(waiting.length ? null : S.btnOff) }}
          disabled={waiting.length === 0}
          title="hand every card in the first column to this agent"
          onClick={start}
        >
          start {waiting.length || ''}
        </button>
        <span style={{ ...LABEL, color: 'var(--faint)', marginLeft: 'auto' }}>
          {agent ? `${agent.name} · ` : ''}
          {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* A floor where nobody checks work never parks a card in wait-to-test -
          `routeCard` closes it on the builder's word - so the column would sit
          empty forever, describing a step this workflow does not have. */}
      <div style={{ ...S.board, gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
        {columns.map((col, i) => {
          // A card in a column this workflow no longer has - the board was
          // written under a different one, or the column was renamed - is shown
          // in the first column rather than dropped. A card nobody can see is
          // worse than a card in the wrong place.
          const known = new Set(columns.map((c) => c.key))
          const cards = tasks.filter(
            (t) => t.status === col.key || (i === 0 && !known.has(t.status))
          )
          return (
            <div
              key={col.key}
              style={{ ...S.column, ...(over === col.key ? S.columnOver : null) }}
              onDragOver={(e) => {
                // Read off the drag itself, not off React state: the first
                // dragover runs in a closure from before the drag started, and
                // a column that only lights up on the second event looks
                // broken. preventDefault is also what makes the drop fire.
                if (!e.dataTransfer.types.includes('text/card')) return
                e.preventDefault()
                setOver(col.key)
              }}
              onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
              onDrop={(e) => {
                e.preventDefault()
                const id = e.dataTransfer.getData('text/card') || dragging
                setOver(null)
                setDragging(null)
                if (id) move(id, col.key)
              }}
            >
              <div style={{ ...S.colHead, background: col.bar }}>
                <span style={{ ...LABEL, color: '#241f1a', fontWeight: 700 }}>{col.label}</span>
                <span style={{ ...LABEL, color: '#241f1a' }}>{cards.length}</span>
              </div>
              <div style={S.cards}>
                {cards.map((t) => (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/card', t.id)
                      e.dataTransfer.effectAllowed = 'move'
                      setDragging(t.id)
                    }}
                    onDragEnd={() => {
                      setDragging(null)
                      setOver(null)
                    }}
                    style={{
                      ...S.card,
                      borderLeft: `3px solid ${col.bar}`,
                      ...(dragging === t.id ? S.cardHeld : null)
                    }}
                  >
                    <div style={{ display: 'flex', gap: 6 }}>
                      {/* The whole assignment is on the card's title: four of
                          these at full length is a column you scroll past
                          rather than read. */}
                      <span style={S.cardText} title={t.text}>
                        {t.text}
                      </span>
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
                      {/* An unheld card is only actionable if it says who it is
                          for: "unclaimed" alone is a card nobody can act on. */}
                      {!t.agentId && t.role && (
                        <span style={{ ...LABEL, opacity: 0.7 }}>for {t.role}</span>
                      )}
                      {t.by && t.by !== t.agentId && (
                        <span style={{ ...LABEL, opacity: 0.7 }}>from {nameOf(t.by)}</span>
                      )}
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
        A card appears here on its own when this agent is given something, and moves as it works -
        drag one to move it by hand. Writing the list costs nothing and says nothing to the agent:
        press start when it is ready, and the cards go out one at a time until the list is empty.
        Moving a card by hand still tells the agent nothing.
      </p>
    </div>
  )
}


/** What the god agent did, newest first: hires, assignments, reports. */
const DID: Record<string, { label: string; color: string }> = {
  spawn: { label: 'hired', color: '#7fd8a0' },
  task: { label: 'assigned', color: '#e8cf6a' },
  message: { label: 'sent', color: '#7fc7e8' },
  question: { label: 'asked you', color: '#e8917f' },
  done: { label: 'finished', color: 'var(--muted)' },
  dead: { label: 'undelivered', color: '#e8917f' }
}

function Ledger({ agent }: { agent: Agent }) {
  const [items, setItems] = useState<ActivityItem[]>([])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    window.bullpen.activity(500).then(setItems)
    return window.bullpen.onActivity((i) => setItems((prev) => [i, ...prev].slice(0, 500)))
  }, [])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // His own actions, and the ones taken in his name: a hire is spawned by the
  // runtime on his instruction, and reads as his doing on this page.
  //
  // Two things are dropped. The runtime's own line for starting him is not
  // something he did. And handing work over writes twice - the card, and the
  // mail that carried it - so the mail is dropped when the card already says
  // it, which is every time the text of one starts the other.
  const mine = items.filter((i) => i.actor === agent.id && DID[i.kind])
  const assigned = mine.filter((i) => i.kind === 'task').map((i) => i.text)
  const log = mine.filter(
    (i) =>
      !(i.kind === 'spawn' && i.text.startsWith('spawned ')) &&
      !(i.kind === 'message' && assigned.some((t) => t.startsWith(i.text)))
  )

  return (
    <div style={S.wrap}>
      <div style={S.ledgerHead}>
        <span style={{ ...LABEL, color: 'var(--ink)' }}>{agent.name}&apos;s log</span>
        <span style={{ ...LABEL, color: 'var(--faint)' }}>
          {log.length} action{log.length === 1 ? '' : 's'}
        </span>
      </div>
      {log.length === 0 && (
        <div style={S.emptyCol}>Nothing yet. Hires, assignments and reports land here.</div>
      )}
      <div style={S.ledger}>
        {log.map((i) => {
          const d = DID[i.kind]
          return (
            <div key={i.id} style={{ ...S.entry, borderLeft: `3px solid ${d.color}` }}>
              <div style={S.entryHead}>
                <span style={{ ...LABEL, color: d.color }}>{d.label}</span>
                <span style={{ flex: 1 }} />
                <span style={{ ...LABEL, color: 'var(--faint)' }}>{ago(i.ts, now)} ago</span>
              </div>
              <div style={S.entryText} title={i.text}>
                {i.text}
              </div>
            </div>
          )
        })}
      </div>
      <p style={S.note}>
        This is what your clone has done, not a list to work through: what
        reaches them goes straight back out, and they are who reports to you.
        Everyone else on the floor works a board.
      </p>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  ledgerHead: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 },
  ledger: { display: 'flex', flexDirection: 'column', gap: 6 },
  entry: { background: 'var(--panel)', border: '1px solid var(--line)', padding: '6px 9px' },
  entryHead: { display: 'flex', alignItems: 'baseline', gap: 8 },
  // Two lines, then an ellipsis: a mail subject and body run long, and this is
  // a log you scan rather than read.
  entryText: {
    marginTop: 3,
    fontSize: 11,
    color: 'var(--muted)',
    lineHeight: 1.45,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden'
  } as React.CSSProperties,
  columnOver: { background: 'color-mix(in srgb, var(--accent) 12%, transparent)' },
  cardHeld: { opacity: 0.45 },
  // Four lines, then an ellipsis: an assignment written by an agent runs to a
  // paragraph, and the card is a marker for it rather than the document.
  cardText: {
    flex: 1,
    lineHeight: 1.45,
    display: '-webkit-box',
    WebkitLineClamp: 4,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden'
  } as React.CSSProperties,
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
  btnOff: { opacity: 0.4, cursor: 'default' },
  btn: {
    padding: '6px 12px',
    background: 'var(--accent)',
    color: '#241f1a',
    border: '1px solid var(--accent)',
    cursor: 'pointer',
    font: `11px ${MONO}`
  },
  board: { display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 10 },
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
    fontSize: 11,
    cursor: 'grab'
  },
  cardFoot: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 },
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
