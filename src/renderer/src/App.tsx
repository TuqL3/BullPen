import { useEffect, useState } from 'react'
import { AddAgent, type Draft } from './AddAgent'
import { Avatar } from './Avatar'
import { Commands } from './Commands'
import { Floor } from './floor/Floor'
import { AskMe } from './tabs/AskMe'
import { Graph } from './tabs/Graph'
import { Memory } from './tabs/Memory'
import { Monitor } from './tabs/Monitor'
import { Tasks } from './tabs/Tasks'
import { Triggers } from './tabs/Triggers'
import { Workers } from './tabs/Workers'
import { slug } from './avatar'
import { setTerminalTheme, TerminalDeck, writeToTerminal } from './Terminal'
import { LABEL, MONO, VARS, type Mode } from './theme'
import { useStore, type Agent, type Approval } from './store'

const TABS = [
  'terminal',
  'monitor',
  'tasks',
  'ask me',
  'triggers',
  'memory',
  'graph',
  'activity',
  'commands',
  'workers'
] as const
type Tab = (typeof TABS)[number]

/**
 * Roster grouping is by workspace folder: agents sharing a directory are
 * working on the same thing, which is the question you actually ask when
 * scanning the list.
 */
function byFolder(agents: Agent[]): { label: string; rows: Agent[] }[] {
  const groups = new Map<string, Agent[]>()
  for (const a of agents) {
    const label = a.cwd.split(/[/\\]/).filter(Boolean).pop() ?? a.cwd
    groups.set(label, [...(groups.get(label) ?? []), a])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, rows]) => ({ label, rows }))
}

const DOT: Record<string, string> = {
  working: 'var(--ok)',
  blocked: 'var(--warn)',
  idle: 'var(--faint)',
  exited: 'var(--faint)'
}

/** Module scope so throttling survives re-renders without a ref per agent. */
const lastTouch: Record<string, number> = {}

