import { Fragment, useEffect, useRef, useState } from 'react'
import { AddAgent, type Draft } from './AddAgent'
import { Avatar } from './Avatar'
import { Commands } from './Commands'
import { Floor } from './floor/Floor'
import { AskMe } from './tabs/AskMe'
import { Activity } from './tabs/Activity'
import { Graph } from './tabs/Graph'
import { Memory } from './tabs/Memory'
import { Monitor } from './tabs/Monitor'
import { Tasks } from './tabs/Tasks'
import { Triggers } from './tabs/Triggers'
import { Workers } from './tabs/Workers'
import { projectOf, slug } from './avatar'
import { paneSize, setTerminalTheme, TerminalDeck, writeToTerminal } from './Terminal'
import { Code } from './Code'
import {
  bandOf,
  DEFAULT_LAYOUT,
  move as movePanel,
  moveToBand,
  normalise,
  PANEL_TITLE,
  PANELS,
  resize as resizePanels,
  setBottomPct,
  toggle as togglePanel,
  visible as visibleIn,
  type Band,
  type Layout,
  type PanelId
} from './layout'
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
 * The roster is a hierarchy, not a flat list: the operator's own clone sits
 * above everything, and the workers below it are grouped by project. That
 * shape is what dispatch, the graph centre and the activity log all key off.
 */
