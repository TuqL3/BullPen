import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Approvals, type Pending } from './approvals.ts'
import { list as listDir, read as readFile, write as writeFile } from './code.ts'
import { checkWorkspace, readConfig, writeConfig } from './config.ts'
import { changes as gitChanges, diff as gitDiff } from './git.ts'
import { ActivityLog } from './activity.ts'
import { Board, boardPath, type TaskStatus } from './board.ts'
import { newMeter, update as updateCost, type Cost, type Meter } from './cost.ts'
import { readCtx, type Ctx } from './ctx.ts'
import {
  GOD_ID,
  GOD_NAME,
  HIRE_ABOVE_PCT,
  REUSE_BELOW_PCT,
  floorPath,
  godCwd,
  publishFloor,
  writeBriefing,
  type FloorAgent
} from './god.ts'
import { Hive, HIRE, HUMAN, type Message } from './hive.ts'
import { PtyManager, type AgentSpec } from './pty.ts'
import { clearPid, forceKill, reapOrphans, writePid } from './reaper.ts'

const BULLPEN_HOME = process.env.BULLPEN_HOME ?? join(app.getPath('home'), '.bullpen')
const AGENTS_HOME = join(BULLPEN_HOME, 'agents')

/** Ids under this prefix are the operator's own shells, not hired agents. */
const SHELL_PREFIX = 'shell:'
const isShell = (id: string): boolean => id.startsWith(SHELL_PREFIX)

const hive = new Hive(join(BULLPEN_HOME, 'hive'))
const approvals = new Approvals(join(BULLPEN_HOME, 'control'))
const ptys = new PtyManager()
const board = new Board(boardPath(BULLPEN_HOME))
const activity = new ActivityLog()

/**
 * What each agent has written, newest first, deduped by path. Bounded: an
 * overnight run must not grow this forever, and nobody scrolls past the last
 * few dozen files anyway.
 */
const edits = new Map<string, { path: string; ts: number; tool: string }[]>()
const EDIT_CAP = 60

/** Questions agents have addressed to the human, newest last. */
const questions = new Map<string, Message & { id: string }>()
let questionSeq = 0

/**
 * The god agent - the operator's own clone. Dispatch and answers route via it.
 *
 * Defaults to Michael, who is spawned on launch rather than hired, so the floor
 * is never empty and there is always someone to dispatch through.
 */
let godId: string | null = GOD_ID

let win: BrowserWindow | null = null

/**
 * Every main -> renderer message goes through here.
 *
 * `win?.` only guards null. A closed window leaves a live object whose
 * webContents is destroyed, and agents keep streaming pty output for as long as
 * it takes to reap them - so anything sent in that gap threw "Object has been
 * destroyed" and popped Electron's crash dialog. Checking destruction here
 * covers every emitter at once rather than at each call site.
 */
const send = (channel: string, ...args: unknown[]): void => {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, ...args)
}

/**
 * Spawn one agent: sandbox it, give it a mailbox and a view of the floor, and
 * leave a pidfile so a crash does not strand the process.
 */
function spawnAgent(spec: AgentSpec): ReturnType<PtyManager['spawn']> {
  const cwd = resolve(spec.cwd)
  // The sandbox is the only thing standing between an agent and the rest of
  // the disk, so refuse the two directories that would make it meaningless.
  if (cwd === app.getPath('home') || cwd === resolve('/')) {
    throw new Error(`refusing to sandbox an agent at ${cwd} - pick a scratch directory`)
  }
  spec = { ...spec, cwd }
  mkdirSync(spec.cwd, { recursive: true })
  hive.register(spec.id)
  activity.push('spawn', spec.id, `spawned ${spec.id} in ${cwd}`)
  approvals.setSandbox(spec.id, spec.cwd)

  const agentHome = join(AGENTS_HOME, spec.id)
  const settingsPath = approvals.installHook(spec.id, agentHome)

  const state = ptys.spawn({
    ...spec,
    args: [...(spec.args ?? []), '--settings', settingsPath],
    env: {
      ...spec.env,
      BULLPEN_MAILBOX: hive.agentDir(spec.id),
      BULLPEN_FLOOR: floorPath(BULLPEN_HOME)
    }
  })

  // The settings path is unique to this agent and appears verbatim in its
  // command line, so it doubles as the identity check the reaper needs.
  writePid(agentHome, {
    pid: state.pid,
    marker: settingsPath,
    cwd: state.cwd,
    startedAt: state.startedAt
  })
  return state
}

