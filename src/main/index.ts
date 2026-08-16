import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Approvals, type Pending } from './approvals.ts'
import { ActivityLog } from './activity.ts'
import { Board, boardPath, type TaskStatus } from './board.ts'
import { newMeter, update as updateCost, type Cost, type Meter } from './cost.ts'
import { readCtx, type Ctx } from './ctx.ts'
import { Hive, HUMAN, type Message } from './hive.ts'
import { PtyManager, type AgentSpec } from './pty.ts'
import { clearPid, forceKill, reapOrphans, writePid } from './reaper.ts'

const BULLPEN_HOME = process.env.BULLPEN_HOME ?? join(app.getPath('home'), '.bullpen')
const AGENTS_HOME = join(BULLPEN_HOME, 'agents')

const hive = new Hive(join(BULLPEN_HOME, 'hive'))
const approvals = new Approvals(join(BULLPEN_HOME, 'control'))
const ptys = new PtyManager()
const board = new Board(boardPath(BULLPEN_HOME))
const activity = new ActivityLog()

/** Questions agents have addressed to the human, newest last. */
const questions = new Map<string, Message & { id: string }>()
let questionSeq = 0

/** The god agent - the operator's own clone. Dispatch and answers route via it. */
let godId: string | null = null

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
    // Drop the claim first: a pidfile outliving its process is what makes the
    // next startup consider killing whatever inherited that pid.
    clearPid(join(AGENTS_HOME, id))
    meters.delete(id)
    activity.push('exit', id, `${id} exited (code ${code})`)
    send('agent:exit', id, code)
  })

  hive.on('deliver', ({ to, msg }) => {
    ptys.deliver(to, msg.from, msg.subject, msg.body)
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

  ipcMain.handle('agent:spawn', (_e, spec: AgentSpec) => {
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
      env: { ...spec.env, BULLPEN_MAILBOX: hive.agentDir(spec.id) }
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
  })

  ipcMain.handle('window:toggleMaximize', () => {
    if (!win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })

  ipcMain.handle('agent:list', () => ptys.list())
  ipcMain.handle('agent:kill', (_e, id: string) => ptys.kill(id))
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))

  // Triggers only fire at an idle agent. Injecting a scheduled prompt into a
  // turn in progress would corrupt whatever it was doing.
  board.start((t) => {
    if (!ptys.isRunning(t.agentId)) return
    ptys.write(t.agentId, t.prompt.replace(/\r?\n/g, ' ') + '\r')
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
  ipcMain.handle('agent:dispatch', (_e, text: string, owner: string) => {
    const target = godId && ptys.isRunning(godId) ? godId : null
    if (!target) return 'no god agent is running'
    const brief =
      owner && owner !== 'decide'
        ? `Dispatch: ${text.replace(/\r?\n/g, ' ')} — assign this to ${owner}.`
        : `Dispatch: ${text.replace(/\r?\n/g, ' ')} — decide who should own it and assign it.`
    ptys.write(target, brief + '\r')
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