function byProject(agents: Agent[]): { label: string; rows: Agent[] }[] {
  const groups = new Map<string, Agent[]>()
  for (const a of agents.filter((x) => x.role !== 'god')) {
    const label = a.project || projectOf(a.cwd)
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
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT)
  const [dragging, setDragging] = useState<PanelId | null>(null)
  // Null when closed; otherwise the fields the wizard opens with. Hiring the
  // second agent into a project should not mean re-answering where it lives.
  const [adding, setAdding] = useState<Partial<Draft> | null>(null)
  const [draft, setDraft] = useState('')
  const [steerText, setSteerText] = useState('')
  const [moveError, setMoveError] = useState('')
  // Set on first run only: the suggested workspace, awaiting an answer.
  const [setupCwd, setSetupCwd] = useState<string | null>(null)

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
      window.bullpen.onCtx((id, ctx) => store().upsertAgent({ id, ctx })),
      window.bullpen.onCost((id, cost) => store().upsertAgent({ id, cost })),
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

  /** Put Michael in the store and open his terminal. */
  const adoptGod = (g: {
    id: string
    name: string
    cwd: string
    pid: number
    startedAt: number
    cols: number
    rows: number
  }): void => {
    store().upsertAgent({
      id: g.id,
      role: 'god',
      project: '',
      name: g.name,
      face: g.id,
      cwd: g.cwd,
      pid: g.pid,
      startedAt: g.startedAt,
      cols: g.cols,
      rows: g.rows,
      status: 'running',
      exitCode: undefined,
      activity: 'idle'
    })
    select(g.id)
  }

  // Michael is the floor's starting state, not a hire. Bringing him up here
  // rather than in the wizard is what makes "open the app and he is there"
  // true; main hands back the running one if this fires twice.
  //
  // On the very first run there is no answer yet to where he should work, and
  // picking one silently is how an agent ends up writing somewhere the operator
  // never looked - so that run asks first and starts nothing until it is told.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const setup = await window.bullpen.godSetup()
      if (cancelled) return
      if (!setup.chosen) return setSetupCwd(setup.cwd)
      const { cols, rows } = paneSize(document.querySelector('section'))
      try {
        const g = await window.bullpen.ensureGod({ cols, rows })
        if (!cancelled) adoptGod(g)
      } catch (err) {
        // A floor with no Michael still works - dispatch is what stops working,
        // and it already says so - but silence would look like he never existed.
        console.error('[bullpen] could not start Michael:', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Michael reads the floor from a file, so it has to be rewritten whenever the
  // roster or anyone's status changes. Main skips the write when nothing moved.
  useEffect(() => {
    window.bullpen.publishFloor(
      agents.map((a) => ({
        id: a.id,
        name: a.name,
        project: a.role === 'god' ? '' : a.project || projectOf(a.cwd),
        cwd: a.cwd,
        status: a.status,
        activity: a.activity,
        pid: a.pid,
        ctxPct: a.ctx?.pct,
        model: a.ctx?.model,
        costUsd: a.cost?.usd
      }))
    )
  }, [agents])

  useEffect(() => {
    window.bullpen.layout().then((raw) => setLayout(normalise(raw)))
  }, [])

  /** Every layout change is persisted; there is no separate save action. */
  const applyLayout = (next: Layout): void => {
    setLayout(next)
    window.bullpen.saveLayout(next)
  }

  // Anything waiting on a human outranks whatever tab you were reading.
  useEffect(() => {
    if (approvals.length > 0) setTab('ask me')
  }, [approvals.length])

  const current = agents.find((a) => a.id === selected) ?? null

  /** Returns an error string for the wizard to show, or null on success. */
  const spawnFrom = async (d: Draft): Promise<string | null> => {
    const id = slug(d.name)
    try {
      // Start the pty at the size of the pane it will appear in, so the CLI's
      // first paint is not drawn to a width the terminal never actually had.
      const { cols, rows } = paneSize(document.querySelector('section'))
      const state = await window.bullpen.spawn({
        id,
        cwd: d.cwd.trim(),
        cmd: d.cmd.trim() || 'claude',
        args: d.args.trim() ? d.args.trim().split(/\s+/) : [],
        cols,
        rows
      })
      store().upsertAgent({
        id,
        role: d.role,
        project: d.role === 'god' ? '' : d.project.trim() || projectOf(d.cwd.trim()),
        name: d.name.trim(),
        face: d.face,
        color: d.color,
        cwd: state.cwd,
        pid: state.pid,
        startedAt: state.startedAt,
        cols: state.cols,
        rows: state.rows,
        status: 'running',
        // A freshly booted agent is sitting at its prompt, not working. It has
        // submitted nothing, so no Stop hook will ever arrive to correct an
        // optimistic 'working' - it would stay wrong until its first real turn.
        activity: 'idle'
      })
      if (d.role === 'god') window.bullpen.setGod(id)
      select(id)
      setTab('terminal')
      setAdding(null)

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

  /**
   * Michael's workspace is a setting, not a fixture. The CLI reads its working
   * directory once at startup, so moving him is a restart - the conversation in
   * his terminal does not survive it, and that is worth saying out loud before
   * it happens rather than after.
   */
  const moveGod = async (): Promise<void> => {
    const dir = await window.bullpen.pickDir()
    if (!dir) return
    if (!confirm(`Restart Michael in ${dir}?\n\nHis current conversation is lost.`)) return
    setMoveError('')
    const { cols, rows } = paneSize(document.querySelector('section'))
    const res = await window.bullpen.moveGod(dir, { cols, rows })
    if ('error' in res) return setMoveError(res.error)
    adoptGod(res)
  }

  /** First run: accept a workspace for Michael and bring him up in it. */
  const chooseGodHome = async (dir: string): Promise<string | null> => {
    const { cols, rows } = paneSize(document.querySelector('section'))
    const res = await window.bullpen.moveGod(dir, { cols, rows })
    if ('error' in res) return res.error
    adoptGod(res)
    setSetupCwd(null)
    return null
  }

  const steer = (): void => {
    if (!selected || !steerText.trim()) return
    window.bullpen.steer(selected, steerText.trim())
    setSteerText('')
  }

  const panes: Record<PanelId, React.ReactNode> = {
    roster: (
        <aside style={S.roster}>
          <button style={{ ...S.btn, width: '100%', marginBottom: 12 }} onClick={() => setAdding({})}>
            + agent
          </button>

          {agents.length === 0 && <div style={S.empty}>No one hired yet.</div>}

          {agents
            .filter((a) => a.role === 'god')
            .map((a) => (
              <RosterRow
                key={a.id}
                agent={a}
                god
                active={selected === a.id}
                blocked={approvals.some((p) => p.agentId === a.id)}
                onSelect={() => select(a.id)}
                onKill={() => window.bullpen.kill(a.id)}
              />
            ))}

          {byProject(agents).map(({ label, rows }) => {
            return (
              <div key={label} style={{ marginBottom: 10 }}>
                <div style={S.groupHead}>
                  <span style={{ ...LABEL, color: 'var(--faint)' }}>{label}</span>
                  <button
                    title={`hire into ${label}`}
                    aria-label={`hire into ${label}`}
                    style={S.groupAdd}
                    // Same directory and project as the agents already there, so
                    // the second hire only needs a name.
                    onClick={() => setAdding({ project: label, cwd: rows[0].cwd })}
                  >
                    +
                  </button>
                </div>
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
    ),
    floor: <Floor mode={mode} onSelect={select} />,
    code: <Code agent={current} />,
    command: (
        <main style={S.main}>
          <header style={S.header}>
            {current ? <Avatar id={current.face} shirt={current.color} size={30} /> : <div style={{ width: 30 }} />}
            <div style={{ flex: 1 }}>
              <div style={{ ...LABEL, color: 'var(--ink)', fontSize: 11 }}>
                {current ? current.name : 'command center'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                {current ? `${current.activity} · pid ${current.pid} · ${current.cwd}` : 'no agent selected'}
                {current?.role === 'god' && (
                  <button style={S.linkBtn} onClick={moveGod}>
                    move
                  </button>
                )}
              </div>
              {moveError && (
                <div style={{ fontSize: 11, color: 'var(--danger)' }}>{moveError}</div>
              )}
            </div>
            <div>{current && <CtxMeter ctx={current.ctx} />}</div>
            <div style={{ display: 'none' }}>
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
            {tab === 'tasks' && <Tasks agents={agents} />}
            {tab === 'ask me' && <AskMe approvals={approvals} agents={agents} />}
            {tab === 'triggers' && <Triggers agent={current} />}
            {tab === 'memory' && <Memory agents={agents} selected={selected} />}
            {tab === 'graph' && <Graph agents={agents} mail={mail} />}
            {tab === 'activity' && <Activity />}
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
    )
  }

  return (
    <div style={{ ...(VARS[mode] as React.CSSProperties), ...S.app }}>
      <TitleBar
        mode={mode}
        onToggle={() => setMode(mode === 'light' ? 'dark' : 'light')}
        layout={layout}
        onTogglePanel={(id) => applyLayout(togglePanel(layout, id))}
      />

      <div
        data-layout={`${visibleIn(layout, 'top').join(',')}|${visibleIn(layout, 'bottom').join(',')}`}
        style={S.body}
      >
        <Band
          band="top"
          layout={layout}
          panes={panes}
          dragging={dragging}
          onDragStart={setDragging}
          onDragEnd={() => setDragging(null)}
          onDropOn={(from, target) => applyLayout(movePanel(layout, from, target))}
          onDropIn={(from, band) => applyLayout(moveToBand(layout, from, band))}
          onResize={(l, r, d) => applyLayout(resizePanels(layout, l, r, d))}
        />
        {visibleIn(layout, 'top').length > 0 && visibleIn(layout, 'bottom').length > 0 && (
          <BandSplitter onDrag={(pct) => applyLayout(setBottomPct(layout, pct))} />
        )}
        <Band
          band="bottom"
          layout={layout}
          panes={panes}
          dragging={dragging}
          onDragStart={setDragging}
          onDragEnd={() => setDragging(null)}
          onDropOn={(from, target) => applyLayout(movePanel(layout, from, target))}
          onDropIn={(from, band) => applyLayout(moveToBand(layout, from, band))}
          onResize={(l, r, d) => applyLayout(resizePanels(layout, l, r, d))}
        />
      </div>

      <Dock agents={agents} selected={selected} approvals={approvals} onSelect={select} />

      {adding && (
        <AddAgent
          taken={agents.map((a) => a.id)}
          prefill={adding}
          onCancel={() => setAdding(null)}
          onSpawn={spawnFrom}
        />
      )}

      {setupCwd !== null && <FirstRun suggested={setupCwd} onChoose={chooseGodHome} />}
    </div>
  )
}

/**
 * Context window usage, read from the agent's transcript rather than scraped
 * from its terminal. Blank until the agent has completed a turn - there is no
 * usage record before then, and a fabricated zero would read as "plenty left".
 */
export function CtxMeter({ ctx }: { ctx?: Agent['ctx'] }) {
  if (!ctx) return <span style={{ ...LABEL, color: 'var(--faint)' }}>ctx —</span>
  const k = (n: number) => `${Math.round(n / 1000)}k`
  const colour = ctx.pct >= 85 ? 'var(--danger)' : ctx.pct >= 60 ? 'var(--warn)' : 'var(--ok)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} title={ctx.model}>
      <span style={{ ...LABEL, color: 'var(--muted)' }}>
        ctx {k(ctx.used)}/{k(ctx.limit)}
      </span>
      <div style={S.meterTrack}>
        <div style={{ ...S.meterBar, width: `${Math.max(2, ctx.pct)}%`, background: colour }} />
      </div>
      <span style={{ ...LABEL, color: colour }}>{ctx.pct}%</span>
    </div>
  )
}

/**
 * Inline SVG, not font glyphs. ☾/⛶ and friends fall back to tofu in the
 * monospace faces this UI uses - that was a real defect, not a preference.
 */
function Icon({
  name,
  size = 13
}: {
  name: 'floor' | 'sun' | 'moon' | 'full' | 'min' | 'close' | 'roster' | 'command' | 'code'
  size?: number
}) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    style: { display: 'block' }
  }
  if (name === 'floor')
    return (
      <svg {...common} aria-hidden>
        <rect x="1.5" y="2.5" width="13" height="11" />
        <path d="M1.5 7h13M6.5 7v6.5M10.5 2.5v4.5" />
      </svg>
    )
  if (name === 'moon')
    return (
      <svg {...common} aria-hidden>
        <path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1Z" />
      </svg>
    )
  if (name === 'sun')
    return (
      <svg {...common} aria-hidden>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2 3.1 3.1" />
      </svg>
    )
  if (name === 'roster')
    return (
      <svg {...common} aria-hidden>
        <path d="M2 4h3v3H2zM2 10.5h3v3H2z" />
        <path d="M7.5 5.5h6.5M7.5 12h6.5" />
      </svg>
    )
  if (name === 'command')
    return (
      <svg {...common} aria-hidden>
        <rect x="1.5" y="2.5" width="13" height="11" />
        <path d="M4 6l2.2 2L4 10M8.2 10.5h3.6" />
      </svg>
    )
  if (name === 'code')
    return (
      <svg {...common} aria-hidden>
        <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
      </svg>
    )
  if (name === 'min')
    return (
      <svg {...common} aria-hidden>
        <path d="M2.5 8h11" />
      </svg>
    )
  if (name === 'close')
    return (
      <svg {...common} aria-hidden>
        <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
      </svg>
    )
  return (
    <svg {...common} aria-hidden>
      <path d="M6 1.5H1.5V6M10 1.5h4.5V6M10 14.5h4.5V10M6 14.5H1.5V10" />
    </svg>
  )
}

/**
 * First run, and the only thing it asks: where Michael works.
 *
 * Not skippable. A default would be one machine's home directory imposed on
 * every other, and an agent writing somewhere the operator never looked is a
 * worse outcome than one more click on the first launch.
 */
function FirstRun({
  suggested,
  onChoose
}: {
  suggested: string
  onChoose: (dir: string) => Promise<string | null>
}) {
  const [dir, setDir] = useState(suggested)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const go = async (): Promise<void> => {
    if (!dir.trim()) return setError('Michael needs a directory to work in.')
    setBusy(true)
    setError((await onChoose(dir.trim())) ?? '')
    setBusy(false)
  }

  return (
    <div style={S.modalWrap}>
      <div style={{ ...S.modal, width: 520 }}>
        <div style={{ ...LABEL, color: 'var(--ink)', fontSize: 12, fontWeight: 700 }}>
          Where should Michael work?
        </div>
        <p style={S.firstRunBlurb}>
          Michael stands in for you: you dispatch through him and he is the one agent that can
          see the whole floor. He needs a directory of his own — he may write freely inside it,
          and nowhere else. You can move him later from his header.
        </p>
        <div style={{ display: 'flex', gap: 8, margin: '4px 0 8px' }}>
          <input
            data-field="godcwd"
            style={S.firstRunInput}
            value={dir}
            spellCheck={false}
            onChange={(e) => setDir(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
          <button
            style={S.btn}
            onClick={async () => {
              const picked = await window.bullpen.pickDir()
              if (picked) setDir(picked)
            }}
          >
            browse
          </button>
        </div>
        {error && <div style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 8 }}>{error}</div>}
        <button style={{ ...S.btn, ...S.btnPrimary }} disabled={busy} onClick={go}>
          {busy ? 'starting…' : 'start Michael here'}
        </button>
      </div>
    </div>
  )
}

/**
 * One horizontal band of panels, with a draggable divider between each pair.
 *
 * The band itself is a drop target so a panel can be moved into an empty band -
 * without that, dragging the last panel out of the bottom band would make the
 * bottom band unreachable.
 */
function Band({
  band,
  layout,
  panes,
  dragging,
  onDragStart,
  onDragEnd,
  onDropOn,
  onDropIn,
  onResize
}: {
  band: Band
  layout: Layout
  panes: Record<PanelId, React.ReactNode>
  dragging: PanelId | null
  onDragStart: (id: PanelId) => void
  onDragEnd: () => void
  onDropOn: (from: PanelId, target: PanelId) => void
  onDropIn: (from: PanelId, band: Band) => void
  onResize: (left: PanelId, right: PanelId, delta: number) => void
}) {
  const row = useRef<HTMLDivElement>(null)
  const ids = visibleIn(layout, band)
  const other = visibleIn(layout, band === 'top' ? 'bottom' : 'top')

  // An empty band still needs to exist as a drop target, but only while there
  // is something to drop and somewhere for it to come from.
  if (ids.length === 0) {
    if (!dragging || other.length < 2) return null
    return (
      <div
        style={S.emptyBand}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const from = e.dataTransfer.getData('text/panel') as PanelId
          if (PANELS.includes(from)) onDropIn(from, band)
        }}
      >
        drop here
      </div>
    )
  }

  const height =
    other.length === 0 ? '1fr' : band === 'bottom' ? `${layout.bottomPct}%` : `${100 - layout.bottomPct}%`

  return (
    <div ref={row} style={{ ...S.band, height, gridTemplateColumns: cols(layout, ids) }}>
      {ids.map((id, i) => (
        <Fragment key={id}>
          {i > 0 && (
            <Splitter
              onDrag={(dx) => {
                const w = row.current?.clientWidth ?? 1
                onResize(ids[i - 1], id, dx / w)
              }}
            />
          )}
          <Pane
            id={id}
            dragging={dragging}
            onDragStart={() => onDragStart(id)}
            onDragEnd={onDragEnd}
            onDrop={(from) => onDropOn(from, id)}
          >
            {panes[id]}
          </Pane>
        </Fragment>
      ))}
    </div>
  )
}

/** Weights, with a 5px track for each divider between them. */
const cols = (layout: Layout, ids: PanelId[]): string =>
  ids.map((id) => `${layout.weight[id]}fr`).join(' 5px ')

/**
 * A divider you drag. Pointer capture rather than mousemove on window: the
 * pointer leaves the 5px track immediately, and without capture the drag stops
 * the moment it does.
 */
function Splitter({ onDrag, vertical = false }: { onDrag: (delta: number) => void; vertical?: boolean }) {
  const last = useRef(0)
  return (
    <div
      style={vertical ? S.splitterH : S.splitterV}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        last.current = vertical ? e.clientY : e.clientX
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        const now = vertical ? e.clientY : e.clientX
        onDrag(now - last.current)
        last.current = now
      }}
      onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
    />
  )
}

/** The divider between the bands, reported as a percentage of window height. */
function BandSplitter({ onDrag }: { onDrag: (pct: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} style={{ display: 'contents' }}>
      <Splitter
        vertical
        onDrag={(dy) => {
          const box = ref.current?.parentElement?.getBoundingClientRect()
          if (!box || box.height === 0) return
          // Read the live boundary rather than accumulating deltas, so a drag
          // that outruns the clamp does not build up a debt to unwind.
          const bottom = box.bottom - (ref.current?.nextElementSibling?.getBoundingClientRect().top ?? 0)
          onDrag(((bottom - dy) / box.height) * 100)
        }}
      />
    </div>
  )
}

/**
 * One panel, with a grip you can drag onto another to change the order.
 *
 * Native HTML5 drag and drop rather than a library: the whole interaction is
 * "pick up a header, drop it on a neighbour", and pointer-event dragging would
 * mean reimplementing what the platform already ships.
 */
function Pane({
  id,
  children,
  dragging,
  onDragStart,
  onDragEnd,
  onDrop
}: {
  id: PanelId
  children: React.ReactNode
  dragging: PanelId | null
  onDragStart: () => void
  onDragEnd: () => void
  onDrop: (from: PanelId) => void
}) {
  const [over, setOver] = useState(false)
  const isTarget = over && dragging !== null && dragging !== id

  return (
    <section
      data-pane={id}
      style={{ ...S.pane, ...(isTarget ? S.paneTarget : null) }}
      onDragOver={(e) => {
        // Without this the browser refuses the drop and fires nothing.
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const from = e.dataTransfer.getData('text/panel') as PanelId
        if (PANELS.includes(from)) onDrop(from)
      }}
    >
      <div
        draggable
        style={{ ...S.paneGrip, ...(dragging === id ? S.paneGripHeld : null) }}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/panel', id)
          e.dataTransfer.effectAllowed = 'move'
          onDragStart()
        }}
        onDragEnd={onDragEnd}
      >
        <span>{PANEL_TITLE[id]}</span>
        <span style={{ color: 'var(--faint)' }}>⠿</span>
      </div>
      <div style={S.paneBody}>{children}</div>
    </section>
  )
}