export default function App() {
  const { agents, approvals, mail, queue, steers, lastSeen, selected, select } = useStore()
  const store = useStore.getState

  const [mode, setMode] = useState<Mode>('light')
  const [tab, setTab] = useState<Tab>('terminal')
  const [floorOn, setFloorOn] = useState(true)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [steerText, setSteerText] = useState('')

  useEffect(() => setTerminalTheme(mode), [mode])

  useEffect(() => {
    const off = [
      window.bullpen.onData((id, chunk) => {
        writeToTerminal(id, chunk)
        // Throttled: pty output arrives dozens of times a second, and a store
        // write per chunk would re-render the whole tree continuously.
        const now = Date.now()
        if (now - (lastTouch[id] ?? 0) > 2000) {
          lastTouch[id] = now
          store().touch(id, now)
        }
      }),
      window.bullpen.onExit((id, code) =>
        store().upsertAgent({ id, status: 'exited', exitCode: code, activity: 'idle' })
      ),
      window.bullpen.onStatus((id, status) => {
        store().upsertAgent({ id, activity: status })
        // One message per idle transition, not the whole backlog at once:
        // sending it flips the agent back to working, and the next Stop pulls
        // the following one.
        if (status === 'idle') {
          const next = store().shift(id)
          if (next) window.bullpen.write(id, next.replace(/\n/g, ' ') + '\r')
        }
      }),
      window.bullpen.onSteerQueued((id) => {
        window.bullpen.steers(id).then((notes) => store().setSteers(id, notes))
      }),
      window.bullpen.onSteerDelivered((id, notes) => {
        store().setSteers(id, [])
        store().addMail({
          from: 'you',
          to: id,
          subject: `steer delivered · ${notes.join(' | ').slice(0, 80)}`,
          ts: Date.now()
        })
      }),
      window.bullpen.onTrust((id, sandbox) =>
        store().addMail({ from: 'bullpen', to: id, subject: `auto-accepted workspace trust · ${sandbox}`, ts: Date.now() })
      ),
      window.bullpen.onPending((p) => store().addApproval(p as Approval)),
      window.bullpen.onResolved((p) => store().removeApproval((p as Approval).id)),
      window.bullpen.onDeliver((d) => {
        const { to, msg } = d as { to: string; msg: { from: string; subject: string; ts: number } }
        store().addMail({ to, from: msg.from, subject: msg.subject, ts: msg.ts })
      })
    ]
    return () => off.forEach((fn) => fn())
  }, [])

  // Anything waiting on a human outranks whatever tab you were reading.
  useEffect(() => {
    if (approvals.length > 0) setTab('ask me')
  }, [approvals.length])

  const current = agents.find((a) => a.id === selected) ?? null

  /** Returns an error string for the wizard to show, or null on success. */
  const spawnFrom = async (d: Draft): Promise<string | null> => {
    const id = slug(d.name)
    try {
      const state = await window.bullpen.spawn({
        id,
        cwd: d.cwd.trim(),
        cmd: d.cmd.trim() || 'claude',
        args: d.args.trim() ? d.args.trim().split(/\s+/) : []
      })
      store().upsertAgent({
        id,
        name: d.name.trim(),
        face: d.face,
        color: d.color,
        cwd: state.cwd,
        pid: state.pid,
        startedAt: state.startedAt,
        status: 'running',
        // A freshly booted agent is sitting at its prompt, not working. It has
        // submitted nothing, so no Stop hook will ever arrive to correct an
        // optimistic 'working' - it would stay wrong until its first real turn.
        activity: 'idle'
      })
      select(id)
      setTab('terminal')
      setAdding(false)

      // ponytail: fixed delay, because the CLI gives no ready signal on the pty.
      // Ceiling - a slow cold start swallows the briefing. Upgrade path: watch
      // the stream for the prompt marker before writing.
      if (d.briefing.trim()) {
        setTimeout(() => window.bullpen.write(id, d.briefing.replace(/\n/g, ' ') + '\r'), 4000)
      }
      return null
    } catch (err) {
      // Main rejects on a refused sandbox; swallowing it would look exactly
      // like the spawn button doing nothing.
      return err instanceof Error
        ? err.message.replace(/^Error invoking remote method[^:]*: /, '')
        : String(err)
    }
  }

  const busy = current?.status === 'running' && current.activity === 'working'

  const send = (): void => {
    if (!selected || !draft.trim()) return
    // Typing into a busy agent's prompt drops text into the middle of its turn,
    // so it waits for the Stop hook instead. Use steer to reach it right now.
    if (busy) store().enqueue(selected, draft.trim())
    else window.bullpen.write(selected, draft.replace(/\n/g, ' ') + '\r')
    setDraft('')
  }

  const steer = (): void => {
    if (!selected || !steerText.trim()) return
    window.bullpen.steer(selected, steerText.trim())
    setSteerText('')
  }

  return (
    <div style={{ ...(VARS[mode] as React.CSSProperties), ...S.app }}>
      <TitleBar
        mode={mode}
        onToggle={() => setMode(mode === 'light' ? 'dark' : 'light')}
        floorOn={floorOn}
        onToggleFloor={() => setFloorOn(!floorOn)}
      />

      <div style={floorOn ? S.bodyWithFloor : S.body}>
        <aside style={S.roster}>
          <button style={{ ...S.btn, width: '100%', marginBottom: 12 }} onClick={() => setAdding(true)}>
            + agent
          </button>

          {agents.length === 0 && <div style={S.empty}>No one hired yet.</div>}
          {byFolder(agents).map(({ label, rows }) => {
            return (
              <div key={label} style={{ marginBottom: 10 }}>
                <div style={{ ...LABEL, color: 'var(--faint)', margin: '0 0 4px 4px' }}>{label}</div>
                {rows.map((a) => (
                  <RosterRow
                    key={a.id}
                    agent={a}
                    active={selected === a.id}
                    blocked={approvals.some((p) => p.agentId === a.id)}
                    onSelect={() => select(a.id)}
                    onKill={() => window.bullpen.kill(a.id)}
                  />
                ))}
              </div>
            )
          })}
        </aside>

        {floorOn && (
          <div style={S.floorPane}>
            <Floor mode={mode} onSelect={select} />
          </div>
        )}

        <main style={S.main}>
          <header style={S.header}>
            {current ? <Avatar id={current.face} shirt={current.color} size={30} /> : <div style={{ width: 30 }} />}
            <div style={{ flex: 1 }}>
              <div style={{ ...LABEL, color: 'var(--ink)', fontSize: 11 }}>
                {current ? current.name : 'command center'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                {current ? `${current.activity} · pid ${current.pid} · ${current.cwd}` : 'no agent selected'}
              </div>
            </div>
          </header>

          {current && (
            <div style={S.control}>
              <span style={{ ...LABEL, color: 'var(--faint)' }}>steer</span>
              <input
                style={S.steerInput}
                value={steerText}
                placeholder={
                  busy
                    ? 'injected as context on its next tool call — no typing into its terminal'
                    : 'steer reaches a working agent; this one is idle, just message it'
                }
                onChange={(e) => setSteerText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && steer()}
              />
              <button style={S.btn} onClick={steer}>
                steer
              </button>
              {(steers[current.id]?.length ?? 0) > 0 && (
                <span style={{ ...LABEL, color: 'var(--warn)' }}>
                  {steers[current.id].length} waiting
                </span>
              )}
              <button style={{ ...S.btn, ...S.btnDanger }} onClick={() => window.bullpen.kill(current.id)}>
                halt
              </button>
            </div>
          )}

          <nav style={S.tabs}>
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{ ...S.tab, ...(tab === t ? S.tabActive : null) }}
              >
                {t}
                {t === 'ask me' && approvals.length > 0 && <span style={S.badge}>{approvals.length}</span>}
              </button>
            ))}
          </nav>

          <section style={S.panel}>
            {/* The terminal stays mounted: unmounting it would drop scrollback. */}
            <div style={{ height: '100%', display: tab === 'terminal' ? 'block' : 'none' }}>
              {agents.length === 0 && <div style={S.empty}>Hire someone to start.</div>}
              <TerminalDeck ids={agents.map((a) => a.id)} selected={selected} />
            </div>
            {tab === 'monitor' && <Monitor agents={agents} lastSeen={lastSeen} />}
            {tab === 'tasks' && <Tasks agent={current} />}
            {tab === 'ask me' && <AskMe approvals={approvals} agents={agents} />}
            {tab === 'triggers' && <Triggers agent={current} />}
            {tab === 'memory' && <Memory agent={current} />}
            {tab === 'graph' && <Graph agents={agents} mail={mail} />}
            {tab === 'activity' && <Activity mail={mail} />}
            {tab === 'commands' && <Commands />}
            {tab === 'workers' && <Workers agents={agents} onSelect={select} />}
          </section>

          {tab === 'terminal' && selected && (
            <footer>
              {(queue[selected]?.length ?? 0) > 0 && (
                <div style={S.queue}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ ...LABEL, color: 'var(--ink)' }}>queue</span>
                    <span style={{ ...LABEL, color: 'var(--warn)' }}>{queue[selected].length}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)', flex: 1 }}>
                      {selected} is busy — sent one at a time as it frees up
                    </span>
                    <button style={S.linkBtn} onClick={() => store().clearQueue(selected)}>
                      clear all
                    </button>
                  </div>
                  {queue[selected].map((q, i) => (
                    <div key={i} style={S.queueRow}>
                      <span style={{ color: 'var(--faint)' }}>{i + 1}.</span>
                      <span style={{ flex: 1 }}>{q}</span>
                      <button style={S.linkBtn} onClick={() => store().removeQueued(selected, i)}>
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div style={S.composer}>
                <textarea
                  style={S.draft}
                  rows={2}
                  value={draft}
                  placeholder={busy ? `${selected} is busy — queue a message` : `message ${selected}`}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      send()
                    }
                  }}
                />
                <button style={{ ...S.btn, ...S.btnPrimary }} onClick={send}>
                  {busy ? 'queue' : 'send →'}
                </button>
              </div>
            </footer>
          )}
        </main>
      </div>

      <Dock agents={agents} selected={selected} approvals={approvals} onSelect={select} />

      {adding && (
        <AddAgent taken={agents.map((a) => a.id)} onCancel={() => setAdding(false)} onSpawn={spawnFrom} />
      )}
    </div>
  )
}

