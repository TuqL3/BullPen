import { app, BrowserWindow, dialog, ipcMain, Notification, screen, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Approvals, type Pending } from './approvals.ts'
import { list as listDir, read as readFile, search as searchCode, write as writeFile } from './code.ts'
import { checkWorkspace, readConfig, writeConfig } from './config.ts'
import {
  changes as gitChanges,
  diff as gitDiff,
  discard as gitDiscard,
  discardBlock as gitDiscardBlock,
  discardHunk as gitDiscardHunk,
  stats as gitStats
} from './git.ts'
import { ActivityLog } from './activity.ts'
import { Board, boardPath, type TaskStatus } from './board.ts'
import { newToken, Webhooks } from './webhook.ts'
import { newMeter, update as updateCost, type Cost, type Meter } from './cost.ts'
import { lastAssistantText, readCtx, type Ctx } from './ctx.ts'
import {
  BA_ID,
  BA_NAME,
  baBrief,
  godBrief,
  GOD_ID,
  GOD_NAME,
  refuseMail,
  workerBrief,
  type Party,
  type Role,
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
import { hireName, slug as nameId } from '../names.ts'

// Unpackaged, Electron names itself and the dock says "Electron" with the
// default icon. The packaged app gets both from electron-builder; this is only
// so a dev run is the same app. Set before getPath(), which uses the name.
const ICON = join(import.meta.dirname, '../../build/icon.png')
if (!app.isPackaged) {
  app.setName('BullPen')
  app.whenReady().then(() => app.dock?.setIcon(ICON))
}

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

/** agentId -> the question it is stopped on in its own terminal, if any. */
const waiting = new Map<string, string>()

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
function spawnAgent(spec: AgentSpec & { role?: Role }): ReturnType<PtyManager['spawn']> {
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

  // Every agent is told what it is and who it answers to at spawn. Michael's
  // own CLAUDE.md is the operator's file once it exists, so his half of the
  // chain is appended here instead - a floor upgraded to the analyst chain must
  // not keep running a Michael who still believes he hires people himself.
  const role = spec.role ?? roleOf(spec.id)
  roles.set(spec.id, role)
  const brief =
    role === 'god'
      ? godBrief()
      : role === 'ba'
        ? baBrief()
        : workerBrief(spec.id, spec.reportTo ?? BA_ID, role)

  const state = ptys.spawn({
    ...spec,
    args: [...(spec.args ?? []), '--append-system-prompt', brief, '--settings', settingsPath],
    env: {
      ...spec.env,
      BULLPEN_AGENT_ID: spec.id,
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

/**
 * What each agent is for.
 *
 * Roles are what the chain is made of - who reports to whom, and which report
 * finishes a card. Held here rather than read back off the roster because main
 * acts on a message the instant it is routed, and the roster is a snapshot the
 * renderer publishes afterwards.
 */
const roles = new Map<string, Role>()

const roleOf = (id: string): Role =>
  roles.get(id) ?? (id === GOD_ID ? 'god' : id === BA_ID ? 'ba' : 'dev')

/** The project an agent is on, from the hire if we made it, else the roster. */
const projectOf = (id: string): string =>
  hires.get(id)?.project ?? lastFloor.find((r) => r.id === id)?.project ?? ''

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

/**
 * A name off the roster for a new hire, skipping anyone already on the floor.
 *
 * `hires` as well as the running ptys: an agent hired seconds ago may not have
 * reached `isRunning` yet, and two hires in the same turn used to be able to
 * claim the same name.
 */
function nextHireName(project: string): string {
  // nameId, not the project slug above: it is the same function hireName uses
  // to derive the candidate id, and two spellings of "taken" would let a name
  // through twice.
  const claimed = new Set([...hires.values()].map((h) => nameId(h.name)))
  return hireName(project, (id) => id === GOD_ID || claimed.has(id) || ptys.isRunning(id))
}

/** The roster as the renderer last published it - what Michael reads too. */
let lastFloor: FloorAgent[] = []

/** Agents seen working, so a Stop hook can be told from a turn that mattered. */
const working = new Set<string>()

/**
 * Whether a round of dispatched work still owes the operator a report.
 *
 * Armed when work is handed out, spent when the floor next falls quiet. Without
 * it the only trace of a finished round is one activity line per agent, which
 * says what each one stopped doing and nothing about where the work stands.
 */
let reportDue = false

/**
 * The progress report is not a question, and must not sit in the ask queue.
 *
 * It comes back the only way an agent can reach the operator - a message
 * addressed to "you" - but nothing is owed in reply: it says where the work
 * stands. Armed when the report is asked for, so the answer to that prompt is
 * routed to the monitor instead of to ask me. A subject of "report" says the
 * same thing for any that arrive late, after the flag has been spent.
 */
let reportWanted = false
let lastReport: (Message & { ts: number }) | null = null

/**
 * The last thing the operator dispatched, verbatim.
 *
 * What reaches the god agent is the brief wrapped in a page of instructions
 * about how to assign it; what the operator wants back is the sentence they
 * typed. Kept here so the monitor can show it, and so a reload still can.
 */
let lastDispatch: { text: string; owner: string; project: string; ts: number } | null = null

/** Push the board out whenever it changes, so the tasks tab is not a snapshot. */
function pushTasks(): void {
  send('board:tasks', board.tasks())
}

/** The same for schedules: firing one moves its clock, and the row says when. */
function pushTriggers(): void {
  send('board:triggers', board.triggers())
}

/** And for context rules, which arm and disarm on their own. */
function pushRules(): void {
  send('board:rules', board.rules())
}

/**
 * The inbound door. Nothing listens until the operator says so.
 *
 * A task that names an agent is mail to that agent; one that does not goes to
 * the god agent, who is the only one whose job is deciding who does what.
 */
const webhooks = new Webhooks()

/**
 * What Michael is told every time work is handed to him.
 *
 * He neither does the work nor hands it out: both go to the analyst. Said every
 * time because the shortest path is always to do it himself, and the second
 * shortest is to mail a developer directly - which leaves nobody analysing the
 * request and nobody testing the result.
 */
const RELAY_RULES =
  'Do not do this yourself, and do not assign it yourself. Hand it to the ' +
  `analyst: write a message to "${BA_ID}" in $BULLPEN_MAILBOX/outbox with the ` +
  'request in the body, in the words it was asked in. She analyses it, assigns ' +
  'or hires, and sees it through test. Then tell me you have handed it over ' +
  'and to whom. When she reports back, pass it to me as a message to "you".'

/**
 * The old rules, kept for the floor that has no analyst on it.
 *
 * She is a process like any other and can be killed or crash; when she is gone
 * the chain has to degrade to what it was rather than drop the work on the
 * floor. Nothing else uses this.
 */
const ASSIGN_RULES =
  'Do not do the work yourself. Read $BULLPEN_FLOOR and pick an agent on ' +
  'that project whose status is running and whose activity is idle - a ' +
  'stopped agent cannot be given anything. ' +
  `Reuse one whose ctxPct is under ${REUSE_BELOW_PCT}; over ${HIRE_ABOVE_PCT} ` +
  'treat them as not free even if idle, because what is left of their window ' +
  'is not enough to work in and everything they still carry is charged again ' +
  'every turn. Missing ctxPct means a fresh agent, not a full one. ' +
  'Send them the task through $BULLPEN_MAILBOX/outbox, and say in it that ' +
  'they must mail you a report when they are done or blocked. ' +
  'If the project has nobody free by that rule, hire one: write a message to ' +
  '"hire" with the project as the subject and the task as the body. If the ' +
  'floor has never heard of the project, it has no directory yet - ask me ' +
  'where it lives and send the hire again with "cwd" set to that path. ' +
  'Then tell me who has it.'

/**
 * Tell the operator, on the desktop, when the floor needs them or has news.
 *
 * Two rules keep this from being the feature people turn off on day one:
 *
 * - anything waiting on a human notifies whatever the window is doing, because
 *   a blocked agent stays blocked until it is answered
 * - everything else is silent while the window has focus, since a notification
 *   about a thing already on screen is just noise
 *
 * Clicking one brings the window up on the tab that has the thing in it.
 */
type Goto = { tab: string; id?: string }

let notifyAt = new Map<string, number>()
const NOTIFY_GAP_MS = 3000

function notify(kind: string, title: string, body: string, goto?: Goto): void {
  if (readConfig(BULLPEN_HOME).notify === false) return
  if (!Notification.isSupported()) return
  const needsYou = kind === 'ask'
  if (!needsYou && win?.isFocused()) return
  // One per kind per few seconds: four agents finishing at once is one thing
  // that happened, not four notifications.
  const last = notifyAt.get(kind) ?? 0
  if (Date.now() - last < NOTIFY_GAP_MS) return
  notifyAt.set(kind, Date.now())

  const note = new Notification({ title, body: body.replace(/\s+/g, ' ').slice(0, 220) })
  note.on('click', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (goto) send('ui:goto', goto.tab, goto.id ?? null)
  })
  note.show()
}

/** The last call in, accepted or not, so the panel can say whether it works. */
let lastCall: { at: number; from: string; subject: string; ok: boolean } | null = null

function webhookSettings(): { enabled: boolean; port: number; token: string } {
  const saved = readConfig(BULLPEN_HOME).webhook
  return { enabled: false, port: 8787, token: newToken(), ...saved }
}

function saveWebhook(next: { enabled: boolean; port: number; token: string }): void {
  writeConfig(BULLPEN_HOME, { ...readConfig(BULLPEN_HOME), webhook: next })
}

async function applyWebhook(): Promise<{ enabled: boolean; port: number; token: string; error?: string }> {
  const want = webhookSettings()
  try {
    if (!want.enabled) {
      await webhooks.stop()
      return want
    }
    const port = await webhooks.start(want.port, want.token)
    if (port !== want.port) {
      // Asked-for port was taken; the one it got is the one callers need.
      want.port = port
      saveWebhook(want)
    }
    activity.push('trust', 'bullpen', `webhook listening on 127.0.0.1:${port}`)
    return want
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    activity.push('dead', 'bullpen', `webhook could not start: ${error}`)
    return { ...want, enabled: false, error }
  }
}

/** The card an agent is on: its newest that is neither done nor abandoned. */
function openCard(agentId: string): { id: string; text: string; status: TaskStatus } | undefined {
  return board
    .tasks(agentId)
    .filter((t) => t.status !== 'done')
    .at(-1)
}

/**
 * Say that an agent has been given something, on the board.
 *
 * Assignments happen in the mail, between agents, with nothing in the UI to
 * click - so the board was a list only the operator ever wrote to, describing
 * work nobody was doing. A card per assignment makes it the floor's list.
 */
function cardFor(agentId: string, text: string, by = agentId): void {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300)
  if (!clean) return
  // Not a second card for the same instruction: Michael re-sends a task when he
  // chases it, and a chase is not a new job.
  const open = openCard(agentId)
  if (open && open.text === clean) return
  board.addTask(agentId, clean, 'todo')
  // Logged against whoever handed it over, not whoever received it: this line
  // is what the assigner's own page is made of.
  activity.push('task', by, `${by === agentId ? agentId : `${by} → ${agentId}`}: ${clean.slice(0, 80)}`)
  pushTasks()
}

/**
 * A tester has spoken, which is the only thing that finishes a task.
 *
 * The developer's card is sitting in wait_test with nobody's word on it but the
 * developer's. A pass closes it and the tester's own card with it; a fail puts
 * the tester's card in blocked and leaves the work where it is, because the
 * developer is being mailed about it directly and is not finished.
 */
function testerReported(testerId: string, subject: string): void {
  const failed = /^\s*(fail|bug|broken)\b/i.test(subject)
  cardTo(testerId, failed ? 'blocked' : 'done')
  if (failed) return
  const project = projectOf(testerId)
  for (const t of board.tasks()) {
    if (t.status !== 'wait_test') continue
    // Same project only: two features under test at once must not close each
    // other. With no project on either side this is every waiting card, which
    // is the honest answer on a floor that never said which project it is on.
    if (project && projectOf(t.agentId) !== project) continue
    board.setTaskStatus(t.id, 'done')
  }
  pushTasks()
}

/** Move an agent's open card, if it has one. */
function cardTo(agentId: string, status: TaskStatus): void {
  const open = openCard(agentId)
  if (!open || open.status === status) return
  board.setTaskStatus(open.id, status)
  pushTasks()
}


/**
 * Ask the god agent to report, once every agent it dispatched has gone quiet.
 *
 * An agent only acts when prompted, so "report when the work is done" cannot be
 * a standing instruction in the briefing - something has to notice the floor is
 * idle and say so. Disarmed before the prompt goes out: the report is itself a
 * turn, and re-arming on its own idle would loop forever.
 */
function reportWhenQuiet(): void {
  if (!reportDue || working.size > 0) return
  // The analyst is who knows where a task stands: she assigned it, and she is
  // the one waiting on a tester. Michael only ever reported what he was told.
  const target = ptys.isRunning(BA_ID) ? BA_ID : godId
  if (!target || !ptys.isRunning(target)) return
  reportDue = false
  reportWanted = true
  submitPrompt(
    target,
    target === BA_ID
      ? 'Everyone is idle now. Read $BULLPEN_MAILBOX/inbox first - developers and ' +
          'testers mail you when they finish - then $BULLPEN_FLOOR for anyone who ' +
          'sent nothing. Anything a developer reported as built and no tester has ' +
          'passed yet is not done: put a tester on it now if you have not. Then ' +
          `report to ${GOD_ID} by writing a message to "${GOD_ID}" in ` +
          '$BULLPEN_MAILBOX/outbox with the subject "report: ..." - one line per ' +
          'task, who built it, who tested it, where it stands, and which agents ' +
          'never reported. He passes it to the human; do not write to "you".'
      : 'Everyone is idle now. Read $BULLPEN_MAILBOX/inbox first - agents mail you a ' +
          'report when they finish - then $BULLPEN_FLOOR for anyone who sent nothing. ' +
          'Report to me: one line per agent, who they are, what project, and where ' +
          'their task stands. Say plainly which ones never reported and what you did ' +
          'to find out instead. Send it by writing a message to "you" in ' +
          '$BULLPEN_MAILBOX/outbox with the subject "report", not to the terminal.'
  )
  activity.push('message', target, 'asked for a progress report - the floor went quiet')
}

/**
 * Say that an agent finished, and what it said.
 *
 * The transcript is written after the Stop hook, so an immediate read finds the
 * previous turn. Retry a couple of times and take the first answer rather than
 * polling every agent forever.
 */
function reportFinished(id: string): void {
  const path = approvals.transcriptOf(id)
  const at = Date.now()
  const say = (text: string | null): void => {
    activity.push('done', id, text ? `${id} finished — ${text}` : `${id} finished a turn`)
    send('agent:finished', { id, text, at })
    notify('done', `${id} finished`, text ?? 'a turn', { tab: 'monitor', id })
  }
  if (!path) return say(null)
  const first = lastAssistantText(path)
  if (first) return say(first)
  let tries = 0
  const retry = (): void => {
    const text = lastAssistantText(path)
    if (text || ++tries >= 3) return say(text)
    setTimeout(retry, 1500).unref?.()
  }
  setTimeout(retry, 1200).unref?.()
}

/** Where Michael lives: whatever the operator chose, else the default. */
const currentGodCwd = (): string => readConfig(BULLPEN_HOME).godCwd ?? godCwd(BULLPEN_HOME)

/** Create the workspace, drop the briefing in it if absent, and bring him up. */
function startGod(cwd: string, size: { cols: number; rows: number }): ReturnType<PtyManager['spawn']> {
  mkdirSync(cwd, { recursive: true })
  writeBriefing(cwd, floorPath(BULLPEN_HOME))
  approvals.setSandbox(GOD_ID, cwd)
  return spawnAgent({ id: GOD_ID, cwd, cmd: 'claude', args: [], ...size })
}

/**
 * Kill an agent and wait for the process to actually be gone.
 *
 * `spawn()` refuses a duplicate id, so anything that restarts an agent has to
 * know the old one is dead rather than merely signalled. Listening for this
 * agent's exit specifically: a `once` listener that filters by id is spent by
 * whichever agent exits first, which is how killing two in a row turned into
 * a five second wait and then a spawn into a still-running pty.
 */
async function stop(id: string, ms = 5000): Promise<void> {
  if (!ptys.isRunning(id)) return
  await new Promise<void>((done) => {
    const finish = (): void => {
      clearTimeout(timer)
      ptys.off('exit', onExit)
      done()
    }
    const onExit = (gone: string): void => {
      if (gone === id) finish()
    }
    const timer = setTimeout(finish, ms)
    ptys.on('exit', onExit)
    ptys.kill(id)
  })
}

/**
 * Bring the analyst up.
 *
 * She works where Michael works. Her job is reading the floor, the mail and the
 * repositories he can already see - not editing anyone's code - so a workspace
 * of her own would only be a directory with nothing in it, and one she could not
 * read the projects from.
 */
function startBa(size: { cols: number; rows: number }): ReturnType<PtyManager['spawn']> {
  const cwd = currentGodCwd()
  mkdirSync(cwd, { recursive: true })
  approvals.setSandbox(BA_ID, cwd)
  return spawnAgent({ id: BA_ID, cwd, cmd: 'claude', args: [], role: 'ba', ...size })
}

/**
 * Where to open, given what was saved last time.
 *
 * The saved position is only honoured if it still lands on a screen that is
 * actually attached - a window restored onto an unplugged monitor is invisible
 * and looks exactly like a window that failed to open.
 */
function startBounds(): { width: number; height: number; x?: number; y?: number } {
  const saved = readConfig(BULLPEN_HOME).window
  if (!saved) return { width: 1700, height: 1000 }
  const { width, height, x, y } = saved
  if (x === undefined || y === undefined) return { width, height }
  const onScreen = screen.getAllDisplays().some((d) => {
    const w = d.workArea
    return x + width > w.x && x < w.x + w.width && y + height > w.y && y < w.y + w.height
  })
  return onScreen ? { width, height, x, y } : { width, height }
}

function createWindow(): void {
  const saved = readConfig(BULLPEN_HOME).window
  // The mode is known here, before anything is drawn. Read late it was a white
  // window and a light first paint that flipped to dark once the renderer had
  // asked - one flash of the wrong theme on every launch. Both the frame's own
  // background and the renderer's first render come from this.
  const mode = readConfig(BULLPEN_HOME).mode === 'dark' ? 'dark' : 'light'
  win = new BrowserWindow({
    ...startBounds(),
    backgroundColor: mode === 'dark' ? '#101119' : '#faf9f5',
    autoHideMenuBar: true,
    // Windows and Linux take the icon from the window; packaged builds get it
    // from the executable instead, and build/ is not shipped.
    ...(app.isPackaged ? {} : { icon: ICON }),
    // macOS keeps its native traffic lights, inset over our own title bar.
    // Everywhere else there is nothing worth keeping, so drop the frame.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 11 } }
      : { frame: false }),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      // Read by the preload, which runs before any of the page's own script:
      // an IPC round trip for this would be a round trip the first paint waits
      // on, or renders without.
      additionalArguments: [`--bullpen-mode=${mode}`],
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (saved?.maximized) win.maximize()

  // Remember the size and place across restarts. getNormalBounds() rather than
  // getBounds(): while maximised or full screen the latter reports the screen,
  // which would be restored as the "normal" size and could never be undone.
  let pending: NodeJS.Timeout | null = null
  const persistBounds = (): void => {
    if (!win || win.isDestroyed()) return
    const next = { ...win.getNormalBounds(), maximized: win.isMaximized() }
    writeConfig(BULLPEN_HOME, { ...readConfig(BULLPEN_HOME), window: next })
  }
  // A drag fires these continuously; writing the file per pixel is pointless.
  const schedule = (): void => {
    if (pending) clearTimeout(pending)
    pending = setTimeout(persistBounds, 400)
    pending.unref?.()
  }
  win.on('resize', schedule)
  win.on('move', schedule)
  // The debounce loses the last drag if the window closes inside 400ms of it.
  win.on('close', persistBounds)

  // Drop the reference as soon as it dies, so send() short-circuits on null
  // rather than repeatedly probing a corpse.
  win.on('closed', () => {
    if (pending) clearTimeout(pending)
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
  if (ctx) {
    send('agent:ctx', id, ctx)
    contextRule(id, ctx.pct)
  }
  const cost = currentCost(id)
  if (cost && cost.turns > 0) send('agent:cost', id, cost)
  return Boolean(ctx)
}

/**
 * Compact or clear an agent whose window is filling, if it asked for that.
 *
 * Only at an idle agent: `/compact` typed into a turn in progress is text in
 * the middle of its work, the same reason a steer rides out on a hook instead.
 * A busy one keeps its reading armed and is caught on the next read, which is
 * the Stop hook a moment later.
 */
const contextRule = (id: string, pct: number): void => {
  if (working.has(id) || !ptys.isRunning(id)) return
  const rule = board.ruleDue(id, pct)
  if (!rule) return
  submitPrompt(id, rule.action === 'clear' ? '/clear' : '/compact')
  activity.push('trigger', id, `context at ${pct}% - sent /${rule.action}`)
  send('board:rules', board.rules())
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
    // Webhook mail is logged where it arrives, under the name of whoever sent
    // it - "github-actions → michael" rather than a second line saying
    // "webhook → michael" about the same message.
    if (msg.from !== 'webhook') {
      activity.push('message', msg.from, `${msg.from} → ${to}: ${msg.subject}`)
    }
    // Work reaches an agent as mail and comes back the same way, so the mail is
    // what moves the card: nobody clicks anything on this floor. Which way it
    // moves depends on who wrote it - a developer saying "done" and a tester
    // saying "done" are not the same claim.
    const fromRole = roleOf(msg.from)
    const toRole = roleOf(to)
    const handedOut = (fromRole === 'god' || fromRole === 'ba') && fromRole !== toRole
    if (handedOut && toRole !== 'god' && toRole !== 'ba') {
      cardFor(to, [msg.subject, msg.body].filter(Boolean).join(' — '), msg.from)
    } else if (fromRole === 'dev' && toRole === 'ba') {
      // Built, not finished. The card waits for someone who did not write it.
      cardTo(msg.from, 'wait_test')
    } else if (fromRole === 'tester' && toRole === 'dev') {
      // A bug went straight back to whoever wrote it; that is work again.
      cardTo(to, 'doing')
    } else if (fromRole === 'dev' && toRole === 'tester') {
      // "Fixed, look again" - which puts it back in front of the tester, not
      // back in front of the analyst. Without this the card sat in doing for
      // the rest of the loop and the pass at the end closed nothing.
      cardTo(msg.from, 'wait_test')
    } else if (fromRole === 'tester' && toRole === 'ba') {
      testerReported(msg.from, msg.subject)
    } else if (to === godId && msg.from !== godId && fromRole !== 'ba') {
      // No analyst on the floor: the old chain, where reporting to Michael is
      // what finishing looks like.
      cardTo(msg.from, 'done')
    }
    send('hive:deliver', { to, msg })
  })
  /**
   * The chain, enforced where it can actually be enforced.
   *
   * Every rule here was something an agent did that looked reasonable from
   * inside its own turn: a developer mailing the boss directly with good news,
   * the boss mailing a developer because it was one line, an analyst answering
   * the human because she had the answer. Each one skips whoever was supposed
   * to see it first, and the floor stops meaning anything.
   */
  hive.gate = (from: string, to: string): string | null => {
    // Bullpen's own replies, the human's answers and inbound work are not part
    // of the chain; refusing them would strand the thing they answer.
    if (from === 'bullpen' || from === HUMAN || from === 'webhook') return null
    if (to === 'bullpen') return null
    // The analyst is a process like any other and can be killed. With her gone
    // the floor falls back to Michael assigning directly, and these rules would
    // only leave the work with nowhere to go.
    if (!ptys.isRunning(BA_ID)) return null
    const party: Party = to === HUMAN ? 'you' : to === HIRE ? 'hire' : roleOf(to)
    return refuseMail(roleOf(from), party)
  }

  hive.on('blocked', (msg: Message, why: string) => {
    activity.push('dead', msg.from, `${msg.from} → ${msg.to} refused: ${msg.subject}`)
    send('hive:dead', msg)
    // Told, not just stopped. An agent whose message vanished waits for a reply
    // that is never coming, which is the failure this whole file keeps hitting.
    if (ptys.isRunning(msg.from)) {
      hive.send({
        from: 'bullpen',
        to: msg.from,
        subject: `not delivered: ${msg.subject}`,
        body: `${why}\n\nNothing was delivered. Your message is unchanged in the dead letters if you need it back.`
      })
    }
  })

  hive.on('dead', (msg) => {
    activity.push('dead', msg.from, `undeliverable to ${msg.to}: ${msg.subject}`)
    send('hive:dead', msg)
  })
  hive.on('question', (msg: Message) => {
    // Stamped here: an agent writes the json itself and rarely sets `ts`, so
    // without this every question reads as "— ago" wherever it is shown.
    const ts = msg.ts || Date.now()
    if (msg.from === godId && (reportWanted || /^\s*re(port)?\b/i.test(msg.subject))) {
      reportWanted = false
      lastReport = { ...msg, ts }
      activity.push('message', msg.from, `${msg.from} reported: ${msg.subject}`)
      notify('report', `${msg.from} reported`, msg.body, { tab: 'monitor', id: msg.from })
      send('report:new', lastReport)
      return
    }
    const q = { ...msg, id: `q${++questionSeq}`, ts }
    questions.set(q.id, q)
    activity.push('question', msg.from, `${msg.from} asks you: ${msg.subject}`)
    notify('ask', `${msg.from} asks you`, msg.subject, { tab: 'ask me', id: msg.from })
    send('ask:pending', [...questions.values()])
  })

  // A router tick that throws would otherwise be an EventEmitter 'error' with
  // no listener, which takes the whole main process down over one bad message.
  hive.on('error', (err: unknown) => {
    activity.push('dead', 'bullpen', `mail router error: ${err instanceof Error ? err.message : String(err)}`)
  })

  hive.on('hire', (msg: Message) => {
    try {
      hire(msg)
    } catch (err) {
      // Anything unexpected still answers. A hire that neither spawns nor
      // replies is the one failure Michael cannot tell from being ignored, and
      // it is what a silently dropped round of hires looked like from his side.
      const why = err instanceof Error ? err.message : String(err)
      activity.push('dead', msg.from, `hire failed: ${why}`)
      hive.send({ from: 'bullpen', to: msg.from, subject: 're: hire', body: `hire failed: ${why}` })
    }
  })

  /**
   * Michael asking for another pair of hands.
   *
   * The floor he can see is the floor the renderer publishes, so a hire has to
   * come back out to the renderer to exist there too - main spawns the pty, the
   * renderer puts them on the roster and the office floor.
   *
   * Every path out of here answers him: spawned, refused, or failed.
   */
  function hire(msg: Message): void {
    const project = msg.subject.trim()
    // Anything that is not a tester is someone who builds: a typo in the field
    // must not quietly produce a third kind of agent nobody briefed.
    const role: Role = msg.role?.trim().toLowerCase() === 'tester' ? 'tester' : 'dev'
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
      const state = spawnAgent({
        id: slugId(name),
        cwd,
        cmd: 'claude',
        args: [],
        cols: 100,
        rows: 30,
        role,
        // Whoever asked for the hire is who the work comes back to.
        reportTo: msg.from
      })
      hires.set(state.id, { name, project })
      // A hire is work starting, even when nobody dispatched it from the UI.
      reportDue = true
      activity.push(
        'spawn',
        msg.from,
        `${msg.from} hired ${name} as ${role} on ${project}${known ? '' : ' (new project)'}`
      )
      // The briefing goes out with the hire: it is the task this agent exists
      // for, and the monitor has nowhere else to read it from.
      send('agent:hired', { ...state, name, project, role, brief: msg.body.trim() })
      // The briefing is what the new agent is for; it arrives as its first turn.
      if (msg.body.trim()) setTimeout(() => ptys.submit(state.id, msg.body), 4000).unref?.()
      // Only when there is something to do: a hire with no briefing is an
      // agent standing by, and a card reading "hired onto seo" says nothing the
      // hire line above it did not.
      if (msg.body.trim()) cardFor(state.id, msg.body.trim(), msg.from)
      hive.send({
        from: 'bullpen',
        to: msg.from,
        subject: 're: hire',
        body: `${name} (id "${state.id}") is on ${project} as a ${role} and has the task.`
      })
    } catch (err) {
      hive.send({
        from: 'bullpen',
        to: msg.from,
        subject: 're: hire',
        body: `Could not hire: ${err instanceof Error ? err.message : String(err)}`
      })
    }
  }

  webhooks.on(
    'task',
    (task: { to?: string; project?: string; subject: string; body: string; from: string }) => {
      const named = task.to && ptys.isRunning(task.to) ? task.to : null
      // Inbound work is the analyst's: she is the one who decides what it means
      // and who does it. Michael only takes it when she is not running.
      const to = named ?? (ptys.isRunning(BA_ID) ? BA_ID : godId)
      lastCall = { at: Date.now(), from: task.from, subject: task.subject, ok: Boolean(to) }
      send('webhook:call', lastCall)
      if (!to || !ptys.isRunning(to)) {
        activity.push('dead', 'webhook', `nobody to take it: ${task.subject}`)
        return
      }

      // Named an agent: that is the sender's choice, and it gets a card the way
      // any assignment does.
      if (named) {
        hive.send({ from: 'webhook', to: named, subject: task.subject, body: task.body })
        cardFor(named, `${task.subject} — ${task.body}`, 'webhook')
        activity.push('message', 'webhook', `${task.from} → ${named}: ${task.subject}`)
        notify('work', `Work in from ${task.from}`, `${named}: ${task.subject}`, {
          tab: 'monitor',
          id: named
        })
        reportDue = true
        return
      }

      // Nobody named: it goes to whoever is running the floor's intake. The
      // analyst already knows what to do with work - it is her whole brief - so
      // she gets the task and nothing else; Michael gets the old rules with it,
      // because on a floor without her nobody else will assign anything.
      const where = task.project ? ` This is for the ${task.project} project.` : ''
      const body =
        to === BA_ID
          ? `A task came in from ${task.from}: ${task.body}\n\n${where.trim()} `.trim() +
            'Treat it like any other request: analyse it, assign or hire, see it ' +
            `through test, and report to ${GOD_ID} when it passes.`
          : `A task came in from ${task.from}: ${task.body}\n\n` +
            `${where.trim()} ${ASSIGN_RULES}`.trim()
      hive.send({ from: 'webhook', to, subject: task.subject, body })
      activity.push('message', 'webhook', `${task.from} → ${to}: ${task.subject}`)
      notify('work', `Work in from ${task.from}`, task.subject, { tab: 'monitor' })
      // Michael reports when the floor next falls quiet, the same as a dispatch:
      // work that came in while nobody was looking is the work most worth a
      // summary afterwards.
      reportDue = true
    }
  )

  /**
   * A sender that cannot get in says so here rather than nowhere.
   *
   * The failure this is for is a token typo in someone's CI config: without a
   * line in the log it looks exactly like a webhook nobody ever wired up.
   * Rate limited, because a misconfigured caller retries forever.
   */
  let lastRefusalAt = 0
  webhooks.on('refused', (r: { from: string; why: string }) => {
    lastCall = { at: Date.now(), from: r.from, subject: r.why, ok: false }
    send('webhook:call', lastCall)
    if (Date.now() - lastRefusalAt < 10_000) return
    lastRefusalAt = Date.now()
    activity.push('dead', 'webhook', `refused a call from ${r.from}: ${r.why}`)
  })

  activity.on('activity', (item) => send('activity:item', item))
  hive.start()
  // Only if it was left on: a door that opens itself on upgrade is not a door.
  if (webhookSettings().enabled) void applyWebhook()

  approvals.on('status', (id: string, status: string) => {
    send('agent:status', id, status)
    if (status === 'working') {
      working.add(id)
      // Taking a turn is not taking the card back. A developer whose work is
      // waiting on a tester gets woken by all sorts of things - a broadcast, a
      // question, the tester's own reply - and every one of them used to drag
      // the card out of wait_test, so the pass at the end of the loop found
      // nothing to close.
      if (openCard(id)?.status !== 'wait_test') cardTo(id, 'doing')
    }
    // A turn just ended, so the transcript now holds its token counts.
    if (status === 'idle') {
      pushCtxSoon(id)
      // Only for an agent that was actually working: the Stop hook also fires
      // for turns nobody was waiting on, and "finished" should mean finished
      // something. The report is what it last said - the closest thing to one
      // that exists without asking the model to write it.
      if (working.delete(id)) reportFinished(id)
      reportWhenQuiet()
    }
  })
  // An agent stopped at its own question. Bullpen cannot answer it - the CLI is
  // waiting on a keystroke in that terminal - so the job here is to say who is
  // stuck and on what, rather than leave it reading as "working".
  approvals.on('waiting', (id: string, asked: string) => {
    if (waiting.get(id) === asked) return
    waiting.set(id, asked)
    cardTo(id, 'blocked')
    activity.push('question', id, `${id} is waiting on you: ${asked}`)
    notify('ask', `${id} is waiting on you`, asked, { tab: 'ask me', id })
    send('agent:waiting', id, asked)
  })
  approvals.on('answered', (id: string) => {
    if (!waiting.delete(id)) return
    cardTo(id, 'doing')
    send('agent:waiting', id, null)
  })

  approvals.on('tool', (id: string, tool: string, detail: string) =>
    send('agent:tool', id, tool, detail)
  )

  approvals.on('transcript', (id: string) => pushCtxSoon(id))
  approvals.on('steer-queued', (id: string, note: string, depth: number) =>
    send('agent:steer-queued', id, note, depth)
  )
  approvals.on('steer-cleared', (id: string, notes: string[]) => {
    activity.push('steer', id, `${notes.length} queued note${notes.length === 1 ? '' : 's'} dropped - ${id} was halted`)
    send('agent:steer-cleared', id, notes)
  })
  approvals.on('steer-delivered', (id: string, notes: string[]) => {
    activity.push('steer', id, `steer delivered to ${id}: ${notes.join(' | ').slice(0, 80)}`)
    send('agent:steer-delivered', id, notes)
  })
  approvals.on('pending', (p: Pending) => {
    activity.push('approval', p.agentId, `${p.agentId} needs approval for ${p.toolName}: ${p.reason}`)
    notify('ask', `${p.agentId} needs approval`, `${p.toolName}: ${p.reason}`, {
      tab: 'ask me',
      id: p.agentId
    })
  })
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
  /**
   * The analyst, brought up beside Michael - or the one already running there.
   *
   * "Already running" is not enough: she works in his directory, a CLI reads
   * its working directory once at startup, and moving him used to leave her
   * sitting in the old one with nothing on screen to say so. If she is in the
   * wrong place she is restarted, which is the only way to move a CLI.
   */
  ipcMain.handle('ba:ensure', async (_e, size: { cols: number; rows: number }) => {
    const want = resolve(currentGodCwd())
    const running = ptys.list().find((a) => a.id === BA_ID && a.status === 'running')
    if (running && resolve(running.cwd) === want) {
      return { ...running, name: BA_NAME, alreadyUp: true }
    }
    if (running) await stop(BA_ID)
    return { ...startBa(size), name: BA_NAME, alreadyUp: false }
  })

  /**
   * What an agent is, when the operator made it by hand rather than hiring it.
   *
   * The wizard is the one path that creates an agent main did not brief, and
   * without this its role would be whatever the default is - which decides
   * where its cards go and who its reports finish.
   */
  ipcMain.handle('agent:setRole', (_e, id: string, role: Role) => {
    if (role !== 'god' && role !== 'ba' && role !== 'dev' && role !== 'tester') return false
    roles.set(id, role)
    return true
  })

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

      // She works where he works, so she moves with him. Stopped here rather
      // than left for `ba:ensure` to notice, so the floor is never briefly a
      // Michael in the new directory and an Iris in the old one.
      await stop(BA_ID)
      await stop(GOD_ID)
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
  ipcMain.handle(
    'code:search',
    (_e, root: string, query: string, caseSensitive: boolean, regex: boolean, only?: string[]) => {
      try {
        return searchCode(root, query, { caseSensitive, regex, only })
      } catch (err) {
        return { hits: [], files: 0, scanned: 0, capped: false, error: String(err) }
      }
    }
  )
  /**
   * A plain shell in an agent's workspace.
   *
   * Deliberately not spawnAgent(): a shell gets no settings file, no hooks, no
   * mailbox and no pidfile. It is the operator's own terminal, not an agent, and
   * giving it an agent's control plane would put its every command through the
   * approvals gate that exists to police agents.
   */
  ipcMain.handle(
    'shell:open',
    (_e, agentId: string, cwd: string, size: { cols: number; rows: number }, fresh = false) => {
    const base = SHELL_PREFIX + agentId
    // Without `fresh`, opening the panel reattaches to the shell already there
    // rather than starting a second one behind the first. With it, "new shell"
    // means what it says - it used to hand back the running shell, so the
    // button looked broken.
    if (!fresh) {
      const running = ptys.list().find((a) => a.id.startsWith(base) && a.status === 'running')
      if (running) return running
    }
    let id = base
    for (let n = 2; ptys.isRunning(id) && n < 50; n++) id = `${base}#${n}`
    return ptys.spawn({
      id,
      cwd: resolve(cwd),
      cmd: process.env.SHELL || 'bash',
      args: [],
      ...size,
      env: { BULLPEN_FLOOR: floorPath(BULLPEN_HOME) }
    })
    }
  )

  ipcMain.handle('git:changes', (_e, root: string) => gitChanges(root))
  ipcMain.handle('git:diff', (_e, root: string, rel: string) => gitDiff(root, rel))
  ipcMain.handle('git:stats', (_e, root: string) => gitStats(root))
  // Destructive and irreversible - the confirmation is the renderer's job, and
  // the path guard in git.ts is what keeps it inside the agent's workspace.
  ipcMain.handle('git:discard', async (_e, root: string, rel: string) => {
    const res = await gitDiscard(root, rel)
    if (res.ok) activity.push('discard', HUMAN, `you discarded changes to ${rel}`)
    return res
  })
  ipcMain.handle(
    'git:discardBlock',
    async (_e, root: string, rel: string, hunk: number, block: number, marker: string) => {
      const res = await gitDiscardBlock(root, rel, hunk, block, marker)
      if (res.ok) activity.push('discard', HUMAN, `you discarded one block of ${rel}`)
      return res
    }
  )
  ipcMain.handle(
    'git:discardHunk',
    async (_e, root: string, rel: string, index: number, marker: string) => {
      const res = await gitDiscardHunk(root, rel, index, marker)
      if (res.ok) activity.push('discard', HUMAN, `you discarded one hunk of ${rel}`)
      return res
    }
  )

  // The CLI draws its own prompt block and chrome from a theme of its own, so
  // it has to be told which one Bullpen is in - otherwise a dark ~/.claude
  // setting paints a black band down a light terminal.
  ipcMain.handle('ui:setMode', (_e, mode: 'light' | 'dark') => {
    if (mode !== 'light' && mode !== 'dark') return false
    writeConfig(BULLPEN_HOME, { ...readConfig(BULLPEN_HOME), mode })
    approvals.setTheme(mode)
    // Rewrite what is on disk for every agent already running. Their CLI keeps
    // the theme it started with, but a restarted one - and the next hire - will
    // not be left mismatched until the config is touched again.
    for (const id of ptys.list().map((a) => a.id)) {
      if (!isShell(id)) approvals.installHook(id, join(AGENTS_HOME, id))
    }
    return true
  })

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

  // Full screen rather than maximise: maximise stops at the work area, which is
  // the thing that made this button look broken.
  ipcMain.handle('window:toggleFullscreen', () => {
    if (!win) return
    win.setFullScreen(!win.isFullScreen())
  })

  // Used for the first briefing, which has the same paste problem.
  ipcMain.handle('agent:submit', (_e, id: string, text: string) => submitPrompt(id, text))
  ipcMain.handle('agent:list', () => ptys.list())
  ipcMain.handle('agent:kill', (_e, id: string) => {
    // Halt takes the queue with it: those notes were waiting for a tool call
    // this agent is not going to make.
    approvals.clearSteers(id)
    return ptys.kill(id)
  })
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))

  // Triggers only fire at an idle agent. Injecting a scheduled prompt into a
  // turn in progress would corrupt whatever it was doing.
  board.start((t) => {
    // Not delivered, not spent: it stays due and goes in when the agent is
    // next up, instead of the interval quietly passing.
    if (!ptys.isRunning(t.agentId)) return false
    submitPrompt(t.agentId, t.prompt)
    console.log(`[bullpen] trigger fired for ${t.agentId}: ${t.prompt.slice(0, 60)}`)
    activity.push('trigger', t.agentId, `scheduled prompt fired: ${t.prompt.slice(0, 80)}`)
    send('agent:trigger-fired', t.agentId, t.prompt)
    // Stamped by the board once this returns true; the panel reads it next tick.
    setTimeout(pushTriggers, 0).unref?.()
    return true
  })

  ipcMain.handle('agent:ctx', (_e, id: string) => currentCtx(id))
  ipcMain.handle('agent:cost', (_e, id: string) => currentCost(id))
  ipcMain.handle('activity:list', (_e, limit?: number) => activity.list(limit))

  ipcMain.handle('ask:list', () => [...questions.values()])
  // Re-read on a reload: the report is the one thing on the monitor that did
  // not happen while this window was open.
  ipcMain.handle('report:last', () => lastReport)
  ipcMain.handle('dispatch:last', () => lastDispatch)
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
   * Dispatch: hand a request to the boss's own prompt, and only ever his.
   *
   * He is who the operator hired to stand in for them, so what they type goes
   * to him even though he is not the one who will decide anything about it - he
   * reads it, passes it to the analyst, and tells the operator he has. Typing it
   * straight into the analyst would be faster and would cut the one agent whose
   * whole job is being the operator's end of this out of the operator's own
   * request.
   */
  ipcMain.handle('agent:dispatch', (_e, text: string, owner: string, project = '') => {
    const target = godId && ptys.isRunning(godId) ? godId : null
    if (!target) return 'no god agent is running'
    const task = text.replace(/\r?\n/g, ' ')
    const where = project ? ` This is for the ${project} project.` : ''
    // With an analyst on the floor Michael relays; without one he is still the
    // only agent who can see everyone, and falls back to assigning it himself.
    const rules = ptys.isRunning(BA_ID) ? RELAY_RULES : ASSIGN_RULES
    const who = owner && owner !== 'decide' ? ` I suggest ${owner} takes it.` : ''
    const brief = `Dispatch: ${task} —${where}${who} ${rules}`
    submitPrompt(target, brief)
    reportDue = true
    lastDispatch = { text, owner, project, ts: Date.now() }
    send('dispatch:new', lastDispatch)
    activity.push('message', HUMAN, `you dispatched to ${target}: ${text.slice(0, 80)}`)
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

  ipcMain.handle('board:setTaskStatus', (_e, id: string, status: TaskStatus) => {
    board.setTaskStatus(id, status)
    pushTasks()
  })
  ipcMain.handle('board:assignTask', (_e, id: string, agentId: string) => {
    board.assignTask(id, agentId)
    pushTasks()
  })
  ipcMain.handle('board:tasks', (_e, id?: string) => board.tasks(id))
  ipcMain.handle('board:addTask', (_e, id: string, text: string) => {
    const t = board.addTask(id, text)
    pushTasks()
    return t
  })
  ipcMain.handle('board:toggleTask', (_e, id: string) => {
    board.toggleTask(id)
    pushTasks()
  })
  ipcMain.handle('board:removeTask', (_e, id: string) => {
    board.removeTask(id)
    pushTasks()
  })
  ipcMain.handle('board:triggers', (_e, id?: string) => board.triggers(id))
  ipcMain.handle('board:addTrigger', (_e, id: string, prompt: string, mins: number) => {
    const made = board.addTrigger(id, prompt, mins)
    pushTriggers()
    return made
  })
  ipcMain.handle('board:toggleTrigger', (_e, id: string) => {
    board.toggleTrigger(id)
    pushTriggers()
  })
  ipcMain.handle('board:removeTrigger', (_e, id: string) => {
    board.removeTrigger(id)
    pushTriggers()
  })
  /**
   * A link out of a rendered document.
   *
   * Only http(s): a memory file is written by an agent, and `file:` or a custom
   * scheme would be a document choosing what this machine opens.
   */
  ipcMain.handle('ui:open', (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) return false
    shell.openExternal(url)
    return true
  })
  ipcMain.handle('ui:notify', () => readConfig(BULLPEN_HOME).notify !== false)
  ipcMain.handle('ui:setNotify', (_e, on: boolean) => {
    writeConfig(BULLPEN_HOME, { ...readConfig(BULLPEN_HOME), notify: on === true })
    return on === true
  })
  ipcMain.handle('webhook:get', () => ({
    ...webhookSettings(),
    running: webhooks.running,
    lastCall
  }))
  /**
   * Post a task to ourselves, exactly as an outside caller would.
   *
   * The question "is this thing on" is worth answering with the real path -
   * socket, token, parser, mail - rather than a message the UI writes itself.
   */
  ipcMain.handle('webhook:test', async () => {
    const { port, token } = webhookSettings()
    if (!webhooks.running) return { ok: false, error: 'the webhook is off' }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/task`, {
        method: 'POST',
        headers: { 'x-bullpen-token': token, 'x-bullpen-from': 'bullpen test' },
        body: 'This is a test task from the Bullpen panel. Nothing to do - reply that you got it.'
      })
      return { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 200) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('webhook:set', async (_e, enabled: boolean, port: number) => {
    const now = webhookSettings()
    const clean = Number.isFinite(port) && port > 0 && port < 65536 ? Math.floor(port) : now.port
    saveWebhook({ ...now, enabled: enabled === true, port: clean })
    const applied = await applyWebhook()
    return { ...applied, running: webhooks.running }
  })
  ipcMain.handle('webhook:rotate', async () => {
    saveWebhook({ ...webhookSettings(), token: newToken() })
    const applied = await applyWebhook()
    return { ...applied, running: webhooks.running }
  })

  ipcMain.handle('board:rules', (_e, id?: string) => board.rules(id))
  ipcMain.handle('board:setRule', (_e, id: string, atPct: number, action: 'compact' | 'clear') => {
    const made = board.setRule(id, atPct, action)
    pushRules()
    return made
  })
  ipcMain.handle('board:toggleRule', (_e, id: string) => {
    board.toggleRule(id)
    pushRules()
  })
  ipcMain.handle('board:removeRule', (_e, id: string) => {
    board.removeRule(id)
    pushRules()
  })

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

  approvals.setTheme(readConfig(BULLPEN_HOME).mode ?? 'light')
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
  void webhooks.stop()
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
