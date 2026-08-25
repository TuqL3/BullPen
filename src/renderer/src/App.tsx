import { Fragment, useEffect, useRef, useState } from 'react'
import { onEnter } from './keys'
import { AddAgent, type Draft } from './AddAgent'
import { Settings } from './Settings'
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
import { projectOf, slug } from './roster'
import { labelForModel, matchModel, modelOf, withModel } from '../../models'
import { engineFor } from '../../engines'
import type { Dispatch, Question, Report, UpdateState, WorkflowInfo } from '../../preload/index'
import {
  paneSize,
  setTerminalFontSize,
  setTerminalTheme,
  disposeTerminal,
  TerminalDeck,
  writeToTerminal
} from './Terminal'
import { getPrefs, setPrefs, type Prefs } from './prefs'
import { FilePanel, Review, WorkTree } from './Code'
// Not in `Code`: a module that exports anything but components loses React Fast
// Refresh, and every edit to a panel there would remount the whole tree.
import { openFile, type OpenFile } from './file'
import {
  DEFAULT_LAYOUT,
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
import {
  buildRole,
  dispatchRole,
  isCore,
  roleName,
  roleTag,
  setShape,
  shape
} from './shape'

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
  for (const a of agents.filter((x) => !isCore(x.role))) {
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

  const [mode, setMode] = useState<Mode>(window.bullpen.initialMode)
  const [tab, setTab] = useState<Tab>('terminal')
  /** The version this is, and whether there is a newer one. Null until asked. */
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT)
  /**
   * The floor's shape. Read once from main, which is where it is enforced -
   * the renderer uses it to know who cannot be fired, which roles the wizard
   * may hire into, and who to bring up beside the boss.
   */
  const [wf, setWf] = useState<WorkflowInfo | null>(null)
  const [settings, setSettings] = useState(false)
  /**
   * Open on the way back in, when a floor was just applied.
   *
   * Applying takes the window down and brings it up on the new floor, and
   * whoever pressed it was in the middle of drawing - landing on a bare
   * desktop with the dialog gone reads as the app having lost the work rather
   * than as having done what was asked.
   *
   * In the URL, not in `sessionStorage`: the packaged app is loaded over
   * `file:`, where reading storage throws rather than returning nothing - and
   * this ran inside a `useState` initialiser, so the throw took the whole tree
   * with it and the window came back empty. A hash cannot throw, and this is
   * an effect either way, where a failure costs the dialog and not the app.
   */
  useEffect(() => {
    if (window.location.hash !== '#floor') return
    setSettings(true)
    try {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    } catch {
      // Left in the URL rather than lost: it only means the next reload opens
      // the dialog too.
    }
  }, [])

  const [dragging, setDragging] = useState<PanelId | null>(null)
  // Null when closed; otherwise the fields the wizard opens with. Hiring the
  // second agent into a project should not mean re-answering where it lives.
  const [adding, setAdding] = useState<Partial<Draft> | null>(null)
  const [steerText, setSteerText] = useState('')
  const [moveError, setMoveError] = useState('')
  /**
   * The row the pointer was right-clicked on, and where.
   *
   * Two things an agent has that the roster showed and could not change: what
   * it runs on and where it works. Both were decided once, in the wizard, and
   * a wrong answer meant firing it and hiring somebody else.
   */
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  /**
   * What the CLI's own config says that agent starts on, while its menu is open.
   *
   * The model it answered on is read off the transcript and does not exist
   * until it has taken a turn, so a floor just brought up had nothing under
   * "its default" at all. This is the same files the CLI reads, asked for when
   * the menu opens rather than held: somebody may edit them between one
   * opening and the next.
   */
  const [menuModel, setMenuModel] = useState<string | null>(null)
  // Set on first run only: the suggested workspace, awaiting an answer.
  const [setupCwd, setSetupCwd] = useState<string | null>(null)
  // The work tree opens files and the editor shows them; they are separate
  // panels the operator can put in different columns, so the open file lives
  // above both rather than inside either.
  const [file, setFile] = useState<OpenFile | null>(null)
  const [fileNote, setFileNote] = useState('')
  /** How much of the command panel the review takes, when it is open. */
  const [reviewShare, setReviewShare] = useState(0.4)
  const [reviewing, setReviewing] = useState(false)
  /** How the rest divides between the command centre and an open file. */
  const [fileHalf, setFileHalf] = useState(0.5)
  /** Files collapsed in the review, held here so closing it does not forget. */
  const [reviewShut, setReviewShut] = useState<string[]>([])
  const body = useRef<HTMLDivElement>(null)
  /** Bumped on every save, so the review re-reads instead of waiting for its poll. */
  const [savedTick, setSavedTick] = useState(0)
  /** Lines added and removed against HEAD, for the review button's own label. */
  const [diffStat, setDiffStat] = useState<{ adds: number; dels: number } | null>(null)
  // Held here rather than in the tab that shows them: the tab badge has to
  // count them while that tab is unmounted, which is exactly when it matters.
  const [questions, setQuestions] = useState<Question[]>([])
  /** Where the work stands, every round of it, newest first. Monitor's, not ask me's. */
  const [reports, setReports] = useState<Report[]>([])
  /** The brief the operator last handed over, shown back to them on the monitor. */
  const [dispatched, setDispatched] = useState<Dispatch | null>(null)
  /** Desktop notifications, mirrored here so the title bar can show which it is. */
  const [notifyOn, setNotifyOn] = useState(true)
  /**
   * How the app is drawn on this machine. Held here as well as in `prefs.ts`
   * because the dialog is React and the terminal and the canvas are not.
   */
  const [prefs, setPrefsState] = useState<Prefs>(getPrefs())

  useEffect(() => {
    window.bullpen.askList().then(setQuestions)
    window.bullpen.reports().then(setReports)
    window.bullpen.lastDispatch().then(setDispatched)
    window.bullpen.notify().then(setNotifyOn)
    window.bullpen.uiPrefs().then((p) => {
      setPrefs(p)
      setPrefsState(p)
      setTerminalFontSize(p.fontSize)
    })
    const offAsk = window.bullpen.onAsk(setQuestions)
    // Prepended rather than replacing: main keeps the history, and this keeps
    // the copy on screen in step without a round trip per report.
    const offReport = window.bullpen.onReport((r) => setReports((was) => [r, ...was]))
    const offDispatch = window.bullpen.onDispatch(setDispatched)
    return () => {
      offAsk()
      offReport()
      offDispatch()
    }
  }, [])

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
        store().patchAgent({ id, status: 'exited', exitCode: code, activity: 'idle' })
      ),
      window.bullpen.onStatus((id, status) => store().patchAgent({ id, activity: status })),
      window.bullpen.onTool((id, tool, detail) =>
        store().patchAgent({ id, doing: { tool, detail, at: Date.now() } })
      ),
      window.bullpen.onWaiting((id, asked) =>
        store().patchAgent({ id, asked, activity: asked ? 'blocked' : 'working' })
      ),
      window.bullpen.onCtx((id, ctx) => store().patchAgent({ id, ctx })),
      window.bullpen.onCost((id, cost) => store().patchAgent({ id, cost })),
      window.bullpen.onSteerQueued((id) => {
        window.bullpen.steers(id).then((notes) => store().setSteers(id, notes))
      }),
      window.bullpen.onSteerCleared((id, notes) => {
        store().setSteers(id, [])
        store().addMail({
          from: 'you',
          to: id,
          subject: `${notes.length} queued note${notes.length === 1 ? '' : 's'} dropped · halted`,
          ts: Date.now()
        })
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
          role: a.role ?? buildRole(),
          project: a.project,
          name: a.name,
          face: a.id,
          cwd: a.cwd,
          cli: 'claude',
          pid: a.pid,
          startedAt: a.startedAt,
          cols: a.cols,
          rows: a.rows,
          status: 'running',
          activity: 'idle',
          ...(a.brief ? { task: { text: a.brief, at: Date.now() } } : null)
        })
      ),
      window.bullpen.onPending((p) => store().addApproval(p as Approval)),
      window.bullpen.onResolved((p) => store().removeApproval((p as Approval).id)),
      // A notification was clicked: the window is already coming up, and this
      // puts it on the thing the notification was about.
      window.bullpen.onGoto((tab, id) => {
        if (id) select(id)
        if ((TABS as readonly string[]).includes(tab)) setTab(tab as Tab)
      }),
      window.bullpen.onDeliver((d) => {
        const { to, msg } = d as {
          to: string
          msg: { from: string; subject: string; body?: string; ts: number }
        }
        store().addMail({ to, from: msg.from, subject: msg.subject, ts: msg.ts })
        // A message from the god agent to a worker is the assignment: it is how
        // work reaches anyone here, and the monitor has nothing else to read.
        const text = [msg.subject, msg.body].filter(Boolean).join(' — ').trim()
        if (text) store().patchAgent({ id: to, task: { text, at: msg.ts || Date.now() } })
      })
    ]
    return () => off.forEach((fn) => fn())
  }, [])

  /** Put one of the floor's standing agents in the store. */
  const adopt = (
    g: {
      id: string
      name: string
      cwd: string
      pid: number
      startedAt: number
      cols: number
      rows: number
    } | null,
    role = dispatchRole()
  ): void => {
    // A workflow may have no second fixed agent - `solo` is one boss and hired
    // developers - and main says so with null rather than inventing one.
    if (!g) return
    store().upsertAgent({
      id: g.id,
      role,
      project: '',
      name: g.name,
      face: g.id,
      cwd: g.cwd,
      cli: 'claude',
      pid: g.pid,
      startedAt: g.startedAt,
      cols: g.cols,
      rows: g.rows,
      status: 'running',
      exitCode: undefined,
      activity: 'idle'
    })
    if (role === dispatchRole()) select(g.id)
  }

  /** Whoever a task typed at the floor is handed to. */
  const adoptGod = (g: Parameters<typeof adopt>[0]): void => adopt(g, dispatchRole())

  // The standing agents are the floor's starting state, not hires. Bringing
  // them up here rather than in the wizard is what makes "open the app and they
  // are there" true; main hands back the running ones if this fires twice.
  //
  // On the very first run there is no answer yet to where they should work, and
  // picking one silently is how an agent ends up writing somewhere the operator
  // never looked - so that run asks first and starts nothing until it is told.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // The shape first. Every line under this asks the workflow who dispatch
      // is, and a floor brought up before the answer arrived adopted its boss
      // under an empty role - unfireable, unselected, in nobody's column.
      const { workflow } = await window.bullpen.workflow()
      if (cancelled) return
      setShape(workflow)
      setWf(workflow)

      const setup = await window.bullpen.godSetup()
      if (cancelled) return
      if (!setup.chosen) return setSetupCwd(setup.cwd)
      const { cols, rows } = paneSize(document.querySelector('section'))
      try {
        const g = await window.bullpen.ensureGod({ cols, rows })
        if (!cancelled) adoptGod(g)
        // Beside him, not after him: work is handed to them, and a floor with
        // a boss and nobody to hand to is a floor where nothing gets assigned.
        // However many the workflow names - two is `analyst-chain`, not a rule.
        for (const a of await window.bullpen.ensureFixed({ cols, rows })) {
          if (!cancelled) adopt(a, a.role)
        }
      } catch (err) {
        // A floor whose boss did not come up still works - dispatch is what
        // stops working, and it says so - but silence would look like nothing
        // was ever meant to be there.
        console.error('[bullpen] could not start the standing agents:', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Told once and then followed: main announces every change to the updater's
  // state, and a release feed is idle nine times out of ten.
  useEffect(() => {
    void window.bullpen.update().then(setUpdate)
    return window.bullpen.onUpdate(setUpdate)
  }, [])

  // Agents read the floor from a file, so it has to be rewritten whenever the
  // roster or anyone's status changes. Main skips the write when nothing moved.
  useEffect(() => {
    window.bullpen.publishFloor(
      agents.map((a) => ({
        id: a.id,
        name: a.name,
        project: isCore(a.role) ? '' : a.project || projectOf(a.cwd),
        role: a.role === 'worker' ? buildRole() : a.role,
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

  // Only while a row menu is open, and dropped the moment it closes: this is a
  // read of somebody else's config file, not a fact about the agent.
  useEffect(() => {
    setMenuModel(null)
    const a = rowMenu ? agents.find((x) => x.id === rowMenu.id) : null
    if (!a) return
    let live = true
    void window.bullpen.configModel(a.id, a.cli ?? 'claude', a.cwd).then((m) => {
      if (live) setMenuModel(m)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowMenu])

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
        rows,
        // With the spawn, not after it: the brief and the tool refusals are
        // read once and appended to the CLI's system prompt. Told afterwards,
        // main had already briefed this agent as whatever the floor's default
        // role is, and `setRole` below only ever fixed where its cards go.
        role: d.role
      })
      store().upsertAgent({
        id,
        role: d.role,
        project: isCore(d.role) ? '' : d.project.trim() || projectOf(d.cwd.trim()),
        name: d.name.trim(),
        face: d.face,
        color: d.color,
        cwd: state.cwd,
        cli: d.cmd.trim() || 'claude',
        args: d.args.trim() ? d.args.trim().split(/\s+/) : [],
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
      // Cards move by role - a tester's "done" closes the developer's card, a
      // developer's does not - so main has to be told what this one is.
      window.bullpen.setRole(id, d.role)
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
   * The floor's workspace is a setting, not a fixture. The CLI reads its working
   * directory once at startup, so moving him is a restart - the conversation in
   * his terminal does not survive it, and that is worth saying out loud before
   * it happens rather than after.
   */
  const moveGod = async (): Promise<void> => {
    const dir = await window.bullpen.pickDir()
    if (!dir) return
    // Everyone standing, not only the one whose header this is: they work in
    // the same directory, so moving it restarts all of them, and finding that
    // out afterwards is finding out you lost a conversation nobody mentioned.
    const boss = roleName(dispatchRole())
    const alsoMoving = agents.filter((a) => isCore(a.role) && a.role !== dispatchRole())
    const others = alsoMoving.map((a) => a.name).join(', ')
    if (
      !confirm(
        `Restart ${boss} in ${dir}?\n\n` +
          (others
            ? `${others} work in the same directory and restart too. Every conversation is lost.`
            : 'The conversation is lost.')
      )
    )
      return
    setMoveError('')
    const { cols, rows } = paneSize(document.querySelector('section'))
    const res = await window.bullpen.moveGod(dir, { cols, rows })
    if ('error' in res) return setMoveError(res.error)
    adoptGod(res)
    // They work in the same directory, so main stopped them when it moved.
    for (const a of await window.bullpen.ensureFixed({ cols, rows })) adopt(a, a.role)
  }

  /**
   * Bring the standing agents back up on the workflow that is running now.
   *
   * Applying a workflow does not touch anyone already spawned - a brief is
   * handed to a CLI once and never again - so without this the floor kept
   * running the shape it started on and nothing in the UI could move it. Their
   * conversations do not survive it, which is why the dialog says so first.
   */
  const restartFloor = async (): Promise<void> => {
    const { cols, rows } = paneSize(document.querySelector('section'))
    await window.bullpen.stopFixed()
    adoptGod(await window.bullpen.ensureGod({ cols, rows }))
    for (const a of await window.bullpen.ensureFixed({ cols, rows })) adopt(a, a.role)
  }

  const open = async (path: string, line?: number, col?: [number, number]): Promise<void> => {
    if (!current) return
    const res = await openFile(current, path, line, col)
    if (typeof res === 'string') return setFileNote(res)
    setFile(res)
    setFileNote(res.truncated ? 'Showing the first 1 MB — saving is refused for this file.' : '')
  }

  const saveFile = async (text: string): Promise<void> => {
    // Saving a truncated read would write back a prefix and delete the rest.
    if (!file || file.truncated) return
    const res = await window.bullpen.codeWrite(file.root, file.path, text)
    setFileNote(res.error ?? `saved ${file.path}`)
    if (!res.error) setSavedTick((n) => n + 1)
  }

  /** First run: accept a workspace for the floor and bring it up in there. */
  const chooseGodHome = async (dir: string): Promise<string | null> => {
    const { cols, rows } = paneSize(document.querySelector('section'))
    const res = await window.bullpen.moveGod(dir, { cols, rows })
    if ('error' in res) return res.error
    adoptGod(res)
    for (const a of await window.bullpen.ensureFixed({ cols, rows })) adopt(a, a.role)
    setSetupCwd(null)
    return null
  }

  /**
   * The review button carries the size of the diff, so it says what it opens.
   *
   * Read when the answer can have changed - a different agent, a file saved,
   * the panel opened or closed, the window coming back to the front - rather
   * than on a timer: `git diff` per second per agent is a cost with nothing
   * behind it while nobody is typing.
   */
  useEffect(() => {
    let live = true
    const read = async (): Promise<void> => {
      if (!current) return setDiffStat(null)
      const stats = await window.bullpen.gitStats(current.cwd)
      if (!live) return
      let adds = 0
      let dels = 0
      for (const v of Object.values(stats)) {
        const [a, d] = v.split('-')
        // A binary file reports `-` for both, and is a change with no lines.
        adds += Number(a) || 0
        dels += Number(d) || 0
      }
      setDiffStat({ adds, dels })
    }
    read()
    window.addEventListener('focus', read)
    return () => {
      live = false
      window.removeEventListener('focus', read)
    }
  }, [current?.cwd, savedTick, reviewing])

  const steer = (): void => {
    if (!selected || !steerText.trim()) return
    window.bullpen.steer(selected, steerText.trim())
    setSteerText('')
  }

  /**
   * Let someone go: stop the process if it is still up, then take the row off
   * the roster. Halting alone left an exited agent sitting there with no way
   * to dismiss it, which is the shape the bug arrived in.
   *
   * The confirm is only for an agent still running - firing one is not
   * undoable, and it takes the terminal's scrollback with it. A process that
   * has already exited has nothing left to lose, so that row just goes.
   */
  const fire = async (a: Agent): Promise<void> => {
    // A role with a fixed agent is the floor, not staff on it: dispatch routes
    // through one of them and the hires below answer to another. Firing one
    // leaves a floor that cannot hand out work, and nothing here brings it back.
    if (isCore(a.role)) return
    if (a.status === 'running') {
      const queued = store().steers[a.id]?.length ?? 0
      const note = queued > 0 ? `\n\n${queued} queued note${queued === 1 ? '' : 's'} will be dropped.` : ''
      if (!window.confirm(`Fire ${a.name}? It stops now and leaves the roster.${note}`)) return
      await window.bullpen.kill(a.id)
    }
    // Before the row goes, so the id is still the one being fired. A name is
    // free the moment its agent stops, and the next hire on the next project
    // gets it - along with every card, schedule and context rule left under it.
    await window.bullpen.forget(a.id)
    store().removeAgent(a.id)
    // The row is gone, so nothing will ever mount this host again. Without
    // this the xterm instance and its 10k lines of scrollback stay alive for
    // the life of the window, once per agent ever fired.
    disposeTerminal(a.id)
  }

  /**
   * Put an exited agent back on its feet, in the same directory under the same
   * id. Same id on purpose: the terminal keeps its scrollback, so what the last
   * run said is still there to read above the new prompt.
   *
   * Main resolves the role from the id it already holds, so a restarted fixed
   * agent comes back as itself; `setRole` re-states it for a worker whose role
   * only the roster knows.
   */
  const restart = async (a: Agent, change?: { cwd?: string; args?: string[] }): Promise<void> => {
    const { cols, rows } = paneSize(document.querySelector('section'))
    const cwd = change?.cwd?.trim() || a.cwd
    // Its own arguments unless it is being changed onto others. They used to be
    // dropped here: an agent hired on `--model haiku` came back on whatever the
    // CLI defaults to, which is an agent whose answers changed for a reason
    // nobody could see from the roster.
    const args = change?.args ?? a.args ?? []
    try {
      const state = await window.bullpen.spawn({
        id: a.id,
        cwd,
        cmd: a.cli ?? 'claude',
        args,
        cols,
        rows,
        role: a.role
      })
      store().upsertAgent({
        id: a.id,
        cwd: state.cwd,
        args,
        pid: state.pid,
        startedAt: state.startedAt,
        cols: state.cols,
        rows: state.rows,
        status: 'running',
        exitCode: undefined,
        // Same reason as a fresh hire: it is sitting at a prompt having
        // submitted nothing, and no Stop hook is coming to correct 'working'.
        activity: 'idle',
        asked: null,
        doing: undefined
      })
      window.bullpen.setRole(a.id, a.role)
      select(a.id)
      setTab('terminal')
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Put an agent on a different model, or in a different directory.
   *
   * Both are read once by the CLI at startup, so both are a restart and there
   * is no version of this that keeps the conversation - which is why it says so
   * before it does anything. Main does the stop and the spawn in one call: a
   * renderer that killed and then spawned would be racing the exit it caused.
   */
  const reconfigure = async (a: Agent, change: { cwd?: string; args?: string[] }): Promise<void> => {
    const cwd = change.cwd?.trim() || a.cwd
    const args = change.args ?? a.args ?? []
    const model = modelOf(args.join(' ')) ?? "the CLI's default"
    const what = change.cwd ? `Move ${a.name} to ${cwd}?` : `Restart ${a.name} on ${model}?`
    if (!window.confirm(`${what}\n\nThe CLI reads both of these once, at startup, so this restarts it. What it has said so far stays in the terminal; what it remembers does not.`)) {
      return
    }
    const { cols, rows } = paneSize(document.querySelector('section'))
    try {
      const state = await window.bullpen.restart({
        id: a.id,
        cwd,
        cmd: a.cli ?? 'claude',
        args,
        cols,
        rows,
        role: a.role
      })
      if ('error' in state) return setMoveError(state.error)
      store().upsertAgent({
        id: a.id,
        cwd: state.cwd,
        args,
        project: isCore(a.role) ? '' : a.project || projectOf(state.cwd),
        pid: state.pid,
        startedAt: state.startedAt,
        cols: state.cols,
        rows: state.rows,
        status: 'running',
        exitCode: undefined,
        activity: 'idle',
        asked: null,
        doing: undefined
      })
      window.bullpen.setRole(a.id, a.role)
      select(a.id)
      setTab('terminal')
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : String(e))
    }
  }

  // Everything the ask me tab lists: a held tool call, a question mailed to
  // you, and an agent stopped on a prompt in its own terminal. Declared above
  // `panes`: the tab bar is built inside it, so a const below is still dead.
  const askCount = approvals.length + questions.length + agents.filter((a) => a.asked).length
  /** What is left for the command centre and an open file to share. */
  const leftTotal = reviewing ? 1 - reviewShare : 1

  const panes: Record<PanelId, React.ReactNode> = {
    roster: (
        <aside style={S.roster}>
          <button style={{ ...S.btn, width: '100%', marginBottom: 12 }} onClick={() => setAdding({})}>
            + agent
          </button>

          {agents.length === 0 && <div style={S.empty}>No one hired yet.</div>}

          {agents
            .filter((a) => isCore(a.role))
            .map((a) => (
              <RosterRow
                key={a.id}
                agent={a}
                god
                active={selected === a.id}
                blocked={approvals.some((p) => p.agentId === a.id)}
                onSelect={() => select(a.id)}
                onFire={() => fire(a)}
                onRestart={() => restart(a)}
                onMenu={(x, y) => setRowMenu({ id: a.id, x, y })}
                tag={roleTag(a.role)}
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
                    onFire={() => fire(a)}
                    onRestart={() => restart(a)}
                    onMenu={(x, y) => setRowMenu({ id: a.id, x, y })}
                    tag={roleTag(a.role)}
                  />
                ))}
              </div>
            )
          })}
        </aside>
    ),
    floor: <Floor mode={mode} onSelect={select} />,
    tree: <WorkTree agent={current} openPath={file?.path ?? null} onOpen={open} />,
    command: (
      // A file opens beside the command centre rather than in a panel of its
      // own: it is read while working, and a panel for it sat empty the rest of
      // the time. Closing the file gives the width straight back.
      <div style={S.commandSplit}>
        <main style={{ ...S.main, flexGrow: leftTotal * (file ? 1 - fileHalf : 1), flexBasis: 0 }}>
          <header style={S.header}>
            {current ? <Avatar id={current.face} shirt={current.color} size={30} /> : <div style={{ width: 30 }} />}
            <div style={{ flex: 1 }}>
              <div style={{ ...LABEL, color: 'var(--ink)', fontSize: 11 }}>
                {current ? current.name : 'command center'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                {current ? `${current.activity} · pid ${current.pid} · ${current.cwd}` : 'no agent selected'}
                {current !== null && current.role === dispatchRole() && (
                  <button style={S.linkBtn} onClick={moveGod}>
                    move
                  </button>
                )}
                {/* Sat next to `queue` before, one button away from the thing
                    you press all day, and it kills a process without asking.

                    Stopping and keeping the row was a state nobody wanted from
                    here: an agent halted at this desk was done being talked to,
                    and the row it left behind was one more thing to dismiss. So
                    this is the same act as the roster's `×`. The restart on an
                    exited row is still there for one that died on its own.

                    Not for dispatch: the floor has no boss without it, and
                    nothing on this screen brings it back. */}
                {current?.status === 'running' && current.role !== dispatchRole() && (
                  <button
                    style={{ ...S.linkBtn, color: 'var(--danger)' }}
                    title={`stop ${current.name} and take it off the roster`}
                    onClick={() => fire(current)}
                  >
                    close
                  </button>
                )}
              </div>
              {moveError && (
                <div style={{ fontSize: 11, color: 'var(--danger)' }}>{moveError}</div>
              )}
              {/* The file panel carries this while a file is open; with none
                  open there is nowhere else for "could not read that" to go. */}
              {fileNote && !file && (
                <div style={{ fontSize: 11, color: 'var(--warn)' }}>{fileNote}</div>
              )}
              {/* The CLI drew this question in the agent's own terminal and is
                  blocked on a keystroke there - Bullpen can only point at it. */}
              {current?.asked && (
                <div style={{ fontSize: 11, color: 'var(--warn)' }}>
                  waiting on you in the terminal — {current.asked}
                </div>
              )}
            </div>
            <div>{current && <CtxMeter ctx={current.ctx} />}</div>
            <div style={{ display: 'none' }}>
            </div>
          </header>

          {current && (
            <div style={S.control}>
              <span style={{ ...LABEL, color: 'var(--faint)' }}>queue</span>
              {/* An idle agent has no tool call for a note to ride in on, so the
                  field took text and dropped it. Better to be shut than to
                  accept typing it cannot deliver. */}
              <input
                style={{ ...S.steerInput, ...(busy ? null : S.steerInputOff) }}
                value={steerText}
                disabled={!busy}
                placeholder={
                  busy
                    ? 'queue a note — it goes in with its next tool call, without interrupting it'
                    : 'idle — type in its terminal'
                }
                onChange={(e) => setSteerText(e.target.value)}
                onKeyDown={onEnter(steer)}
              />
              <button style={{ ...S.btn, ...(busy ? null : S.btnOff) }} disabled={!busy} onClick={steer}>
                queue
              </button>
              {(steers[current.id]?.length ?? 0) > 0 && (
                <span style={{ ...LABEL, color: 'var(--warn)' }}>
                  {steers[current.id].length} queued
                </span>
              )}
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
                {t === 'ask me' && askCount > 0 && <span style={S.badge}>{askCount}</span>}
              </button>
            ))}
          </nav>

          <section style={S.panel}>
            {/* The terminal stays mounted: unmounting it would drop scrollback. */}
            <div style={{ height: '100%', display: tab === 'terminal' ? 'block' : 'none' }}>
              {agents.length === 0 && <div style={S.empty}>Hire someone to start.</div>}
              <TerminalDeck ids={agents.map((a) => a.id)} selected={selected} />
            </div>
            {tab === 'monitor' && (
              <Monitor
                agents={agents}
                lastSeen={lastSeen}
                reports={reports}
                dispatched={dispatched}
                // Ask me is where everything waiting on a human is collected,
                // so that is where a waiting agent leads - not the terminal.
                onSelect={(id) => {
                  select(id)
                  setTab('ask me')
                }}
                onOpenTerminal={(id) => {
                  select(id)
                  setTab('terminal')
                }}
              />
            )}
            {tab === 'tasks' && (
              <Tasks agents={agents} agent={current} dispatch={dispatchRole()} />
            )}
            {tab === 'ask me' && (
              <AskMe
                approvals={approvals}
                agents={agents}
                questions={questions}
                onOpenTerminal={(id) => {
                  select(id)
                  setTab('terminal')
                }}
              />
            )}
            {tab === 'triggers' && <Triggers agent={current} />}
            {tab === 'memory' && <Memory agents={agents} selected={selected} />}
            {tab === 'graph' && <Graph agents={agents} mail={mail} />}
            {tab === 'activity' && <Activity />}
            {tab === 'commands' && <Commands agent={current} />}
            {tab === 'workers' && <Workers agents={agents} onSelect={select} />}
          </section>

        </main>
        {file && (
          <>
            {/* This divider splits the command centre with the file. The review
                keeps its own width either way: opening a file is not a reason
                to shrink what you were reading it against. */}
            <Splitter onDrag={(f) => setFileHalf((w) => clampShare(w - f))} />
            <div style={{ ...S.half, flexGrow: leftTotal * fileHalf }}>
              <FilePanel
                file={file}
                onSave={saveFile}
                note={fileNote}
                onClose={() => {
                  setFile(null)
                  setFileNote('')
                }}
              />
            </div>
          </>
        )}
        {reviewing && (
          <>
            <Splitter onDrag={(f) => setReviewShare((w) => clampShare(w - f))} />
            <div style={{ ...S.half, flexGrow: reviewShare }}>
              <Review
                agent={current}
                onOpen={open}
                onClose={() => setReviewing(false)}
                shut={reviewShut}
                setShut={setReviewShut}
                reload={savedTick}
              />
            </div>
          </>
        )}
      </div>
    )
  }

  const cols = visibleColumns(layout)

  return (
    // color-scheme is what repaints the native scrollbars, which are drawn by
    // the browser and ignore every variable above - in dark mode they stayed
    // light grey down the side of every scrolling panel.
    <div style={{ ...(VARS[mode] as React.CSSProperties), colorScheme: mode, ...S.app }}>
      <TitleBar
        update={update}
        layout={layout}
        onTogglePanel={(id) => applyLayout(togglePanel(layout, id))}
        reviewing={reviewing}
        diffStat={diffStat}
        onToggleReview={() => setReviewing(!reviewing)}
        onSettings={() => setSettings(true)}
      />

      <div
        ref={body}
        data-layout={cols.map((c) => c.panels.join('+')).join('|')}
        style={S.body}
      >
        {cols.map((col, i) => (
          // Keyed by the column's lead panel, not its contents: keying by
          // contents remounted the whole column whenever a panel in it was
          // hidden, which collapsed every folder open in the work tree.
          <Fragment key={col.panels[0]}>
            {i > 0 && (
              <Splitter
                onDrag={(f) => applyLayout(resizeColumns(layout, cols[i - 1].index, col.index, f))}
                onDropPanel={(from) => isPanel(from) && applyLayout(moveToNewColumn(layout, from, i))}
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
              onResize={(above, below, f) => applyLayout(resizeRows(layout, above, below, f))}
            />
          </Fragment>
        ))}
        {/* A panel dragged past the last column becomes a column of its own. */}
        <Splitter
          onDrag={() => {}}
          onDropPanel={(from) => isPanel(from) && applyLayout(moveToNewColumn(layout, from, cols.length))}
          dragging={dragging}
        />
      </div>

      <Dock agents={agents} selected={selected} approvals={approvals} onSelect={select} />

      {/* Right-click on a row: the two things an agent was stuck with.
          Both are read once by the CLI at startup, so both are a restart, and
          `reconfigure` says so before it does anything. */}
      {rowMenu &&
        (() => {
          const a = agents.find((x) => x.id === rowMenu.id)
          if (!a) return null
          const args = a.args ?? []
          // The engine decides which models exist. A menu of Claude models over
          // a codex agent is a menu of things it cannot run.
          const engine = engineFor(a.cli)
          const picked = modelOf(args.join(' '), engine.modelFlag)
          // What it is actually on, which is not always what was asked for: an
          // agent started with no flag still answers on something, and the tick
          // belongs against that row rather than against a line saying the
          // question was never answered. The turn it took beats the config file,
          // because one is what happened and the other is what was intended.
          const inUse = picked ?? a.ctx?.model ?? menuModel
          const ticked = inUse ? matchModel(inUse, engine.models)?.id : undefined
          const close = (): void => setRowMenu(null)
          return (
            <>
              <div style={S.menuBackdrop} onClick={close} onContextMenu={close} />
              <div style={{ ...S.rowMenu, left: rowMenu.x, top: rowMenu.y }}>
                <div style={{ ...LABEL, color: 'var(--faint)', padding: '2px 8px' }}>
                  {a.name} · {inUse ? labelForModel(inUse, engine.models) : "the CLI's default"}
                </div>
                {engine.models.length === 0 && (
                  <div style={{ ...S.menuItem, color: 'var(--faint)', cursor: 'default' }}>
                    no model list for {engine.label}
                  </div>
                )}
                {engine.models.map((m) => (
                  <div
                    key={m.id}
                    title={m.note || m.id}
                    style={{
                      ...S.menuItem,
                      ...(m.common ? null : S.menuItemPinned),
                      ...(ticked === m.id ? S.menuItemOn : null)
                    }}
                    onClick={() => {
                      close()
                      // Picking what it is already running would be a restart
                      // that changes nothing and costs the conversation.
                      if (ticked === m.id) return
                      const next = withModel(args.join(' '), m.id, engine.modelFlag)
                      void reconfigure(a, { args: next ? next.split(/\s+/) : [] })
                    }}
                  >
                    <span style={S.tick}>{ticked === m.id ? '✓' : ''}</span>
                    {m.label}
                  </div>
                ))}
                <div style={S.menuRule} />
                <div
                  style={S.menuItem}
                  onClick={async () => {
                    close()
                    const dir = await window.bullpen.pickDir()
                    if (dir) void reconfigure(a, { cwd: dir })
                  }}
                >
                  change directory…
                </div>
              </div>
            </>
          )
        })()}

      {adding && (
        <AddAgent
          taken={agents.map((a) => a.id)}
          prefill={adding}
          onCancel={() => setAdding(null)}
          onSpawn={spawnFrom}
          workflow={wf}
        />
      )}

      {settings && (
        <Settings
          workflow={wf}
          onRestartFloor={restartFloor}
          mode={mode}
          onMode={(next) => {
            setMode(next)
            window.bullpen.setMode(next)
          }}
          notifyOn={notifyOn}
          onNotify={async (on) => setNotifyOn(await window.bullpen.setNotify(on))}
          prefs={prefs}
          onPrefs={async (next) => {
            const saved = await window.bullpen.setUiPrefs(next)
            setPrefs(saved)
            setPrefsState(saved)
            // The canvas repaints itself every frame and picks the palette up
            // on its own; the terminals have to be told.
            if (next.fontSize !== undefined) setTerminalFontSize(saved.fontSize)
          }}
          onMoveGod={moveGod}
          onClose={() => setSettings(false)}
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
/** `compact` drops the used/limit text - in a table row it does not fit beside
 *  everything else, and the tooltip still carries the numbers. */
export function CtxMeter({ ctx, compact = false }: { ctx?: Agent['ctx']; compact?: boolean }) {
  if (!ctx) return <span style={{ ...LABEL, color: 'var(--faint)' }}>ctx —</span>
  const k = (n: number) => `${Math.round(n / 1000)}k`
  const colour = ctx.pct >= 85 ? 'var(--danger)' : ctx.pct >= 60 ? 'var(--warn)' : 'var(--ok)'
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
      title={`${ctx.model} · ${k(ctx.used)}/${k(ctx.limit)}`}
    >
      {!compact && (
        <span style={{ ...LABEL, color: 'var(--muted)' }}>
          ctx {k(ctx.used)}/{k(ctx.limit)}
        </span>
      )}
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
  name:
    | 'floor'
    | 'min'
    | 'full'
    | 'restart'
    | 'gear'
    | 'close'
    | 'roster'
    | 'tree'
    | 'review'
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
  if (name === 'roster')
    return (
      <svg {...common} aria-hidden>
        <path d="M2 2.5h3v3H2zM2 10.5h3v3H2z" />
        <path d="M7.5 4h6.5M7.5 12h6.5" />
      </svg>
    )
  if (name === 'review')
    return (
      <svg {...common} aria-hidden>
        <rect x="1.5" y="1.5" width="7" height="10" />
        <rect x="7.5" y="4.5" width="7" height="10" />
        <path d="M9.5 9.5h3M11 8v3" />
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
  // Sliders, not a cogwheel. A cog at 13px is a circle with a fringe, which is
  // the sun icon two buttons along - drawn that way once, and the button read
  // as a second theme toggle rather than as settings.
  if (name === 'gear')
    return (
      <svg {...common} aria-hidden>
        <path d="M2 4.5h12M2 11.5h12" />
        <circle cx="5.5" cy="4.5" r="1.8" />
        <circle cx="10.5" cy="11.5" r="1.8" />
      </svg>
    )
  if (name === 'restart')
    return (
      <svg {...common} aria-hidden>
        <path d="M13 8a5 5 0 1 1-1.6-3.7" />
        <path d="M13.5 2v3h-3" />
      </svg>
    )
  if (name === 'full')
    return (
      <svg {...common} aria-hidden>
        <path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10" />
      </svg>
    )
  return (
    <svg {...common} aria-hidden>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  )
}

/**
 * First run, and the only thing it asks: where the floor works.
 *
 * Not skippable. A default would be one machine's home directory imposed on
 * every other, and an agent writing somewhere the operator never looked is a
 * worse outcome than one more click on the first launch.
 *
 * Who it names is the workflow's dispatch agent - the one a task typed at the
 * floor goes to - rather than a name written in here, which was only ever this
 * one workflow's boss.
 */
function FirstRun({
  suggested,
  onChoose
}: {
  suggested: string
  onChoose: (dir: string) => Promise<string | null>
}) {
  const boss = roleName(dispatchRole())
  const others = Object.entries(shape()?.roles ?? {})
    .filter(([role, def]) => def.fixed && role !== dispatchRole())
    .map(([, def]) => def.fixed?.name ?? '')
    .filter(Boolean)
  const [dir, setDir] = useState(suggested)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const go = async (): Promise<void> => {
    if (!dir.trim()) return setError(`${boss} needs a directory to work in.`)
    setBusy(true)
    setError((await onChoose(dir.trim())) ?? '')
    setBusy(false)
  }

  return (
    <div style={S.modalWrap}>
      <div style={{ ...S.modal, width: 520 }}>
        <div style={{ ...LABEL, color: 'var(--ink)', fontSize: 12, fontWeight: 700 }}>
          Where should {boss} work?
        </div>
        <p style={S.firstRunBlurb}>
          {boss} stands in for you: you dispatch through {boss}, and what comes back reaches you
          the way the <b>{shape()?.name ?? 'workflow'}</b> workflow says it does.{' '}
          {others.length > 0 && `${others.join(', ')} ${others.length === 1 ? 'works' : 'work'} in this same directory. `}
          Whoever stands here may write freely inside it, and nowhere else — you can move them
          later from the header.
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
          {busy ? 'starting…' : `start ${boss} here`}
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
  /** `delta` is a fraction of the two panels' combined height. */
  onResize: (above: PanelId, below: PanelId, delta: number) => void
}) {
  const col = useRef<HTMLDivElement>(null)
  const total = panels.reduce((n, p) => n + layout.rowWeight[p], 0) || 1

  /**
   * Weight only - no maximum, no fixed pixels.
   *
   * A `max-width` here was what moved the roster: a flex item held at its
   * maximum hands the space it cannot use to every other item that can grow,
   * so dragging the divider on the right changed a column on the far left.
   * Mixing fixed pixels in was worse - the pixel width of every other column is
   * computed from the total weight, so pinning one changed all of them.
   *
   * Nothing is pinned now: every column is its weight and nothing else, which
   * is what makes every divider between them move the pair it sits on and
   * nobody else. The office floor draws itself to whatever width its column
   * ends up with, and letterboxes rather than overrunning.
   */
  return (
    <div ref={col} style={{ ...S.column, flexGrow: weight }}>
      {panels.map((id, i) => (
        <Fragment key={id}>
          {i > 0 && (
            <Splitter
              vertical
              dragging={dragging}
              onDrag={(f) => onResize(panels[i - 1], id, f)}
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

/** Neither half may be dragged away entirely - there would be no grip back. */
const clampShare = (n: number): number => Math.min(0.85, Math.max(0.15, n))

const isPanel = (id: string): id is PanelId => (PANELS as readonly string[]).includes(id)

/** Combined size of the panels either side of a divider, in pixels. */
// eslint-disable-next-line
function pairSize(el: HTMLElement, vertical: boolean): number {
  const before = el.previousElementSibling as HTMLElement | null
  const after = el.nextElementSibling as HTMLElement | null
  const size = (n: HTMLElement | null): number =>
    n ? (vertical ? n.getBoundingClientRect().height : n.getBoundingClientRect().width) : 0
  return size(before) + size(after)
}

/**
 * A divider you drag to resize, and drop a panel on to split off a new column.
 *
 * Pointer capture rather than mousemove on window: the pointer leaves the 5px
 * track immediately, and without capture the drag stops the moment it does.
 *
 * Reports how far it moved as a fraction of the two neighbours it sits between,
 * measured from the DOM. That is the denominator the weights are expressed in;
 * dividing by the window (or by the whole column) made the divider move a
 * fraction of the distance the pointer did, so it slid out from under the
 * cursor and the panels either side kept resizing after it.
 */
export function Splitter({
  onDrag,
  onDropPanel,
  dragging,
  vertical = false,
  kind = 'text/panel'
}: {
  /** Movement as a fraction of the two neighbouring panels' combined size. */
  onDrag: (delta: number) => void
  onDropPanel?: (from: string) => void
  dragging?: string | null
  vertical?: boolean
  /** dataTransfer type this divider accepts - panels here, shells in Shell. */
  kind?: string
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
        const pair = pairSize(e.currentTarget, vertical)
        if (pair > 0) onDrag((now - last.current) / pair)
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
        const from = e.dataTransfer.getData(kind)
        if (onDropPanel && from) onDropPanel(from)
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
        ...{ flexGrow: share, flexBasis: 0 },
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
      <div style={S.paneBody}>{children}</div>
    </section>
  )
}

/**
 * The switches on the right of the bar. Roster has its own, on the left, and
 * the command centre has none at all.
 */
type Switchable = Exclude<PanelId, 'command'>
const SIDE_PANELS: Switchable[] = ['tree', 'floor']

/** One panel switch: lit when its panel is up, grey when it is not. */
function PanelToggle({
  id,
  layout,
  onToggle,
  size,
  flush
}: {
  id: Switchable
  layout: Layout
  onToggle: (id: PanelId) => void
  /** Bigger than the default where the glyph has to hold its own beside
   *  something that is not one of ours - the native traffic lights. */
  size?: number
  /** No vertical padding, for the one that has to be as tall as a traffic
   *  light and not a pixel taller. */
  flush?: boolean
}) {
  const on = !layout.hidden.includes(id)
  return (
    <button
      title={on ? `hide ${PANEL_TITLE[id]}` : `show ${PANEL_TITLE[id]}`}
      aria-label={`toggle ${PANEL_TITLE[id]}`}
      style={
        {
          ...S.panelToggle,
          ...(flush ? S.panelToggleFlush : null),
          WebkitAppRegion: 'no-drag',
          // Colour, not a box. Four boxed icons in a row read as one control
          // with four parts, and the box was doing the work the colour already
          // does - which is why the review button's own box looked wrong.
          color: on ? 'var(--accent-ink)' : 'var(--faint)'
        } as React.CSSProperties
      }
      onClick={() => onToggle(id)}
    >
      <Icon name={id} size={size} />
    </button>
  )
}

/**
 * The one line the app says about its own version, and only when it has one.
 *
 * Nothing is drawn while there is nothing to say - a dev run, a check in
 * progress, or an app that is already the newest there is. The three states
 * that do draw are the three steps: there is one, it is coming down, it is
 * ready to go on.
 *
 * On macOS none of the three ever arrive: Sparkle draws its own window for the
 * whole sequence, so this stays empty there by design rather than by omission.
 */
function UpdateChip({ state }: { state: UpdateState | null }) {
  if (!state) return null
  const label =
    state.kind === 'available'
      ? `update ${state.next}`
      : state.kind === 'downloading'
        ? `downloading ${state.percent}%`
        : state.kind === 'ready'
          ? `restart & update`
          : state.kind === 'error'
            ? 'update failed'
            : ''
  if (!label) return null

  const go = (): void => {
    if (state.kind === 'available') return void window.bullpen.updateDownload()
    // The releases page, not another check: an error here is the updater
    // itself being broken, and asking it again asks the broken thing.
    if (state.kind === 'error') return void window.bullpen.updatePage()
    if (state.kind !== 'ready') return
    // Installing quits this process, and every agent on the floor is a child of
    // it. Nothing here can save a turn that is mid-flight, so the question is
    // asked in the words of what is lost rather than "are you sure".
    if (
      !confirm(
        `Restart and install ${state.next}?\n\nEvery agent on the floor is stopped. ` +
          `Whatever any of them is in the middle of is lost.`
      )
    ) {
      return
    }
    void window.bullpen.updateInstall()
  }

  const tone =
    state.kind === 'error'
      ? 'var(--danger)'
      : state.kind === 'downloading'
        ? 'var(--muted)'
        : 'var(--accent-ink)'
  return (
    <button
      title={
        state.kind === 'error'
          ? `${state.message} - click to open the releases page`
          : `you are on ${state.version}`
      }
      style={{ ...S.panelToggle, ...S.updateChip, color: tone, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      onClick={go}
      disabled={state.kind === 'downloading'}
    >
      {label}
    </button>
  )
}

function TitleBar({
  layout,
  onTogglePanel,
  reviewing,
  diffStat,
  onToggleReview,
  onSettings,
  update
}: {
  layout: Layout
  onTogglePanel: (id: PanelId) => void
  reviewing: boolean
  /** Lines added and removed in the selected agent's workspace, or null. */
  diffStat: { adds: number; dels: number } | null
  onToggleReview: () => void
  /** How this floor and this machine are set up. */
  onSettings: () => void
  /** The version this is, and the one there could be. Null until main answers. */
  update: UpdateState | null
}) {
  return (
    <div style={S.titlebar}>
      {/* Leaves room for the macOS traffic lights, which stay native.
          The lights are set in main: inset 14, three 12px dots, 8px apart - so
          they run 14..66 and the next thing in the rhythm starts at 74. The bar
          pads 10 and gaps 8, and the switch pads 4, which puts its glyph at
          10 + 50 + 8 + 4 + 2 = 74. The last 2 is the slack inside a 16px box
          around a glyph whose ink is 12.4 of those 16 - the same 12 the dots
          are, which is the number the eye is actually comparing. */}
      <div style={{ width: window.bullpen.isMac ? 50 : 14 }} />
      {/* The roster sits on the left of the window, so its switch sits on the
          left of the bar - where the wordmark used to be. A title bar that
          spells out the name of the app you are looking at is decoration. */}
      {/* 16, not the default 13, and no vertical padding at all.
          The glyph's ink fills 12.4 of its 16-unit box, so a 16px box draws a
          12px mark - the size of a traffic light. The padding is what made the
          button taller than the dots beside it: 15px of glyph in 3px of padding
          top and bottom is a 21px control in a row of 12px ones. */}
      <PanelToggle
        id="roster"
        layout={layout}
        onToggle={onTogglePanel}
        size={16}
        flush
      />
      <div style={{ flex: 1 }} />
      <UpdateChip state={update} />
      {/* Fixed order, so a toggle does not move when the panels are rearranged
          and the button under the cursor stays the one you meant. The command
          centre has no switch: it is what the window is for, and a hidden one
          leaves a window with nothing in it. */}
      {SIDE_PANELS.map((id) => (
        <PanelToggle key={id} id={id} layout={layout} onToggle={onTogglePanel} />
      ))}
      {/* The one control here that says what it does in numbers rather than in
          a glyph you have to have learned: how much has changed is the reason
          you would open it at all. */}
      <button
        title="review uncommitted changes"
        aria-label="toggle review"
        style={{
          ...S.panelToggle,
          ...S.reviewBtn,
          WebkitAppRegion: 'no-drag',
          color: reviewing ? 'var(--accent-ink)' : 'var(--faint)'
        } as React.CSSProperties}
        onClick={onToggleReview}
      >
        <Icon name="review" />
        {diffStat && (diffStat.adds || diffStat.dels) ? (
          <>
            <span style={{ color: 'var(--ok)' }}>+{diffStat.adds}</span>
            <span style={{ color: 'var(--danger)' }}>-{diffStat.dels}</span>
          </>
        ) : (
          <span style={{ color: 'var(--faint)' }}>0</span>
        )}
      </button>
      {/* The bell and the theme glyph used to live here. Both are settings -
          one switch, one place - and a title bar of glyphs you have to have
          learned is worse than a dialog that says what each one does. */}
      <button
        title="settings"
        aria-label="settings"
        style={{ ...S.iconBtn, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={onSettings}
      >
        <Icon name="gear" />
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
      {!window.bullpen.isMac && (
        <button
          title="full screen"
          aria-label="toggle full screen"
          style={{ ...S.iconBtn, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={() => window.bullpen.toggleFullscreen()}
        >
          <Icon name="full" />
        </button>
      )}
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
  onFire,
  onRestart,
  onMenu,
  tag
}: {
  agent: Agent
  god?: boolean
  active: boolean
  blocked: boolean
  onSelect: () => void
  onFire: () => void
  onRestart: () => void
  /** Right-clicked, in window coordinates: what it runs on and where it works. */
  onMenu: (x: number, y: number) => void
  /** What this role is called here, or null for whoever does the building. */
  tag: string | null
}) {
  const status = agent.status === 'exited' ? 'exited' : blocked ? 'blocked' : agent.activity
  return (
    <div
      data-agent={agent.id}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault()
        onSelect()
        onMenu(e.clientX, e.clientY)
      }}
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
          {/* The standing agents share a workspace, so the directory alone
              tells them apart not at all. */}
          {tag ? <span style={{ color: 'var(--accent-ink)' }}>{tag} · </span> : null}
          {agent.cwd.split('/').pop() || agent.cwd}
        </div>
      </div>
      <span style={{ ...S.dot, background: DOT[status] }} />
      {/* An exited agent was a dead end - no way to dismiss it, no way to start
          it again. Restart reuses the id, so the terminal keeps its scrollback. */}
      {agent.status === 'exited' && (
        <span
          style={S.kill}
          title={`start ${agent.name} again`}
          onClick={(e) => {
            e.stopPropagation()
            onRestart()
          }}
        >
          <Icon name="restart" size={11} />
        </span>
      )}
      {/* Not shown for a role with a fixed agent: see isCore. Gating this on
          `running` is what stranded every exited agent with no way off. */}
      {!isCore(agent.role) && (
        <span
          style={S.kill}
          title={agent.status === 'running' ? `fire ${agent.name}` : 'remove from roster'}
          onClick={(e) => {
            e.stopPropagation()
            onFire()
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
            <Avatar id={a.face} shirt={a.color} size={30} />
            <div style={{ minWidth: 0 }}>
              <div style={{ ...LABEL, color: 'var(--ink)', fontSize: 10 }}>{a.name}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ ...S.dot, background: DOT[status] }} />
                <span style={{ fontSize: 10, color: 'var(--muted)' }}>{status}</span>
              </div>
              {/* Was a fixed 70%/12% keyed off status - a progress bar that
                  measured nothing and read as "70% done". Context usage is the
                  one number this card actually has. */}
              {a.ctx ? (
                <div style={S.meter} title={`ctx ${a.ctx.pct}% · ${a.ctx.model}`}>
                  <div
                    style={{
                      ...S.meterFill,
                      background:
                        a.ctx.pct >= 85 ? 'var(--danger)' : a.ctx.pct >= 60 ? 'var(--warn)' : 'var(--ok)',
                      width: `${Math.max(2, Math.min(100, a.ctx.pct))}%`
                    }}
                  />
                </div>
              ) : (
                <div style={S.meter} title="no context reading yet" />
              )}
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
    gridTemplateRows: '34px 1fr 52px',
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
    // The 1px bottom border is inside the 34px row, so centring lands at 16.5
    // while the native traffic lights - inset 11, 12px across - centre at 17.
    // The padding puts the content box back on their line.
    padding: '1px 10px 0',
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
    padding: '3px 6px'
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
  commandSplit: { display: 'flex', height: '100%', minWidth: 0, minHeight: 0 },
  // Its own style, not the command centre's: S.main is a four-row grid, and a
  // panel dropped into its first row is as tall as its own content - which is
  // why a short file left the scrollbar hanging in the middle of the panel.
  half: { display: 'flex', flexDirection: 'column', flexBasis: 0, minWidth: 0, minHeight: 0 },
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
    color: 'var(--muted)',
    border: '1px solid',
    borderColor: 'var(--line)',
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
  // Wider while a panel is in flight, and nothing else: a 5px target is not a
  // drop zone. The dashed accent outline this used to draw put a yellow line
  // down every seam in the window the moment you picked a panel up - eight
  // highlights for one drop. The seam under the pointer says it instead.
  splitterArmed: { background: 'var(--sunk)', minWidth: 14, minHeight: 14 },
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
  reviewBtn: { gap: 5, padding: '3px 6px', font: `10px ${MONO}`, color: 'var(--muted)' },
  panelToggle: {
    display: 'flex',
    alignItems: 'center',
    background: 'transparent',
    // No box at all now: state is the colour of the glyph. The old outline had
    // to be written as longhand plus borderColor, because React clears the
    // longhand when the active state drops and left border-color at
    // `currentcolor` - a white box on the panel you had just switched away from.
    border: 'none',
    cursor: 'pointer',
    padding: '3px 6px'
  },
  // Beside the traffic lights the padding is what shows: it cannot add height
  // the dots do not have. 4 each side keeps the click target wider than the
  // glyph without moving it off the rhythm the spacer sets up.
  panelToggleFlush: { padding: '0 4px' },
  // Words, not a glyph: "restart & update" is not a thing anybody has a symbol
  // for, and this is the one control on the bar that changes what it says.
  updateChip: { ...LABEL, font: `10px ${MONO}`, gap: 5, padding: '3px 8px' },
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
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 6px',
    marginBottom: 2,
    border: '1px solid',
    borderColor: 'transparent',
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
  menuBackdrop: { position: 'fixed', inset: 0, zIndex: 60 },
  rowMenu: {
    position: 'fixed',
    zIndex: 61,
    minWidth: 190,
    maxHeight: '70vh',
    overflowY: 'auto',
    padding: '6px 0',
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,.45)',
    font: `12px ${MONO}`
  },
  menuItem: { padding: '4px 10px', cursor: 'pointer', color: 'var(--ink)' },
  // A column of its own, so every label starts at the same place whether or not
  // it is the one in use - a tick that pushes one line across reads as a typo.
  tick: { display: 'inline-block', width: 12, color: 'var(--accent-ink)' },
  menuItemOn: { color: 'var(--accent-ink)' },
  // The pinned ids, set back from the three words that answer this usually.
  menuItemPinned: { paddingLeft: 20, color: 'var(--muted)' },
  menuRule: { height: 1, background: 'var(--line)', margin: '6px 0' },
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
    padding: '4px 8px',
    border: '1px solid',
    borderColor: 'var(--line)',
    background: 'var(--bg)',
    cursor: 'pointer',
    flex: '0 0 auto',
    minWidth: 132
  },
  dockCardActive: { borderColor: 'var(--accent)' },
  steerInputOff: { opacity: 0.5, cursor: 'not-allowed' },
  btnOff: { opacity: 0.4, cursor: 'not-allowed' },
  meter: { height: 3, background: 'var(--line)', marginTop: 3, width: 76 },
  meterTrack: { width: 90, height: 6, background: 'var(--line)', flex: '0 0 auto' },
  meterBar: { height: '100%' },
  meterFill: { height: '100%' }
}