function TitleBar({
  mode,
  onToggle,
  floorOn,
  onToggleFloor
}: {
  mode: Mode
  onToggle: () => void
  floorOn: boolean
  onToggleFloor: () => void
}) {
  return (
    <div style={S.titlebar}>
      {/* Leaves room for the macOS traffic lights, which stay native. */}
      <div style={{ width: 72 }} />
      <div style={{ ...LABEL, color: 'var(--ink)', fontSize: 11, fontWeight: 700 }}>Bullpen</div>
      <div style={{ flex: 1 }} />
      <button
        style={{
          ...S.iconBtn,
          WebkitAppRegion: 'no-drag',
          color: floorOn ? 'var(--accent-ink)' : 'var(--muted)'
        } as React.CSSProperties}
        onClick={onToggleFloor}
      >
        floor
      </button>
      {/* Text, not glyphs: ☾/⛶ fall back to tofu in most monospace faces. */}
      <button style={{ ...S.iconBtn, WebkitAppRegion: 'no-drag' } as React.CSSProperties} onClick={onToggle}>
        {mode === 'light' ? 'dark' : 'light'}
      </button>
      <button
        style={{ ...S.iconBtn, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={() => window.bullpen.toggleMaximize()}
      >
        full
      </button>
    </div>
  )
}

function RosterRow({
  agent,
  active,
  blocked,
  onSelect,
  onKill
}: {
  agent: Agent
  active: boolean
  blocked: boolean
  onSelect: () => void
  onKill: () => void
}) {
  const status = agent.status === 'exited' ? 'exited' : blocked ? 'blocked' : agent.activity
  return (
    <div data-agent={agent.id} onClick={onSelect} style={{ ...S.row, ...(active ? S.rowActive : null) }}>
      <Avatar id={agent.face} shirt={agent.color} size={28} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...LABEL, color: 'var(--ink)', fontSize: 10 }}>{agent.name}</div>
        <div
          title={agent.cwd}
          style={{ fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {agent.cwd.split('/').pop() || agent.cwd}
        </div>
      </div>
      <span style={{ ...S.dot, background: DOT[status] }} />
      {agent.status === 'running' && (
        <span
          style={S.kill}
          title="stop this agent"
          onClick={(e) => {
            e.stopPropagation()
            onKill()
          }}
        >
          ×
        </span>
      )}
    </div>
  )
}

function Activity({ mail }: { mail: { from: string; to: string; subject: string; ts: number }[] }) {
  if (mail.length === 0) return <div style={{ ...S.empty, padding: 18 }}>Quiet floor. No mail yet.</div>
  return (
    <div style={{ padding: 14, overflowY: 'auto', height: '100%' }}>
      {mail
        .slice()
        .reverse()
        .map((m, i) => (
          <div key={i} style={S.mailRow}>
            <Avatar id={m.from} size={20} />
            <span style={{ ...LABEL, fontSize: 10, color: 'var(--ink)' }}>{m.from}</span>
            <span style={{ color: 'var(--faint)' }}>→</span>
            <Avatar id={m.to} size={20} />
            <span style={{ ...LABEL, fontSize: 10, color: 'var(--ink)' }}>{m.to}</span>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--muted)' }}>{m.subject}</span>
            <span style={{ fontSize: 10, color: 'var(--faint)' }}>
              {new Date(m.ts).toLocaleTimeString()}
            </span>
          </div>
        ))}
    </div>
  )
}

function Dock({
  agents,
  selected,
  approvals,
  onSelect
}: {
  agents: Agent[]
  selected: string | null
  approvals: Approval[]
  onSelect: (id: string) => void
}) {
  return (
    <div style={S.dock}>
      {agents.length === 0 && <div style={{ ...S.empty, padding: '0 12px' }}>floor is empty</div>}
      {agents.map((a) => {
        const blocked = approvals.some((p) => p.agentId === a.id)
        const status = a.status === 'exited' ? 'exited' : blocked ? 'blocked' : a.activity
        return (
          <div
            key={a.id}
            onClick={() => onSelect(a.id)}
            style={{ ...S.dockCard, ...(selected === a.id ? S.dockCardActive : null) }}
          >
            <Avatar id={a.face} shirt={a.color} size={38} />
            <div style={{ minWidth: 0 }}>
              <div style={{ ...LABEL, color: 'var(--ink)', fontSize: 10 }}>{a.name}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ ...S.dot, background: DOT[status] }} />
                <span style={{ fontSize: 10, color: 'var(--muted)' }}>{status}</span>
              </div>
              <div style={S.meter}>
                <div style={{ ...S.meterFill, background: DOT[status], width: status === 'working' ? '70%' : '12%' }} />
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  app: {
    display: 'grid',
    gridTemplateRows: '34px 1fr 74px',
    height: '100vh',
    overflow: 'hidden',
    background: 'var(--bg)',
    color: 'var(--ink)',
    font: `12px ${MONO}`
  },
  titlebar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 10px',
    borderBottom: '1px solid var(--line)',
    background: 'var(--panel)',
    WebkitAppRegion: 'drag'
  } as React.CSSProperties,
  iconBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--muted)',
    cursor: 'pointer',
    fontSize: 13,
    padding: '2px 6px'
  },
  body: { display: 'grid', gridTemplateColumns: '204px 1fr', minHeight: 0 },
  // Floor on the left, command centre on the right - the windowed layout.
  bodyWithFloor: { display: 'grid', gridTemplateColumns: '204px 1.35fr 1fr', minHeight: 0 },
  floorPane: { minWidth: 0, minHeight: 0, borderRight: '1px solid var(--line)', overflow: 'hidden' },
  roster: {
    borderRight: '1px solid var(--line)',
    background: 'var(--panel)',
    padding: 10,
    overflowY: 'auto'
  },
  main: { display: 'grid', gridTemplateRows: 'auto auto auto 1fr auto', minHeight: 0, minWidth: 0 },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    borderBottom: '1px solid var(--line)'
  },
  control: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 14px',
    borderBottom: '1px solid var(--line)',
    background: 'var(--panel)'
  },
  steerInput: {
    flex: 1,
    padding: '5px 8px',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    font: `11px ${MONO}`
  },
  linkBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--faint)',
    cursor: 'pointer',
    font: `10px ${MONO}`,
    textTransform: 'uppercase',
    letterSpacing: '0.12em'
  },
  queue: {
    padding: '10px 14px',
    borderTop: '1px solid var(--line)',
    background: 'var(--sunk)',
    maxHeight: 150,
    overflowY: 'auto'
  },
  queueRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    padding: '3px 0',
    fontSize: 11,
    color: 'var(--muted)'
  },
  // Ten tabs in a pane that shrinks when the floor is open: scroll rather than
  // wrap, so a tab never splits across two lines or falls off the edge unseen.
  tabs: {
    display: 'flex',
    gap: 2,
    padding: '0 10px',
    borderBottom: '1px solid var(--line)',
    overflowX: 'auto',
    scrollbarWidth: 'thin'
  },
  tab: {
    ...LABEL,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: 'transparent',
    border: 'none',
    padding: '7px 11px',
    margin: '5px 0',
    flex: '0 0 auto',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    font: `10px ${MONO}`,
    textTransform: 'uppercase',
    letterSpacing: '0.14em'
  },
  tabActive: { color: '#241f1a', background: 'var(--accent)' },
  badge: {
    background: 'var(--warn)',
    color: '#fff',
    borderRadius: 8,
    padding: '0 5px',
    fontSize: 9,
    letterSpacing: 0
  },
  panel: { minHeight: 0, overflow: 'hidden', background: 'var(--term-bg)' },
  composer: {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-end',
    padding: 10,
    borderTop: '1px solid var(--line)',
    background: 'var(--panel)'
  },
  draft: {
    flex: 1,
    resize: 'none',
    padding: 8,
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    font: `12px ${MONO}`
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 8px',
    marginBottom: 6,
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    font: `11px ${MONO}`
  },
  btn: {
    padding: '6px 10px',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    cursor: 'pointer',
    font: `11px ${MONO}`
  },
  btnPrimary: { background: 'var(--accent)', color: '#241f1a', borderColor: 'var(--accent)' },
  btnDanger: { color: 'var(--danger)', borderColor: 'var(--danger)' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 6px',
    marginBottom: 2,
    border: '1px solid transparent',
    cursor: 'pointer'
  },
  rowActive: { background: 'var(--sunk)', borderColor: 'var(--line)' },
  dot: { width: 7, height: 7, borderRadius: 7, flex: '0 0 auto' },
  kill: { color: 'var(--faint)', padding: '0 3px' },
  error: { color: 'var(--danger)', fontSize: 11, marginBottom: 10, whiteSpace: 'pre-wrap' },
  empty: { color: 'var(--faint)', fontSize: 11, padding: '8px 0' },
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
  mailRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '5px 0',
    borderTop: '1px solid var(--line)'
  },
  dock: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    padding: '0 10px',
    borderTop: '1px solid var(--line)',
    background: 'var(--panel)',
    overflowX: 'auto'
  },
  dockCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    border: '1px solid var(--line)',
    background: 'var(--bg)',
    cursor: 'pointer',
    flex: '0 0 auto',
    minWidth: 132
  },
  dockCardActive: { borderColor: 'var(--accent)' },
  meter: { height: 3, background: 'var(--line)', marginTop: 4, width: 76 },
  meterFill: { height: '100%' }
}
