import { Fragment, useEffect, useRef, useState } from 'react'
import { onEnter } from './keys'
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
import { FilePanel, openFile, WorkTree, type OpenFile } from './Code'
import { isShellId, Shell } from './Shell'
import {
  DEFAULT_LAYOUT,
  FIXED,
  moveTo,
  moveToNewColumn,
  normalise,
  PANEL_TITLE,
  PANELS,
  resizeColumns,
  resizeRows,
  toggle as togglePanel,
  visible as visibleColumns,
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
  const { agents, approvals, mail, steers, lastSeen, selected, select } = useStore()
  const store = useStore.getState

  const [mode, setMode] = useState<Mode>('light')
  const [tab, setTab] = useState<Tab>('terminal')
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT)
  const [dragging, setDragging] = useState<PanelId | null>(null)
  // Null when closed; otherwise the fields the wizard opens with. Hiring the
  // second agent into a project should not mean re-answering where it lives.
  const [adding, setAdding] = useState<Partial<Draft> | null>(null)
  const [steerText, setSteerText] = useState('')
  const [moveError, setMoveError] = useState('')
  // Set on first run only: the suggested workspace, awaiting an answer.
  const [setupCwd, setSetupCwd] = useState<string | null>(null)
  // The work tree opens files and the editor shows them; they are separate
  // panels the operator can put in different columns, so the open file lives
  // above both rather than inside either.
  const [file, setFile] = useState<OpenFile | null>(null)
  const [fileNote, setFileNote] = useState('')

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
      window.bullpen.onExit((id, code) => {
        // A shell exiting is not an agent exiting; upserting it would put a
        // phantom agent on the roster and on the office floor.
        if (isShellId(id)) return
        store().upsertAgent({ id, status: 'exited', exitCode: code, activity: 'idle' })
      }),
      window.bullpen.onStatus((id, status) => store().upsertAgent({ id, activity: status })),
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
      window.bullpen.onHired((a) =>
        store().upsertAgent({
          id: a.id,
          role: 'worker',
          project: a.project,
          name: a.name,
          face: a.id,
          cwd: a.cwd,
          pid: a.pid,
          startedAt: a.startedAt,
          cols: a.cols,
          rows: a.rows,
          status: 'running',
          activity: 'idle'
        })
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
        setTimeout(() => window.bullpen.submit(id, d.briefing), 4000)
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

  const open = async (path: string): Promise<void> => {
    if (!current) return
    const res = await openFile(current, path)
    if (typeof res === 'string') return setFileNote(res)
    setFile(res)
    setFileNote(res.truncated ? 'Showing the first 1 MB — saving is refused for this file.' : '')
  }

  const saveFile = async (text: string): Promise<void> => {
    // Saving a truncated read would write back a prefix and delete the rest.
    if (!file || file.truncated) return
    const res = await window.bullpen.codeWrite(file.root, file.path, text)
    setFileNote(res.error ?? `saved ${file.path}`)
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
    tree: <WorkTree agent={current} openPath={file?.path ?? null} onOpen={open} />,
    editor: <FilePanel file={file} onSave={saveFile} note={fileNote} />,
    shell: <Shell agent={current} />,
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
                onKeyDown={onEnter(steer)}
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

        </main>
    )
  }

  const cols = visibleColumns(layout)

  return (
    <div style={{ ...(VARS[mode] as React.CSSProperties), ...S.app }}>
      <TitleBar
        mode={mode}
        onToggle={() => setMode(mode === 'light' ? 'dark' : 'light')}
        layout={layout}
        onTogglePanel={(id) => applyLayout(togglePanel(layout, id))}
      />

      <div data-layout={cols.map((c) => c.panels.join('+')).join('|')} style={S.body}>
        {cols.map((col, i) => (
          // Keyed by the column's lead panel, not its contents: keying by
          // contents remounted the whole column whenever a panel in it was
          // hidden, which collapsed every folder open in the work tree.
          <Fragment key={col.panels[0]}>
            {i > 0 && (
              <Splitter
                onDrag={(dx) => applyLayout(resizeColumns(layout, i - 1, dx / (window.innerWidth || 1)))}
                onDropPanel={(from) => applyLayout(moveToNewColumn(layout, from, i))}
                dragging={dragging}
              />
            )}
            <Column
              panels={col.panels}
              weight={col.weight}
              layout={layout}
              panes={panes}
              dragging={dragging}
              onDragStart={setDragging}
              onDragEnd={() => setDragging(null)}
              onDropOn={(from, target, side) => applyLayout(moveTo(layout, from, target, side))}
              onResize={(above, below, dy, h) => applyLayout(resizeRows(layout, above, below, dy / h))}
            />
          </Fragment>
        ))}
        {/* A panel dragged past the last column becomes a column of its own. */}
        <Splitter
          onDrag={() => {}}
          onDropPanel={(from) => applyLayout(moveToNewColumn(layout, from, cols.length))}
          dragging={dragging}
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
  name: 'floor' | 'sun' | 'moon' | 'full' | 'min' | 'close' | 'roster' | 'command' | 'editor' | 'tree' | 'shell'
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
  if (name === 'editor')
    return (
      <svg {...common} aria-hidden>
        <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
      </svg>
    )
  if (name === 'shell')
    return (
      <svg {...common} aria-hidden>
        <rect x="1.5" y="2.5" width="13" height="11" />
        <path d="M4 6.5l2 1.5-2 1.5" />
      </svg>
    )
  if (name === 'tree')
    return (
      <svg {...common} aria-hidden>
        <path d="M3 2.5v9.5h3.5M3 6.5h3.5" />
        <rect x="7.5" y="1.5" width="6" height="3" />
        <rect x="7.5" y="5" width="6" height="3" />
        <rect x="7.5" y="10.5" width="6" height="3" />
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
            onKeyDown={onEnter(go)}
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
 * One column: a vertical stack of panels with a draggable divider between each
 * pair. `flex` rather than grid, so the divider rows do not have to be counted
 * into a template every time a panel is hidden.
 */
function Column({
  panels,
  weight,
  layout,
  panes,
  dragging,
  onDragStart,
  onDragEnd,
  onDropOn,
  onResize
}: {
  panels: PanelId[]
  /** Share of the window width; only the ratio between columns matters. */
  weight: number
  layout: Layout
  panes: Record<PanelId, React.ReactNode>
  dragging: PanelId | null
  onDragStart: (id: PanelId) => void
  onDragEnd: () => void
  onDropOn: (from: PanelId, target: PanelId, side: 'above' | 'below') => void
  onResize: (above: PanelId, below: PanelId, dy: number, height: number) => void
}) {
  const col = useRef<HTMLDivElement>(null)
  const total = panels.filter((p) => !FIXED.has(p)).reduce((n, p) => n + layout.rowWeight[p], 0) || 1

  return (
    <div ref={col} style={{ ...S.column, flexGrow: weight }}>
      {panels.map((id, i) => (
        <Fragment key={id}>
          {/* No divider above a fixed panel: there is nothing to trade with it. */}
          {i > 0 && !FIXED.has(id) && !FIXED.has(panels[i - 1]) && (
            <Splitter
              vertical
              dragging={dragging}
              onDrag={(dy) => onResize(panels[i - 1], id, dy, col.current?.clientHeight ?? 1)}
            />
          )}
          <Pane
            id={id}
            share={layout.rowWeight[id] / total}
            dragging={dragging}
            onDragStart={() => onDragStart(id)}
            onDragEnd={onDragEnd}
            onDrop={(from, side) => onDropOn(from, id, side)}
          >
            {panes[id]}
          </Pane>
        </Fragment>
      ))}
    </div>
  )
}

/**
 * A divider you drag to resize, and drop a panel on to split off a new column.
 *
 * Pointer capture rather than mousemove on window: the pointer leaves the 5px
 * track immediately, and without capture the drag stops the moment it does.
 */
function Splitter({
  onDrag,
  onDropPanel,
  dragging,
  vertical = false
}: {
  onDrag: (delta: number) => void
  onDropPanel?: (from: PanelId) => void
  dragging?: PanelId | null
  vertical?: boolean
}) {
  const last = useRef(0)
  const [over, setOver] = useState(false)
  const armed = Boolean(onDropPanel && dragging)

  return (
    <div
      style={{
        ...(vertical ? S.splitterH : S.splitterV),
        // Widen while a panel is in flight: a 5px target is not a drop zone.
        ...(armed ? S.splitterArmed : null),
        ...(over && armed ? S.splitterOver : null)
      }}
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
      onDragOver={(e) => {
        if (!armed) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const from = e.dataTransfer.getData('text/panel') as PanelId
        if (onDropPanel && PANELS.includes(from)) onDropPanel(from)
      }}
    />
  )
}

/**
 * One panel, with a grip you can drag onto another to place it.
 *
 * Dropping on the top or bottom half of a panel decides which side it lands on.
 * A single "swap" would not do: the point of stacking is choosing what is above.
 */
function Pane({
  id,
  share,
  children,
  dragging,
  onDragStart,
  onDragEnd,
  onDrop
}: {
  id: PanelId
  share: number
  children: React.ReactNode
  dragging: PanelId | null
  onDragStart: () => void
  onDragEnd: () => void
  onDrop: (from: PanelId, side: 'above' | 'below') => void
}) {
  const [side, setSide] = useState<'above' | 'below' | null>(null)
  const isTarget = side !== null && dragging !== null && dragging !== id

  const half = (e: React.DragEvent): 'above' | 'below' => {
    const box = e.currentTarget.getBoundingClientRect()
    return e.clientY < box.top + box.height / 2 ? 'above' : 'below'
  }

  return (
    <section
      data-pane={id}
      style={{
        ...S.pane,
        // A fixed panel is sized by its content; everything else divides what
        // is left over in the column.
        ...(FIXED.has(id) ? { flex: '0 0 auto' } : { flexGrow: share, flexBasis: 0 }),
        ...(isTarget ? (side === 'above' ? S.paneTargetTop : S.paneTargetBottom) : null)
      }}
      onDragOver={(e) => {
        // Without this the browser refuses the drop and fires nothing.
        e.preventDefault()
        setSide(half(e))
      }}
      onDragLeave={() => setSide(null)}
      onDrop={(e) => {
        e.preventDefault()
        const where = half(e)
        setSide(null)
        const from = e.dataTransfer.getData('text/panel') as PanelId
        if (PANELS.includes(from)) onDrop(from, where)
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
      <div style={FIXED.has(id) ? S.paneBodyFixed : S.paneBody}>{children}</div>
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
  body: { display: 'flex', minHeight: 0, overflow: 'hidden' },
  // Floor on the left, command centre on the right - the windowed layout.
  bodyWithFloor: { display: 'grid', gridTemplateColumns: '204px 1.35fr 1fr', minHeight: 0 },
  floorPane: { minWidth: 0, minHeight: 0, borderRight: '1px solid var(--line)', overflow: 'hidden' },
  roster: {
    borderRight: '1px solid var(--line)',
    background: 'var(--panel)',
    padding: 10,
    overflowY: 'auto'
  },
  // flex:1 because the pane body is a flex column - without it the command
  // centre was sized by its content and left dead space beneath the terminal.
  main: {
    display: 'grid',
    gridTemplateRows: 'auto auto auto 1fr',
    flex: 1,
    minHeight: 0,
    minWidth: 0
  },
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
  paneTargetTop: { boxShadow: 'inset 0 3px 0 0 var(--accent)' },
  paneTargetBottom: { boxShadow: 'inset 0 -3px 0 0 var(--accent)' },
  column: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flexBasis: 0 },
  splitterV: { cursor: 'col-resize', background: 'var(--line)', width: 5, flexShrink: 0 },
  splitterH: { cursor: 'row-resize', background: 'var(--line)', height: 5, flexShrink: 0 },
  splitterArmed: { background: 'var(--sunk)', outline: '1px dashed var(--accent)', minWidth: 14 },
  splitterOver: { background: 'var(--accent)' },
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
  paneBodyFixed: { flex: 'none', minWidth: 0, display: 'flex', flexDirection: 'column' },
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