function TitleBar({
  mode,
  onToggle,
  layout,
  onTogglePanel
}: {
  mode: Mode
  onToggle: () => void
  layout: Layout
  onTogglePanel: (id: PanelId) => void
}) {
  return (
    <div style={S.titlebar}>
      {/* Leaves room for the macOS traffic lights, which stay native. */}
      <div style={{ width: window.bullpen.isMac ? 72 : 14 }} />
      <div style={{ ...LABEL, color: 'var(--ink)', fontSize: 11, fontWeight: 700 }}>Bullpen</div>
      <div style={{ flex: 1 }} />
      {/* Order here is fixed, so a toggle does not move when the panels are
          rearranged and the button under the cursor stays the one you meant. */}
      {PANELS.map((id) => {
        const on = !layout.hidden.includes(id)
        return (
          <button
            key={id}
            title={on ? `hide ${PANEL_TITLE[id]}` : `show ${PANEL_TITLE[id]}`}
            aria-label={`toggle ${PANEL_TITLE[id]}`}
            style={{
              ...S.panelToggle,
              WebkitAppRegion: 'no-drag',
              color: on ? 'var(--accent-ink)' : 'var(--faint)',
              borderColor: on ? 'var(--accent-ink)' : 'transparent'
            } as React.CSSProperties}
            onClick={() => onTogglePanel(id)}
          >
            <Icon name={id} />
          </button>
        )
      })}
      <button
        title={mode === 'light' ? 'switch to dark' : 'switch to light'}
        aria-label="toggle theme"
        style={{ ...S.iconBtn, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={onToggle}
      >
        <Icon name={mode === 'light' ? 'moon' : 'sun'} />
      </button>
      {/* On macOS the native traffic lights already do all three, and drawing
          a second set beside them is the wrong thing everywhere. */}
      {!window.bullpen.isMac && (
        <button
          title="minimise"
          aria-label="minimise window"
          style={{ ...S.iconBtn, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={() => window.bullpen.minimize()}
        >
          <Icon name="min" />
        </button>
      )}
      <button
        title="maximise"
        aria-label="maximise window"
        style={{ ...S.iconBtn, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={() => window.bullpen.toggleMaximize()}
      >
        <Icon name="full" />
      </button>
      {!window.bullpen.isMac && (
        <button
          title="close"
          aria-label="close window"
          style={{ ...S.iconBtn, ...S.closeBtn, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={() => window.bullpen.closeWindow()}
        >
          <Icon name="close" />
        </button>
      )}
    </div>
  )
}

function RosterRow({
  agent,
  god = false,
  active,
  blocked,
  onSelect,
  onKill
}: {
  agent: Agent
  god?: boolean
  active: boolean
  blocked: boolean
  onSelect: () => void
  onKill: () => void
}) {
  const status = agent.status === 'exited' ? 'exited' : blocked ? 'blocked' : agent.activity
  return (
    <div
      data-agent={agent.id}
      onClick={onSelect}
      style={{ ...S.row, ...(god ? S.rowGod : null), ...(active ? S.rowActive : null) }}
    >
      <Avatar id={agent.face} shirt={agent.color} size={god ? 34 : 28} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...LABEL, color: 'var(--ink)', fontSize: god ? 11 : 10 }}>
          {agent.name}
        </div>
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
    display: 'flex',
    alignItems: 'center',
    background: 'transparent',
    border: 'none',
    color: 'var(--muted)',
    cursor: 'pointer',
    padding: '4px 6px'
  },
  // Closing is the one titlebar action with no undo, so it does not look like
  // the toggles beside it.
  closeBtn: { color: 'var(--danger)', marginRight: 4 },
  body: { display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' },
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
  // Ten tabs in a pane that shrinks when the floor is open. Wrapping onto a
  // second row keeps every tab visible; a horizontal scroller hid the last ones
  // behind an edge nobody thinks to drag.
  tabs: {
    display: 'flex',
    flexWrap: 'wrap',
    rowGap: 0,
    gap: 2,
    padding: '0 10px',
    borderBottom: '1px solid var(--line)'
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
  pane: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    borderRight: '1px solid var(--line)',
    overflow: 'hidden'
  },
  paneTarget: { outline: '2px solid var(--accent)', outlineOffset: -2 },
  band: { display: 'grid', minHeight: 0, minWidth: 0 },
  emptyBand: {
    height: 40,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '2px dashed var(--accent)',
    color: 'var(--faint)',
    font: `10px ${MONO}`,
    letterSpacing: '0.09em',
    textTransform: 'uppercase'
  },
  splitterV: { cursor: 'col-resize', background: 'var(--line)' },
  splitterH: { cursor: 'row-resize', background: 'var(--line)', height: 5 },
  paneGrip: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '3px 8px',
    borderBottom: '1px solid var(--line)',
    background: 'var(--sunk)',
    color: 'var(--faint)',
    cursor: 'grab',
    userSelect: 'none',
    font: `10px ${MONO}`,
    letterSpacing: '0.09em',
    textTransform: 'uppercase'
  },
  paneGripHeld: { opacity: 0.5, cursor: 'grabbing' },
  paneBody: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' },
  panelToggle: {
    display: 'flex',
    alignItems: 'center',
    background: 'transparent',
    border: '1px solid transparent',
    cursor: 'pointer',
    padding: '3px 5px'
  },
  groupHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    margin: '0 4px 4px 4px'
  },
  groupAdd: {
    background: 'transparent',
    border: '1px solid var(--line)',
    color: 'var(--muted)',
    cursor: 'pointer',
    lineHeight: 1,
    padding: '1px 6px',
    font: `12px ${MONO}`
  },
  modalWrap: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50
  },
  modal: {
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    padding: 20,
    font: `12px ${MONO}`,
    color: 'var(--ink)'
  },
  firstRunBlurb: { fontSize: 11, color: 'var(--muted)', lineHeight: 1.6, margin: '10px 0 4px' },
  firstRunInput: {
    flex: 1,
    padding: '7px 9px',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    font: `12px ${MONO}`
  },
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
  rowGod: {
    borderColor: 'var(--line)',
    background: 'var(--sunk)',
    marginBottom: 12,
    padding: '9px 6px'
  },
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
  meterTrack: { width: 90, height: 6, background: 'var(--line)', flex: '0 0 auto' },
  meterBar: { height: '100%' },
  meterFill: { height: '100%' }
}