/** See PtyManager.submit for why the Enter cannot ride along with the text. */
const submitPrompt = (id: string, text: string): boolean => ptys.submit(id, text)

/** Agents main hired on Michael's behalf, so a second hire does not reuse a name. */
const hires = new Map<string, { name: string; project: string }>()

const slugId = (name: string): string => slug(name).replace(/^-|-$/g, '')

const slug = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')

/**
 * The directory a project works in.
 *
 * First the agents already on it - a project is just the agents that share a
 * workspace, which is also all Michael can see in floor.json. Failing that,
 * look for a directory of that name beside the workspaces already in use.
 *
 * Without the second step, naming a project that had nobody on it yet was a
 * dead end: hiring could only add to a project, never start one, so the first
 * agent on everything had to come from the wizard and the operator had to type
 * out a path they had already effectively given by choosing where Michael works.
 */
function projectCwd(project: string): string | null {
  const want = slug(project)
  if (!want) return null
  for (const row of lastFloor) {
    if (slug(row.project) === want) return row.cwd
  }

  // Where projects live: Michael's own workspace, and the parent of every
  // workspace already in use. Deduped, and searched in that order.
  const roots = [currentGodCwd(), ...lastFloor.map((r) => join(r.cwd, '..'))]
  for (const root of [...new Set(roots.map((r) => resolve(r)))]) {
    let entries: string[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      continue
    }
    const hit = entries.find((name) => slug(name) === want)
    if (hit) return join(root, hit)
  }
  return null
}

/** `seo-2`, `seo-3`, ... - readable, and never colliding with a live agent. */
function nextHireName(project: string): string {
  const base = slug(project) || 'agent'
  for (let n = 2; n < 100; n++) {
    const name = `${base}-${n}`
    if (!ptys.isRunning(slugId(name))) return name
  }
  return `${base}-${Date.now()}`
}

/** The roster as the renderer last published it - what Michael reads too. */
let lastFloor: FloorAgent[] = []

/** Where Michael lives: whatever the operator chose, else the default. */
const currentGodCwd = (): string => readConfig(BULLPEN_HOME).godCwd ?? godCwd(BULLPEN_HOME)

/** Create the workspace, drop the briefing in it if absent, and bring him up. */
function startGod(cwd: string, size: { cols: number; rows: number }): ReturnType<PtyManager['spawn']> {
  mkdirSync(cwd, { recursive: true })
  writeBriefing(cwd, floorPath(BULLPEN_HOME))
  approvals.setSandbox(GOD_ID, cwd)
  return spawnAgent({ id: GOD_ID, cwd, cmd: 'claude', args: [], ...size })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#faf9f5',
    autoHideMenuBar: true,
    // macOS keeps its native traffic lights, inset over our own title bar.
    // Everywhere else there is nothing worth keeping, so drop the frame.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 11 } }
      : { frame: false }),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // Opened maximised: the floor plan is four panels wide, and at the default
  // 1400x900 the first thing anyone does is drag the window bigger.
  win.maximize()

  // Drop the reference as soon as it dies, so send() short-circuits on null
  // rather than repeatedly probing a corpse.
  win.on('closed', () => {
    win = null
  })

  // Agents produce links; they open in the real browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}

/** One reader per agent, so a growing transcript is parsed once, not re-read. */
const meters = new Map<string, Meter>()

const currentCost = (id: string): Cost | null => {
  const path = approvals.transcriptOf(id)
  if (!path) return null
  let meter = meters.get(id)
  if (!meter) {
    meter = newMeter()
    meters.set(id, meter)
  }
  return updateCost(meter, path)
}

const currentCtx = (id: string): Ctx | null => {
  const path = approvals.transcriptOf(id)
  return path ? readCtx(path) : null
}

/**
 * Context usage is read from the agent's own transcript, which the CLI names in
 * every hook payload. Nothing is scraped from the terminal - the on-screen
 * meter is Claude Code's own rendering and free to change in any release.
 */
const pushCtx = (id: string): boolean => {
  const ctx = currentCtx(id)
  if (ctx) send('agent:ctx', id, ctx)
  const cost = currentCost(id)
  if (cost && cost.turns > 0) send('agent:cost', id, cost)
  return Boolean(ctx)
}

/**
 * The Stop hook fires before the CLI has finished appending that turn's usage
 * record, so an immediate read comes back empty. Retry a couple of times and
 * stop at the first success rather than polling every agent forever.
 */
const pushCtxSoon = (id: string): void => {
  if (pushCtx(id)) return
  for (const delay of [1200, 4000, 10_000]) {
    setTimeout(() => pushCtx(id), delay).unref?.()
  }
}

function wire(): void {
  ptys.on('data', (id: string, chunk: string) => send('pty:data', id, chunk))
  // Auto-confirming anything must leave a trace the human can find later.
  ptys.on('trust', (id: string, sandbox: string) => {
    console.log(`[bullpen] auto-accepted workspace trust for ${id} at ${sandbox}`)
    activity.push('trust', id, `auto-accepted workspace trust at ${sandbox}`)
    send('agent:trust', id, sandbox)
  })
  ptys.on('exit', (id: string, code: number) => {
    if (isShell(id)) return send('agent:exit', id, code)
    // Drop the claim first: a pidfile outliving its process is what makes the
    // next startup consider killing whatever inherited that pid.
    clearPid(join(AGENTS_HOME, id))
    meters.delete(id)
    activity.push('exit', id, `${id} exited (code ${code})`)
    send('agent:exit', id, code)
  })

  approvals.on('edit', (agentId: string, path: string, tool: string) => {
    const list = (edits.get(agentId) ?? []).filter((e) => e.path !== path)
    list.unshift({ path, ts: Date.now(), tool })
    edits.set(agentId, list.slice(0, EDIT_CAP))
    send('code:edited', agentId, path)
  })

  hive.on('deliver', ({ to, msg }) => {
    // A halted agent used to swallow its mail: deliver() returned early and
    // nothing said so, so the sender believed the task was assigned and the
    // work simply never happened.
    if (!ptys.deliver(to, msg.from, msg.subject, msg.body)) {
      activity.push('dead', msg.from, `${to} is not running — "${msg.subject}" was not delivered`)
      send('hive:dead', msg)
      if (ptys.isRunning(msg.from)) {
        hive.send({
          from: 'bullpen',
          to: msg.from,
          subject: `undelivered: ${msg.subject}`,
          body: `${to} is not running, so it never got this. Check $BULLPEN_FLOOR for who is actually up, or hire someone onto the project.`
        })
      }
      return
    }
    activity.push('message', msg.from, `${msg.from} → ${to}: ${msg.subject}`)
    send('hive:deliver', { to, msg })
  })
  hive.on('dead', (msg) => {
    activity.push('dead', msg.from, `undeliverable to ${msg.to}: ${msg.subject}`)
    send('hive:dead', msg)
  })
  hive.on('question', (msg: Message) => {
    const q = { ...msg, id: `q${++questionSeq}` }
    questions.set(q.id, q)
    activity.push('question', msg.from, `${msg.from} asks you: ${msg.subject}`)
    send('ask:pending', [...questions.values()])
  })

  /**
   * Michael asking for another pair of hands.
   *
   * The floor he can see is the floor the renderer publishes, so a hire has to
   * come back out to the renderer to exist there too - main spawns the pty, the
   * renderer puts them on the roster and the office floor.
   */
  hive.on('hire', (msg: Message) => {
    const project = msg.subject.trim()
    // An existing project is known by the agents already on it. A new one has
    // to name its directory - otherwise hiring could never start a project at
    // all, only add to one, and the first agent on every project would have to
    // come from the wizard. That was a real dead end: asked to put someone on a
    // project that did not exist yet, Michael could only refuse.
    const known = projectCwd(project)
    const cwd = known ?? (msg.cwd ?? '').trim()
    const bad = !project
      ? 'a hire needs the project as its subject'
      : !cwd
        ? `No directory found for "${project}". I looked where the other projects live. Ask the human where it is and send the hire again with "cwd" set to that path.`
        : known
          ? null
          : checkWorkspace(cwd, app.getPath('home')) ??
            (existsSync(cwd) ? null : `${cwd} does not exist`)
    if (bad) {
      hive.send({ from: 'bullpen', to: msg.from, subject: 're: hire', body: bad })
      return
    }
    const name = nextHireName(project)
    try {
      const state = spawnAgent({ id: slugId(name), cwd, cmd: 'claude', args: [], cols: 100, rows: 30 })
      hires.set(state.id, { name, project })
      activity.push('spawn', msg.from, `${msg.from} hired ${name} onto ${project}${known ? '' : ' (new project)'}`)
      send('agent:hired', { ...state, name, project })
      // The briefing is what the new agent is for; it arrives as its first turn.
      if (msg.body.trim()) setTimeout(() => ptys.submit(state.id, msg.body), 4000).unref?.()
      hive.send({ from: 'bullpen', to: msg.from, subject: 're: hire', body: `${name} is on ${project} and has the task.` })
    } catch (err) {
      hive.send({
        from: 'bullpen',
        to: msg.from,
        subject: 're: hire',
        body: `Could not hire: ${err instanceof Error ? err.message : String(err)}`
      })
    }
  })

  activity.on('activity', (item) => send('activity:item', item))
  hive.start()

  approvals.on('status', (id: string, status: string) => {
    send('agent:status', id, status)
    // A turn just ended, so the transcript now holds its token counts.
    if (status === 'idle') pushCtxSoon(id)
  })
  approvals.on('transcript', (id: string) => pushCtxSoon(id))
  approvals.on('steer-queued', (id: string, note: string, depth: number) =>
    send('agent:steer-queued', id, note, depth)
  )
  approvals.on('steer-delivered', (id: string, notes: string[]) => {
    activity.push('steer', id, `steer delivered to ${id}: ${notes.join(' | ').slice(0, 80)}`)
    send('agent:steer-delivered', id, notes)
  })
  approvals.on('pending', (p: Pending) =>
    activity.push('approval', p.agentId, `${p.agentId} needs approval for ${p.toolName}: ${p.reason}`)
  )
  approvals.on('pending', (p: Pending) => send('approvals:pending', p))
  approvals.on('resolved', (p: Pending, decision: string) => send('approvals:resolved', p, decision))

  // window.prompt does not exist in Electron - it throws. The directory has to
  // come from the native dialog (or be typed into the renderer's own input).
  ipcMain.handle('dialog:pickDir', async () => {
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Pick a working directory for this agent',
      message: 'The agent may write freely inside this directory.',
      properties: ['openDirectory', 'createDirectory']
    })
    return canceled || !filePaths[0] ? null : filePaths[0]
  })

  ipcMain.handle('agent:spawn', (_e, spec: AgentSpec) => spawnAgent(spec))

  /**
   * Michael is the floor's starting state, not a hire: the renderer asks for him
   * on every launch and gets the running one back if he is already up, so a
   * reload cannot end up with two.
   */
  ipcMain.handle('god:ensure', (_e, size: { cols: number; rows: number }) => {
    const running = ptys.list().find((a) => a.id === GOD_ID && a.status === 'running')
    if (running) return { ...running, name: GOD_NAME, alreadyUp: true }
    const state = startGod(currentGodCwd(), size)
    return { ...state, name: GOD_NAME, alreadyUp: false }
  })

  /**
   * Move Michael to a directory the operator picked. `~/.bullpen/michael` is a
   * default, not a decision - one machine's layout is not another's.
   *
   * The CLI reads its working directory once, at startup, so this is a restart:
   * the running Michael is killed and a new one comes up in the new place. The
   * conversation does not survive that, which is why the UI says so first.
   */
  ipcMain.handle(
    'god:move',
    async (_e, dir: string, size: { cols: number; rows: number }) => {
      const target = resolve(dir)
      const bad = checkWorkspace(target, app.getPath('home'))
      if (bad) return { error: bad }

      writeConfig(BULLPEN_HOME, { ...readConfig(BULLPEN_HOME), godCwd: target })

      if (ptys.isRunning(GOD_ID)) {
        // spawn() refuses a duplicate id, so the old process must be gone -
        // not merely signalled - before the new one starts.
        await new Promise<void>((done) => {
          const timer = setTimeout(done, 5000)
          ptys.once('exit', (id: string) => {
            if (id !== GOD_ID) return
            clearTimeout(timer)
            done()
          })
          ptys.kill(GOD_ID)
        })
      }
      try {
        return { ...startGod(target, size), name: GOD_NAME }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('god:cwd', () => currentGodCwd())

  // The renderer never sees a path it did not get from here, and every one of
  // these re-checks the workspace boundary rather than trusting that.
  ipcMain.handle('code:list', (_e, root: string, rel: string) => {
    try {
      return { entries: listDir(root, rel) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('code:read', (_e, root: string, rel: string) => {
    try {
      return readFile(root, rel)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('code:write', (_e, root: string, rel: string, text: string) => {
    try {
      writeFile(root, rel, text)
      return { ok: true }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('code:edits', (_e, agentId: string) => edits.get(agentId) ?? [])
  /**
   * A plain shell in an agent's workspace.
   *
   * Deliberately not spawnAgent(): a shell gets no settings file, no hooks, no
   * mailbox and no pidfile. It is the operator's own terminal, not an agent, and
   * giving it an agent's control plane would put its every command through the
   * approvals gate that exists to police agents.
   */
  ipcMain.handle('shell:open', (_e, agentId: string, cwd: string, size: { cols: number; rows: number }) => {
    const id = SHELL_PREFIX + agentId
    const running = ptys.list().find((a) => a.id === id && a.status === 'running')
    if (running) return running
    return ptys.spawn({
      id,
      cwd: resolve(cwd),
      cmd: process.env.SHELL || 'bash',
      args: [],
      ...size,
      env: { BULLPEN_FLOOR: floorPath(BULLPEN_HOME) }
    })
  })

  ipcMain.handle('git:changes', (_e, root: string) => gitChanges(root))
  ipcMain.handle('git:diff', (_e, root: string, rel: string) => gitDiff(root, rel))

  ipcMain.handle('layout:get', () => readConfig(BULLPEN_HOME).layout ?? null)
  ipcMain.handle('layout:set', (_e, layout: unknown) => {
    writeConfig(BULLPEN_HOME, { ...readConfig(BULLPEN_HOME), layout })
    return true
  })

  /**
   * First run has no answer to "where should Michael work", and picking one
   * silently is how an agent ends up writing somewhere the operator never
   * looked. `chosen` is false until they say; `cwd` is only a suggestion.
   */
  ipcMain.handle('god:setup', () => ({
    chosen: Boolean(readConfig(BULLPEN_HOME).godCwd),
    cwd: currentGodCwd()
  }))

  /**
   * The renderer holds the only complete picture of the floor - names, projects
   * and live status - so it is what publishes the snapshot Michael reads. Agents
   * do not outlive the window, so a stale file cannot describe a live floor.
   */
  ipcMain.handle('floor:publish', (_e, agents: FloorAgent[]) => {
    lastFloor = agents
    return publishFloor(BULLPEN_HOME, agents, Date.now())
  })

  // Everywhere but macOS the frame is dropped, so these are the only window
  // controls there are - without them the window cannot be minimised or closed
  // except through the desktop's own shortcuts.
  ipcMain.handle('window:minimize', () => win?.minimize())
  ipcMain.handle('window:close', () => win?.close())

  ipcMain.handle('window:toggleMaximize', () => {
    if (!win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })

  // Used for the first briefing, which has the same paste problem.
  ipcMain.handle('agent:submit', (_e, id: string, text: string) => submitPrompt(id, text))
  ipcMain.handle('agent:list', () => ptys.list())
  ipcMain.handle('agent:kill', (_e, id: string) => ptys.kill(id))
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))

  // Triggers only fire at an idle agent. Injecting a scheduled prompt into a
  // turn in progress would corrupt whatever it was doing.
  board.start((t) => {
    if (!ptys.isRunning(t.agentId)) return
    submitPrompt(t.agentId, t.prompt)
    console.log(`[bullpen] trigger fired for ${t.agentId}: ${t.prompt.slice(0, 60)}`)
    activity.push('trigger', t.agentId, `scheduled prompt fired: ${t.prompt.slice(0, 80)}`)
    send('agent:trigger-fired', t.agentId, t.prompt)
  })

  ipcMain.handle('agent:ctx', (_e, id: string) => currentCtx(id))
  ipcMain.handle('agent:cost', (_e, id: string) => currentCost(id))
  ipcMain.handle('activity:list', (_e, limit?: number) => activity.list(limit))

  ipcMain.handle('ask:list', () => [...questions.values()])
  ipcMain.handle('ask:answer', (_e, qid: string, answer: string) => {
    const q = questions.get(qid)
    if (!q) return false
    questions.delete(qid)
    // The reply travels back through the hive, so the agent receives it exactly
    // as it receives any other message - no second delivery mechanism.
    hive.send({ from: HUMAN, to: q.from, subject: `re: ${q.subject}`, body: answer })
    activity.push('answer', HUMAN, `you answered ${q.from}: ${q.subject}`)
    send('ask:pending', [...questions.values()])
    return true
  })
  ipcMain.handle('ask:dismiss', (_e, qid: string) => {
    questions.delete(qid)
    send('ask:pending', [...questions.values()])
    return true
  })

  ipcMain.handle('agent:setGod', (_e, id: string) => {
    godId = id
    return godId
  })

  /**
   * Dispatch: hand a request to the god agent's own prompt. It is the god that
   * decomposes and assigns - Bullpen does not invent a plan of its own.
   */
  ipcMain.handle('agent:dispatch', (_e, text: string, owner: string, project = '') => {
    const target = godId && ptys.isRunning(godId) ? godId : null
    if (!target) return 'no god agent is running'
    const task = text.replace(/\r?\n/g, ' ')
    // Michael assigns; he does not do. Doing it himself is always the shortest
    // path, so the instruction has to say so every time - a floor where the one
    // agent that can see everyone is also the one doing the work is one agent.
    const HOW =
      'Do not do the work yourself. Read $BULLPEN_FLOOR and pick an agent on ' +
      'that project whose status is running and whose activity is idle - a ' +
      'stopped agent cannot be given anything. ' +
      `Reuse one whose ctxPct is under ${REUSE_BELOW_PCT}; over ${HIRE_ABOVE_PCT} ` +
      'treat them as not free even if idle, because what is left of their window ' +
      'is not enough to work in and everything they still carry is charged again ' +
      'every turn. Missing ctxPct means a fresh agent, not a full one. ' +
      'Send them the task through $BULLPEN_MAILBOX/outbox. ' +
      'If the project has nobody free by that rule, hire one: write a message to ' +
      '"hire" with the project as the subject and the task as the body. If the ' +
      'floor has never heard of the project, it has no directory yet - ask me ' +
      'where it lives and send the hire again with "cwd" set to that path. ' +
      'Then tell me who has it.'
    const where = project ? ` This is for the ${project} project.` : ''
    const brief =
      owner && owner !== 'decide'
        ? `Dispatch: ${task} — assign this to ${owner}.${where} ${HOW}`
        : `Dispatch: ${task} —${where} ${HOW}`
    submitPrompt(target, brief)
    activity.push('message', HUMAN, `you dispatched via ${target}: ${text.slice(0, 80)}`)
    return null
  })

  /** Plain substring search over the hive and the board - no index, no server. */
  ipcMain.handle('search:text', (_e, query: string) => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    const hits: { where: string; text: string }[] = []
    for (const t of board.tasks()) {
      if (t.text.toLowerCase().includes(q)) hits.push({ where: `task · ${t.status}`, text: t.text })
    }
    for (const t of board.triggers()) {
      if (t.prompt.toLowerCase().includes(q)) hits.push({ where: `trigger · ${t.agentId}`, text: t.prompt })
    }
    for (const item of activity.list(2000)) {
      if (item.text.toLowerCase().includes(q)) hits.push({ where: `activity · ${item.kind}`, text: item.text })
    }
    for (const id of hive.list()) {
      for (const msg of hive.peekInbox(id)) {
        const blob = `${msg.subject} ${msg.body}`
        if (blob.toLowerCase().includes(q)) hits.push({ where: `inbox · ${id}`, text: blob.slice(0, 300) })
      }
    }
    return hits.slice(0, 200)
  })

  ipcMain.handle('board:setTaskStatus', (_e, id: string, status: TaskStatus) =>
    board.setTaskStatus(id, status)
  )
  ipcMain.handle('board:assignTask', (_e, id: string, agentId: string) => board.assignTask(id, agentId))
  ipcMain.handle('board:tasks', (_e, id?: string) => board.tasks(id))
  ipcMain.handle('board:addTask', (_e, id: string, text: string) => board.addTask(id, text))
  ipcMain.handle('board:toggleTask', (_e, id: string) => board.toggleTask(id))
  ipcMain.handle('board:removeTask', (_e, id: string) => board.removeTask(id))
  ipcMain.handle('board:triggers', (_e, id?: string) => board.triggers(id))
  ipcMain.handle('board:addTrigger', (_e, id: string, prompt: string, mins: number) =>
    board.addTrigger(id, prompt, mins)
  )
  ipcMain.handle('board:toggleTrigger', (_e, id: string) => board.toggleTrigger(id))
  ipcMain.handle('board:removeTrigger', (_e, id: string) => board.removeTrigger(id))

  // Read-only on purpose: this shows an agent what instructions it is carrying.
  // Editing it is a job for a real editor, not a panel in a monitoring app.
  ipcMain.handle('agent:memory', (_e, cwd: string) => {
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']) {
      try {
        return { name, text: readFileSync(join(resolve(cwd), name), 'utf8').slice(0, 200_000) }
      } catch {
        // Try the next candidate.
      }
    }
    return null
  })

  ipcMain.handle('agent:steer', (_e, id: string, note: string) => approvals.steer(id, note))
  ipcMain.handle('agent:steers', (_e, id: string) => approvals.pendingSteers(id))

  ipcMain.handle('approvals:list', () => approvals.listPending())
  ipcMain.handle('approvals:decide', (_e, id: string, d: 'allow' | 'deny') => approvals.decide(id, d))

  ipcMain.handle('hive:send', (_e, msg) => hive.send(msg))
  ipcMain.handle('hive:inbox', (_e, id: string) => hive.peekInbox(id))
}

app.whenReady().then(async () => {
  // Defect A: a crash or SIGKILL skips every exit handler, so agents from the
  // previous run are still alive with shell access and still burning tokens.
  // The next startup is the only place left to clean them up - do it before
  // anything new spawns and starts reusing agent ids.
  const reaped = reapOrphans(AGENTS_HOME)
  const killed = reaped.filter((r) => r.outcome === 'killed')
  if (reaped.length) console.log('[bullpen] reaped orphans:', JSON.stringify(reaped))
  if (killed.length) setTimeout(() => forceKill(killed), 2000).unref?.()

  await approvals.start()
  wire()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Orphaned agents keep burning tokens and keep write access to disk, so every
// exit path that CAN run takes them down - including macOS, where the app would
// normally stay alive after the last window closes.
//
// SIGKILL and a hard crash remain uncatchable by definition; those are covered
// by reapOrphans() on the next startup, not here.
const shutdown = (): void => {
  ptys.killAll()
  approvals.stop()
  hive.stop()
  board.stop()
}
app.on('window-all-closed', () => {
  shutdown()
  app.quit()
})
app.on('before-quit', shutdown)
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, () => {
    shutdown()
    app.quit()
  })
}
