import { app, BrowserWindow, dialog, ipcMain, Notification, screen, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Approvals, type Pending } from './approvals.ts'
import { list as listDir, read as readFile, search as searchCode, write as writeFile } from './code.ts'
import { checkWorkspace, mergeUi, readConfig, writeConfig } from './config.ts'
import {
  changes as gitChanges,
  diff as gitDiff,
  discard as gitDiscard,
  discardBlock as gitDiscardBlock,
  stats as gitStats
} from './git.ts'
import { ActivityLog } from './activity.ts'
import { Board, boardPath, type TaskStatus } from './board.ts'
import { newToken, Webhooks } from './webhook.ts'
import { newMeter, update as updateCost, type Cost, type Meter } from './cost.ts'
import { lastAssistantText, readCtx, type Ctx } from './ctx.ts'
import {
  floorPath,
  godCwd,
  publishFloor,
  writeBriefing,
  type FloorAgent
} from './god.ts'
import { execFile } from 'node:child_process'
import { routeCard } from './cards.ts'
import { dryRun } from './dryrun.ts'
import { DEFAULT_WORKFLOW, NEW_FLOOR, PRESETS, STARTER } from './presets.ts'
import {
  HIRE_PARTY,
  HUMAN_PARTY,
  can,
  columnFor,
  deleteWorkflow,
  fixedId,
  formatDoc,
  hasPlaceFor,
  drawnCardRules,
  lint,
  listWorkflows,
  parseMarkdown,
  parseWorkflow,
  pickForRole,
  refuseMail,
  renderBrief,
  roleOfFixedId,
  rolesWith,
  saveWorkflow,
  pctOr,
  toMarkdown,
  type Candidate,
  type ColumnKind,
  type Workflow,
  workCwd
} from './workflow.ts'
import { generatorBrief } from '../workflow-spec.ts'
// The format, as one document rather than a table in a source file. Bundled
// into main because the model that writes workflows is briefed with it, and
// read off disk by the tests that check it still describes what the parser does.
// The rules, bundled. One document: what a floor may contain, what refuses one,
// and what the model that writes floors is briefed with. There used to be two -
// a schema for the code and a description for people - and a test to keep them
// from drifting, which is what having two always costs.
import RULES_TEXT from '../rules.md?raw'
import { readRules } from '../rules.ts'

/**
 * The reference in force: whatever is at `~/.bullpen/workflow-format.md`, else
 * the one Bullpen ships. Called rather than held, so replacing that file takes
 * effect on the next generation instead of the next launch.
 */
const format = (): { text: string; path: string; custom: boolean } =>
  formatDoc(BULLPEN_HOME, RULES_TEXT)

/** The rules in force, parsed. Read per call, so an edit lands immediately. */
const rulebook = (): ReturnType<typeof readRules> => readRules(format().text)

/** What the writer is told: the whole reference, and how to answer. */
const generatorPrompt = (): string => generatorBrief(format().text, STARTER)
import { Hive, HUMAN, type Message } from './hive.ts'
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


const hive = new Hive(join(BULLPEN_HOME, 'hive'))
const approvals = new Approvals(join(BULLPEN_HOME, 'control'))
const ptys = new PtyManager()
const board = new Board(boardPath(BULLPEN_HOME))
const activity = new ActivityLog()

/** agentId -> the question it is stopped on in its own terminal, if any. */
const waiting = new Map<string, string>()

/** Questions agents have addressed to the human, newest last. */
const questions = new Map<string, Message & { id: string }>()
let questionSeq = 0

/**
 * The shape of this floor: who exists, who writes to whom, what they are told.
 *
 * Read once at startup and replaced when the operator applies a different one.
 * Everything below asks this rather than a constant, which is the whole point:
 * somebody else's floor does not have Michael and Iris on it.
 */
let wf: Workflow = DEFAULT_WORKFLOW

/** The agent a task typed at the floor goes to. Null only if none is running. */
const dispatchId = (): string => fixedId(wf, wf.dispatch) ?? wf.dispatch

/** The agent inbound work goes to - often the one who assigns, not the boss. */
const entryId = (): string => fixedId(wf, wf.entry) ?? wf.entry

/**
 * Every fixed agent besides dispatch, in the order the workflow lists them.
 *
 * A floor is not two people. `analyst-chain` happens to have a boss and an
 * analyst, and treating "the second one" as a special case meant a workflow
 * with a third standing agent - a QA lead, a release manager - simply never
 * started it, with nothing anywhere saying why.
 */
const assistRoles = (): { role: string; id: string; name: string }[] =>
  Object.keys(wf.roles)
    .filter((r) => r !== wf.dispatch && wf.roles[r].fixed)
    .map((r) => ({
      role: r,
      id: wf.roles[r].fixed?.id ?? r,
      name: wf.roles[r].fixed?.name ?? r
    }))

/**
 * The fixed agent who hands work out, if the workflow has one distinct from
 * dispatch. On a floor where the boss assigns directly this is null, and every
 * caller falls back to dispatch - which is the same agent.
 */
const assistId = (): string | null =>
  assistRoles().find((a) => can(wf, a.role, 'assigns'))?.id ?? null

/** Whoever is actually there to take work right now. */
const assignerId = (): string | null => {
  const helper = assistId()
  if (helper && ptys.isRunning(helper)) return helper
  return godId
}

/**
 * The god agent - the operator's own clone. Dispatch and answers route via it.
 *
 * Defaults to the workflow's dispatch agent, spawned on launch rather than
 * hired, so the floor is never empty and there is always someone to dispatch
 * through.
 */
let godId: string | null = DEFAULT_WORKFLOW.roles[DEFAULT_WORKFLOW.dispatch].fixed?.id ?? null

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
function spawnAgent(spec: AgentSpec & { role?: string }): ReturnType<PtyManager['spawn']> {
  const cwd = resolve(spec.cwd)
  // The sandbox is the only thing standing between an agent and the rest of
  // the disk, so refuse the two directories that would make it meaningless.
  if (cwd === app.getPath('home') || cwd === resolve('/')) {
    throw new Error(`refusing to sandbox an agent at ${cwd} - pick a scratch directory`)
  }
  spec = { ...spec, cwd }
  mkdirSync(spec.cwd, { recursive: true })
  // Which floor this one was briefed on. A CLI is handed its brief once, at
  // spawn, so this is the shape it is really running - not the shape the app
  // is on now.
  bornOn.set(spec.id, wf.name)
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
  // What this role never does, enforced by the approvals layer rather than
  // asked for in the brief. A brief is advice; this is the answer to the hook.
  approvals.setDenied(spec.id, wf.roles[role]?.never ?? [])
  const brief = [
    renderBrief(wf, role, {
      id: spec.id,
      name: wf.roles[role]?.fixed?.name ?? spec.id,
      reportTo: spec.reportTo ?? assignerId() ?? dispatchId()
    }),
    houseRules(wf, role, spec.id)
  ]
    .filter(Boolean)
    .join('\n\n')

  // The command this role runs. A floor may put a cheaper model on the role
  // that only reads, or a different CLI entirely on the one that writes.
  const cli = wf.roles[role]?.cli?.trim()
  const said = cli ? cli.split(/\s+/) : []
  const cmd = said[0] ?? spec.cmd
  const cliArgs = said.slice(1)

  const state = ptys.spawn({
    ...spec,
    cmd,
    args: [
      ...cliArgs,
      ...(spec.args ?? []),
      '--append-system-prompt',
      brief,
      '--settings',
      settingsPath
    ],
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

/**
 * The part of the briefing no workflow writes, because it is about Bullpen.
 *
 * Every brief used to ask the agent to do the floor's bookkeeping itself: read
 * the floor file, work out who is idle, compare their context against two
 * numbers, hire when nobody fits. That is four steps a model performs
 * unreliably and silently, and the app already knows all four answers - so it
 * does it, and this says so.
 */
function houseRules(w: Workflow, role: string, id: string): string {
  const down = (w.talksTo[role] ?? []).filter((to) => w.roles[to])
  if (!down.length) return ''
  const list = down.map((r) => `"${r}"`).join(', ')
  return [
    `Handing work over: address the message to the role, not to a person - ${list}.`,
    `Bullpen puts it in front of whoever is free, hires somebody when nobody is,`,
    `and puts the task on the board under their name. You do not have to know who`,
    `is on the floor or how full their context is.`,
    ``,
    `{"from": "${id}", "to": "${down[0]}", "subject": "<the task in a few words>", "body": "<what is needed>"}`,
    ``,
    `Start a report with "done: " when a task is finished and "fail: " when it is`,
    `not. That is what moves the card off the board.`
  ].join('\n')
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
const roles = new Map<string, string>()

/**
 * What an agent is, on this floor.
 *
 * A fixed id answers for itself - Michael is the boss because the workflow says
 * that id is. Anything else that was never told falls back to the first role
 * that builds, because an unknown agent doing work is the common case and the
 * one where guessing wrong costs least.
 */
const roleOf = (id: string): string =>
  roles.get(id) ?? roleOfFixedId(wf, id) ?? rolesWith(wf, 'builds')[0] ?? wf.dispatch

/** The project an agent is on, from the hire if we made it, else the roster. */
const projectOf = (id: string): string =>
  hires.get(id)?.project ?? lastFloor.find((r) => r.id === id)?.project ?? ''

/**
 * Project names, for matching a project to a directory. Not agent ids - those
 * are `nameId`, the one the wizard also uses, so both ways of putting somebody
 * on the floor derive the same id from the same name.
 */
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
  return hireName(
    project,
    (id) => Boolean(roleOfFixedId(wf, id)) || claimed.has(id) || ptys.isRunning(id)
  )
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
const relayRules = (): string => {
  const to = assistId()
  if (!to) return assignRules()
  return (
    'Do not do this yourself, and do not assign it yourself. Hand it to ' +
    `${wf.roles[roleOf(to)]?.label ?? to}: write a message to "${to}" in ` +
    '$BULLPEN_MAILBOX/outbox with the request in the body, in the words it was ' +
    'asked in. They analyse it, assign or hire, and see it through. Then tell me ' +
    'you have handed it over and to whom. When they report back, pass it to me ' +
    'as a message to "you".'
  )
}

/**
 * The old rules, kept for the floor that has no analyst on it.
 *
 * She is a process like any other and can be killed or crash; when she is gone
 * the chain has to degrade to what it was rather than drop the work on the
 * floor. Nothing else uses this.
 */
const assignRules = (): string =>
  'Do not do the work yourself. Read $BULLPEN_FLOOR and pick an agent on ' +
  'that project whose status is running and whose activity is idle - a ' +
  'stopped agent cannot be given anything. ' +
  `Reuse one whose ctxPct is under ${wf.reuseBelowPct}; over ${wf.hireAbovePct} ` +
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

/**
 * The columns this floor uses when nothing was sent: where a new card starts,
 * where work reads as live, where a dead agent's card goes, and what finished
 * looks like. Read through the workflow, because the words are the operator's.
 */
const column = (kind: ColumnKind): string => columnFor(wf, kind)

/** The card an agent is on: its newest that is neither done nor abandoned. */
function openCard(agentId: string): { id: string; text: string; status: TaskStatus } | undefined {
  const finished = column('done')
  return board
    .tasks(agentId)
    .filter((t) => t.status !== finished)
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
  board.addTask(agentId, clean, column('start'))
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
  cardTo(testerId, failed ? column('stuck') : column('done'))
  if (failed) return
  const project = projectOf(testerId)
  const waiting = column('waiting')
  for (const t of board.tasks()) {
    if (t.status !== waiting) continue
    // Same project only: two features under test at once must not close each
    // other. With no project on either side this is every waiting card, which
    // is the honest answer on a floor that never said which project it is on.
    if (project && projectOf(t.agentId) !== project) continue
    board.setTaskStatus(t.id, column('done'))
  }
  pushTasks()
}

/**
 * What a report does to the card when no rule says.
 *
 * A floor ships with no card rules at all, so on a new one nothing moved: work
 * was handed over, done, and reported, and the board sat on `todo` forever. The
 * subject is the only thing every brief on every floor already agrees on -
 * "done: ..." when it is finished, "fail: ..." when it is not - so that is what
 * this reads. Any rule the operator writes runs first and this never sees it.
 */
function said(from: string, subject: string): void {
  if (/^\s*(done|pass|finished|shipped|ok)\b/i.test(subject)) cardTo(from, column('done'))
  else if (/^\s*(fail|bug|broke|blocked|stuck|error)\b/i.test(subject)) cardTo(from, column('stuck'))
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
  const target = assignerId()
  if (!target || !ptys.isRunning(target)) return
  reportDue = false
  reportWanted = true
  submitPrompt(
    target,
    target !== godId
      ? 'Everyone is idle now. Read $BULLPEN_MAILBOX/inbox first - developers and ' +
          'testers mail you when they finish - then $BULLPEN_FLOOR for anyone who ' +
          'sent nothing. Anything a developer reported as built and no tester has ' +
          'passed yet is not done: put a tester on it now if you have not. Then ' +
          `report to ${dispatchId()} by writing a message to "${dispatchId()}" in ` +
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
  const say = (text: string | null): void => {
    activity.push('done', id, text ? `${id} finished — ${text}` : `${id} finished a turn`)
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

/**
 * Every id spawned as a standing agent this run.
 *
 * The workflow that spawned one is not always the workflow running now: apply a
 * different shape and the old floor's analyst is still up, briefed for a chain
 * nobody is running any more. `fixed:stop` asks the current workflow who stands
 * here, so she was not on its list and stayed - visible, working, and answering
 * to a floor that no longer exists.
 */
const standing = new Set<string>()

/** The floor each running agent was briefed on, by name. */
const bornOn = new Map<string, string>()

/**
 * Where a role's fixed agent works: its own directory if the workflow gave it
 * one, else wherever dispatch works.
 *
 * One function, because the two callers were two answers: the spawn honoured
 * `- cwd:` and the "is it already in the right place" check compared against
 * dispatch's directory regardless - so a role with a directory of its own was
 * killed and restarted on every launch, having done nothing wrong.
 */
const roleHome = (role: string): string =>
  resolve(workCwd(wf, role, app.getPath('home'), currentGodCwd()))

/** Where the dispatch agent lives: whatever the operator chose, else default. */
const currentGodCwd = (): string =>
  readConfig(BULLPEN_HOME).godCwd ?? godCwd(BULLPEN_HOME, dispatchId())

/** Create the workspace, drop the briefing in it if absent, and bring him up. */
function startGod(cwd: string, size: { cols: number; rows: number }): ReturnType<PtyManager['spawn']> {
  mkdirSync(cwd, { recursive: true })
  writeBriefing(cwd, floorPath(BULLPEN_HOME), wf)
  const id = dispatchId()
  approvals.setSandbox(id, cwd)
  standing.add(id)
  return spawnAgent({ id, cwd, cmd: 'claude', args: [], role: wf.dispatch, ...size })
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
/**
 * Take off anybody the new floor has no place for.
 *
 * Switching floors used to leave the last one's standing agents running: apply
 * `solo` over `analyst-chain` and the analyst is still there, on the roster,
 * mailable, working to a brief for a role that no longer exists. The agents are
 * the floor's, so the floor decides who is on it.
 *
 * Only whoever can be judged: an agent whose role this app never recorded is
 * somebody else's business and is left alone. A hired builder keeps its place
 * as long as its role does - what goes is the role that is gone, and the fixed
 * agent that a floor has replaced with a different one.
 */
async function retire(next: Workflow): Promise<string[]> {
  const gone: string[] = []
  for (const a of ptys.list()) {
    if (a.status !== 'running') continue
    const role = roles.get(a.id) ?? roleOfFixedId(wf, a.id)
    if (!role) continue
    if (hasPlaceFor(next, { id: a.id, role, standing: standing.has(a.id) })) continue
    await stop(a.id)
    roles.delete(a.id)
    standing.delete(a.id)
    gone.push(a.id)
  }
  if (gone.length) {
    activity.push('spawn', 'bullpen', `stood down, not on "${next.name}": ${gone.join(', ')}`)
  }
  return gone
}

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
function startFixed(
  id: string,
  role: string,
  size: { cols: number; rows: number }
): ReturnType<PtyManager['spawn']> {
  const cwd = roleHome(role)
  mkdirSync(cwd, { recursive: true })
  approvals.setSandbox(id, cwd)
  standing.add(id)
  return spawnAgent({ id, cwd, cmd: 'claude', args: [], role, ...size })
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

  // Agents produce links; they open in the real browser, never in-app - and
  // only http(s). The rendered anchor calls `ui:open`, which checks the scheme,
  // but a middle-click never fires its onClick: Chromium treats it as "open in
  // a new window" and it arrived here instead, unchecked. A memory file is
  // written by an agent, and `file:` or a custom scheme would be a document
  // choosing what this machine opens.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (openable(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // Nothing in this window is ever a different page. The renderer is a local
  // file with the preload attached; letting a link navigate it would hand that
  // bridge to whatever was linked.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}

/**
 * Whether a link out of a rendered document may be handed to the desktop.
 *
 * Only http(s). A memory file, a brief and a workflow are all written by an
 * agent, so a link in one is untrusted text - and `file:` or a custom scheme is
 * that document choosing what this machine opens. One definition, because the
 * two ways a link can leave the window are two places to forget it.
 */
const openable = (url: string): boolean => /^https?:\/\//i.test(url)

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
  // Stop at the first one that lands. Without the flag all three ran whatever
  // the earlier ones found, re-reading the transcript twice more per turn per
  // agent for a reading that was already sent.
  let got = false
  for (const delay of [1200, 4000, 10_000]) {
    setTimeout(() => {
      if (!got) got = pushCtx(id)
    }, delay).unref?.()
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
    // Whatever it was on is not being worked on by anyone now. Left in `doing`
    // it reads as live work, which is the board lying about the floor - the one
    // thing it must not do if it is what the operator watches.
    if (openCard(id)) cardTo(id, column('stuck'))
    // A pty that dies mid-turn never sends the Stop hook that would have taken
    // it out of `working`, so it stayed in there for the rest of the session:
    // `reportWhenQuiet` waits for that set to empty and would never have fired
    // again, and floor.json went on calling a dead agent busy. Halting one busy
    // agent used to cost every progress report after it.
    working.delete(id)
    // Same reason: `waiting` is cleared by the Stop hook a killed pty never
    // sends, and it is what stops the same question being announced twice - a
    // stale entry would swallow the first question of whatever runs under that
    // id next.
    waiting.delete(id)
    activity.push('exit', id, `${id} exited (code ${code})`)
    send('agent:exit', id, code)
    // It may have been the last one out.
    reportWhenQuiet()
  })

  approvals.on('edit', (agentId: string, path: string) => {
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
    // One place decides what a message does to the board, and it is testable:
    // see cards.ts for why every branch in it exists.
    const move = routeCard(wf, { ...msg, to }, roleOf, wf.human)
    if (move?.kind === 'open') cardFor(move.agent, move.text, move.by)
    else if (move?.kind === 'move') cardTo(move.agent, move.status)
    else if (move?.kind === 'checked') testerReported(move.agent, move.subject)
    else said(msg.from, msg.subject)

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
  /**
   * A message addressed to a role, put in front of somebody.
   *
   * The floor says who work goes to; who is actually free to take it is a fact
   * about right now, and every brief that asked an agent to work it out - read
   * the floor file, check who is idle, check how full they are, hire if nobody
   * fits - was asking a model to do bookkeeping it does badly and silently. So
   * the app does it: reuse whoever is free under the threshold, hire when
   * nobody is, and open the card either way.
   */
  const assignTo = (role: string, from: string, msg: Message): string | null => {
    if (!wf.roles[role] || role === roleOf(from)) return null
    // Asked before anybody is chosen or hired: the chain refuses this message
    // a moment later anyway, and hiring somebody for work that will not be
    // delivered leaves an agent standing on the floor with nothing to do.
    if (from !== 'bullpen' && from !== wf.human && from !== 'webhook') {
      if (refuseMail(wf, roleOf(from), role)) return null
    }
    const staff: Candidate[] = ptys
      .list()
      .filter((a) => a.status === 'running' && a.id !== from)
      .map((a) => ({
        id: a.id,
        role: roleOf(a.id),
        idle: !working.has(a.id),
        ctxPct: currentCtx(a.id)?.pct
      }))

    // What the work is, for the board. Written here rather than left to a card
    // rule: a floor with no rules still has work being handed over, and a board
    // that shows none of it is the app lying about what the floor is doing.
    const what = [msg.subject, msg.body].filter(Boolean).join(' — ')

    const free = pickForRole(wf, role, staff)
    if (free) {
      cardFor(free, what, from)
      return free
    }
    if (wf.roles[role].hireable !== true) return null

    // Nobody free, so somebody new. The project is whoever asked for the work -
    // a hire onto a project nobody is on has no directory to work in.
    const project = projectOf(from) || slug(wf.name)
    const cwd = projectCwd(project) ?? ptys.list().find((a) => a.id === from)?.cwd
    if (!cwd) return null
    const name = nextHireName(project)
    try {
      const state = spawnAgent({
        id: nameId(name),
        cwd,
        cmd: 'claude',
        args: [],
        cols: 100,
        rows: 30,
        role,
        reportTo: from
      })
      hires.set(state.id, { name, project })
      reportDue = true
      activity.push('spawn', from, `${from} needed a ${role} and none was free - hired ${name}`)
      send('agent:hired', { ...state, name, project, role, brief: what })
      cardFor(state.id, what, from)
      return state.id
    } catch (err) {
      console.error(`[bullpen] could not hire a ${role}:`, err)
      return null
    }
  }

  hive.staff = (to: string, from: string, msg: Message): string | null => assignTo(to, from, msg)

  hive.gate = (from: string, to: string): string | null => {
    // Bullpen's own replies, the human's answers and inbound work are not part
    // of the chain; refusing them would strand the thing they answer.
    if (from === 'bullpen' || from === wf.human || from === 'webhook') return null
    if (to === 'bullpen') return null
    // A fixed agent is a process like any other and can be killed. With the
    // one who assigns gone, the floor falls back to dispatch assigning directly
    // and these rules would only leave the work with nowhere to go.
    const helper = assistId()
    if (helper && !ptys.isRunning(helper)) return null
    const party = to === wf.human ? HUMAN_PARTY : to === wf.hire ? HIRE_PARTY : roleOf(to)
    return refuseMail(wf, roleOf(from), party)
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
    // The workflow says which roles may be hired into. Anything else - a typo,
    // or a role this floor does not have - falls back to whoever builds, rather
    // than quietly producing a kind of agent nobody briefed.
    const asked = msg.role?.trim().toLowerCase() ?? ''
    const role =
      wf.roles[asked]?.hireable === true
        ? asked
        : rolesWith(wf, 'builds').find((r) => wf.roles[r].hireable) ?? wf.dispatch
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
        id: nameId(name),
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
      const entry = entryId()
      const to = named ?? (ptys.isRunning(entry) ? entry : godId)
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
        to !== godId
          ? `A task came in from ${task.from}: ${task.body}\n\n${where.trim()} `.trim() +
            'Treat it like any other request: analyse it, assign or hire, see it ' +
            `through, and report to ${dispatchId()} when it is finished.`
          : `A task came in from ${task.from}: ${task.body}\n\n` +
            `${where.trim()} ${assignRules()}`.trim()
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
      // nothing to close. Same for a card somebody has just said they are stuck
      // on: the next turn is usually them writing the message that said so.
      const held = [column('waiting'), column('stuck')]
      if (!held.includes(openCard(id)?.status ?? '')) cardTo(id, column('working'))
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
    cardTo(id, column('stuck'))
    activity.push('question', id, `${id} is waiting on you: ${asked}`)
    notify('ask', `${id} is waiting on you`, asked, { tab: 'ask me', id })
    send('agent:waiting', id, asked)
  })
  approvals.on('answered', (id: string) => {
    if (!waiting.delete(id)) return
    cardTo(id, column('working'))
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

  /**
   * Three answers, which `window.confirm` cannot give.
   *
   * Leaving a floor mid-drawing is not a yes/no: the third answer - write it
   * down first, then go - is the one somebody actually wants, and offering only
   * "lose them?" made every exit a choice between staying put and throwing work
   * away. Escape and the window close both come back as `cancel`, so the
   * accident-prone answer is never the destructive one.
   */
  ipcMain.handle('ui:unsaved', async (_e, detail: string) => {
    if (!win) return 'cancel'
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Save first', 'Leave without saving', 'Stay here'],
      defaultId: 0,
      cancelId: 2,
      message: 'This floor has changes that are not written down.',
      detail
    })
    return (['save', 'discard', 'cancel'] as const)[response] ?? 'cancel'
  })

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
  ipcMain.handle('fixed:ensure', async (_e, size: { cols: number; rows: number }) => {
    // A workflow may have none at all - `solo` is one boss and hired
    // developers. The renderer asks anyway; an empty list is the honest answer.
    const out: unknown[] = []
    for (const { role, id, name } of assistRoles()) {
      const want = roleHome(role)
      const running = ptys.list().find((a) => a.id === id && a.status === 'running')
      if (running && resolve(running.cwd) === want) {
        out.push({ ...running, name, role, alreadyUp: true })
        continue
      }
      if (running) await stop(id)
      try {
        out.push({ ...startFixed(id, role, size), name, role, alreadyUp: false })
      } catch (err) {
        // One that will not start must not stop the rest of the floor coming up.
        console.error(`[bullpen] could not start ${id}:`, err)
      }
    }
    return out
  })

  /**
   * What an agent is, when the operator made it by hand rather than hiring it.
   *
   * The wizard is the one path that creates an agent main did not brief, and
   * without this its role would be whatever the default is - which decides
   * where its cards go and who its reports finish.
   */
  ipcMain.handle('agent:setRole', (_e, id: string, role: string) => {
    if (!wf.roles[role]) return false
    roles.set(id, role)
    // The brief went out with the spawn and cannot be recalled, but what this
    // role never does is answered per hook call and can be. Left out, an agent
    // told its role after the fact kept the default role's refusals.
    approvals.setDenied(id, wf.roles[role].never ?? [])
    return true
  })

  ipcMain.handle('god:ensure', (_e, size: { cols: number; rows: number }) => {
    const id = dispatchId()
    const name = wf.roles[wf.dispatch]?.fixed?.name ?? id
    const running = ptys.list().find((a) => a.id === id && a.status === 'running')
    if (running) return { ...running, name, alreadyUp: true }
    const state = startGod(currentGodCwd(), size)
    return { ...state, name, alreadyUp: false }
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

      // Only the ones who work where dispatch works: they move with it, and
      // stopping them here rather than leaving it to `fixed:ensure` means the
      // floor is never briefly a boss in the new directory and an analyst in
      // the old one. A role with a `- cwd:` of its own is not moving anywhere,
      // and restarting it would cost a conversation for nothing.
      for (const { role, id } of assistRoles()) {
        if (!wf.roles[role]?.cwd?.trim()) await stop(id)
      }
      await stop(dispatchId())
      try {
        return { ...startGod(target, size), name: wf.roles[wf.dispatch]?.fixed?.name ?? dispatchId() }
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
      approvals.installHook(id, join(AGENTS_HOME, id))
    }
    return true
  })

  /**
   * The workflow, read and replaced.
   *
   * Applying one does not restart anybody. A CLI is handed its brief once, at
   * spawn, so an agent already running keeps the floor it was born on - which
   * is why the UI says which agents have to go down before the new shape is
   * real, rather than pretending the swap was live.
   */
  ipcMain.handle('workflow:get', () => ({
    workflow: wf,
    /** The same thing, as the text the editor puts in front of a person. */
    markdown: toMarkdown(wf),
    problems: lint(wf, rulebook()),
    /**
     * Who is running under the old shape and would have to be restarted.
     *
     * By the floor they were briefed on, not by "is running at all": since
     * switching floors stands down whoever has no role and brings up whoever
     * the new one names, most of the roster is on the current shape already,
     * and saying otherwise asked people to restart agents for nothing.
     */
    stale: ptys
      .list()
      .filter((a) => a.status === 'running')
      .filter((a) => (bornOn.get(a.id) ?? wf.name) !== wf.name)
      .map((a) => a.id)
  }))

  /**
   * Everything the operator can switch to: what ships with Bullpen, and what
   * they have saved. Presets are marked so the dialog can refuse to delete one
   * - they are starting points, and losing them would be losing the only
   * examples of the format.
   */
  ipcMain.handle('workflow:list', () => LIST())

  const LIST = (): { name: string; description: string; markdown: string; builtin: boolean }[] => [
    ...PRESETS.map((w) => ({
      name: w.name,
      description: w.description,
      markdown: toMarkdown(w),
      builtin: true
    })),
    ...listWorkflows(BULLPEN_HOME)
      // A saved workflow that took a preset's name replaces it in the list
      // rather than sitting beside it under the same label.
      .filter((s) => !PRESETS.some((p) => p.name === s.name))
      .map((s) => ({ ...s, builtin: false }))
  ]

  /**
   * Take the standing agents down so they can come back on the new shape.
   *
   * A brief is handed to a CLI once, at spawn, so applying a workflow leaves
   * everyone already running on the floor they were born on - the router
   * enforcing one chain while the agents believe another. Restarting is the
   * only way to move them, and it costs their conversations, so it is a
   * separate act the operator asks for rather than something apply does.
   *
   * Only the standing agents: a hired developer's context is its work, and this
   * is not the place to decide that work is finished.
   */
  ipcMain.handle('fixed:stop', async () => {
    // Whoever stands here now, and whoever was ever stood up this run: after a
    // switch those are different sets, and the difference is exactly the agents
    // left running on a shape that no longer exists.
    const ids = [...new Set([dispatchId(), ...assistRoles().map((a) => a.id), ...standing])]
    const was = ids.filter((id) => ptys.isRunning(id))
    for (const id of was) await stop(id)
    return was.filter((id) => !ptys.isRunning(id))
  })

  /** The annotated empty floor, for somebody writing their first one. */
  /** The two-party floor a new chart is drawn on top of. */
  ipcMain.handle('workflow:blank', () => NEW_FLOOR)

  /**
   * The format reference, and where to put your own.
   *
   * Through main rather than bundled into the renderer as well: the document in
   * force is whichever file main just read, and a second copy compiled into the
   * dialog would go on showing the shipped one after it was replaced.
   */
  /**
   * Walk a task through a floor without running it.
   *
   * Takes the markdown rather than reading the running workflow, so the editor
   * can try what is on screen - which is the whole point: you check a floor
   * before you switch to it, not after the agents are up.
   */
  ipcMain.handle('workflow:dryRun', (_e, markdown: string, task: string) => {
    const parsed = parseMarkdown(markdown)
    if ('error' in parsed) return { error: parsed.error }
    return dryRun(parsed.workflow, task)
  })

  /**
   * Change part of the running workflow, without retyping the file.
   *
   * The board's colours and the two context thresholds are settings people
   * reach for one at a time, and markdown is the wrong surface for "make that
   * column blue". The floor is still one document - this edits it and hands
   * back the text, so what the editor shows next is what is running.
   */
  /**
   * The floor as a file, without saving it.
   *
   * Drawing is not reading: somebody moves four boxes and two lines and cannot
   * tell what they have written until it is running. This renders the drawing
   * in front of them - the same text `workflow:patch` would write - so the file
   * can be read before it is the floor.
   */
  /**
   * A patch, with the two numbers in it made usable again.
   *
   * They come from number inputs, and a cleared input is `NaN` - which is a
   * threshold nothing can ever be under.
   */
  const patched = (patch: Partial<Workflow>): Workflow => ({
    ...wf,
    ...patch,
    reuseBelowPct: pctOr(patch.reuseBelowPct ?? wf.reuseBelowPct, wf.reuseBelowPct),
    hireAbovePct: pctOr(patch.hireAbovePct ?? wf.hireAbovePct, wf.hireAbovePct)
  })

  ipcMain.handle('workflow:preview', (_e, patch: Partial<Workflow>) => {
    const next = patched(patch)
    return { markdown: toMarkdown(next), problems: lint(next, rulebook()) }
  })

  /**
   * Write a floor to disk without making it the one that runs.
   *
   * `workflow:patch` and `workflow:set` both save *and* apply, so there was no
   * way to put a floor down and come back to it - opening another one to look
   * at it retired agents and changed every screen in the app. Saving is saving;
   * running is `workflow:set`, which the operator asks for by name.
   */
  /**
   * The rules the drawing says, for a floor that is being drawn.
   *
   * Computed in main rather than in the renderer because this is the same
   * reading of a floor the router does - who hands work out, who does it, who
   * decides it passed - and a second copy of that in the drawing is a second
   * copy that goes out of step.
   */
  ipcMain.handle('workflow:rules', (_e, patch: Partial<Workflow>) => {
    try {
      return { rules: drawnCardRules(withWork(patched({ ...patch, cardRules: [] }))) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** Whether the floor Bullpen ships refuses to be saved over. */
  const SHIPPED_IS_READ_ONLY = false

  /**
   * Write the floor to disk - unless it breaks a law.
   *
   * A law is what the rules file says every floor must be, and there is no
   * reading of "must" where the file is written anyway and the breach reported
   * underneath it. Half-drawn is fine and stays fine: nothing here is refused
   * for being unfinished, only for being against a rule somebody wrote down.
   */
  ipcMain.handle('workflow:save', (_e, text: string) => {
    const parsed = parseMarkdown(text)
    if ('error' in parsed) return { error: parsed.error }
    // A shipped floor is in the source, not on disk. Saving one wrote a file
    // beside it under the same name - and the list drops a saved floor that
    // takes a shipped one's name, so the edit went to disk, vanished from the
    // list, and the floor it was made on carried on unchanged.
    //
    // Off while the redraft is being tried on the shipped floor itself: it is
    // the only floor there is, and testing "write it" on anything else means
    // drawing one first. Set it back to true.
    if (SHIPPED_IS_READ_ONLY && PRESETS.some((p) => p.name === parsed.workflow.name)) {
      return {
        error: `"${parsed.workflow.name}" is the floor Bullpen ships and is not yours to write over. Give it another name in the file and it is yours to keep.`
      }
    }
    const problems = lint(parsed.workflow, rulebook())
    if (problems.length) return { error: problems[0], problems }
    try {
      saveWorkflow(BULLPEN_HOME, text)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    return {
      workflow: parsed.workflow,
      markdown: toMarkdown(parsed.workflow),
      problems: []
    }
  })

  ipcMain.handle('workflow:patch', async (_e, patch: Partial<Workflow>) => {
    const next = patched(patch)
    // Before `wf` moves, while the old floor can still say who was who.
    const retired = await retire(next)
    // Noted, not refused. A floor half-drawn is a floor mid-thought: somebody
    // adds a role before the line that reaches it, or a line before the rule
    // that uses it, and refusing to save until every check passes means the
    // work in front of them cannot be put down. The problems come back with the
    // save so they can be shown, and the floor is what they drew.
    const problems = lint(next, rulebook())
    wf = next
    const markdown = toMarkdown(wf)
    writeConfig(BULLPEN_HOME, { ...readConfig(BULLPEN_HOME), workflow: wf })
    try {
      saveWorkflow(BULLPEN_HOME, markdown)
    } catch (err) {
      console.error('[bullpen] could not save the patched workflow:', err)
    }
    hive.reserved = { human: wf.human, hire: wf.hire }
    return { workflow: wf, markdown, problems, retired }
  })

  /**
   * Write a workflow from a sentence about how the floor should work.
   *
   * Through the same `claude` CLI every agent on this floor runs, rather than an
   * SDK and a second API key: it is already the one dependency Bullpen cannot
   * work without, and it is already signed in as whoever is running the app.
   *
   * The result is linted here, and one repair round is offered with the
   * problems handed back - a workflow that does not lint is one the operator has
   * to fix by hand, which is most of the work they were trying to skip.
   */
  /** What is wrong with a candidate, as the generator will be told it. */
  const check = (md: string): string[] => {
    const parsed = parseMarkdown(md)
    // Every law, not the operator's rulebook. The laws are switched off because
    // a person drawing a floor is allowed to leave it half-finished; a model
    // asked for a whole floor is not, and with the rulebook here it was handing
    // back floors whose roles never wrote to each other and whose board never
    // moved - which passed, because nothing was switched on to catch it.
    return 'error' in parsed ? [parsed.error] : lint(parsed.workflow)
  }

  /**
   * What a written floor has to be true of, whatever the model wrote.
   *
   * Rules a model can forget are not rules. Three of them are worth more than
   * the prompt line asking for them:
   *
   * The front desk is Michael. The model picks a plausible id and a plausible
   * name every time - `chief · Michael` on one floor, `lead · Dana` on the next
   * - and the desk work is dispatched to is the same desk on all of them: the
   * same agent, the same face on the roster, the same id every brief already
   * writes to.
   *
   * `- reports to you:` and `- hires:` name a role or they are nothing. A floor
   * came back naming `boss` for both on a floor whose roles are `manager`,
   * `ba`, `dev` and `tester`; both were read, both were dropped, and nothing
   * anywhere said so.
   *
   * A capability with no kind in brackets leaves whoever holds it classified as
   * whatever the other three questions did not claim - which is "builds". A
   * floor whose analyst said `- phan-tich-yeu-cau — turns a request into
   * requirements` came out with the analyst counted as a builder: no tag on the
   * roster, and the default hire for build work.
   */
  const tidy = (markdown: string): string => {
    const parsed = parseMarkdown(markdown)
    if ('error' in parsed) return markdown
    const w = parsed.workflow
    const seat = w.roles[w.dispatch]
    if (!seat) return markdown
    const named = (r: string | undefined): boolean => Boolean(r && w.roles[r])
    return toMarkdown({
      ...w,
      roles: { ...w.roles, [w.dispatch]: { ...seat, fixed: { id: 'michael', name: 'Michael' } } },
      voice: named(w.voice) ? w.voice : undefined,
      hires: named(w.hires) ? w.hires : undefined
    })
  }

  const ask = (prompt: string): Promise<string> =>
    new Promise((done, fail) => {
      // No shell, argv only: the description is the operator's own text and
      // must never reach a command line as anything but one argument.
      const child = execFile(
        'claude',
        ['-p', prompt],
        // Measured, not guessed: a real generation of a four-role floor took
        // over two minutes, and the repair round is a second turn on top.
        { cwd: currentGodCwd(), maxBuffer: 4_000_000, timeout: 420_000 },
        (err, stdout) => (err && !stdout.trim() ? fail(err) : done(stdout))
      )
      child.stdin?.end()
    })

  const clean = (out: string): string =>
    out
      .trim()
      // A fenced answer is still the right answer; unwrap rather than refuse.
      .replace(/^```(?:markdown|md)?\n?/, '')
      .replace(/\n?```$/, '')
      .trim()

  /**
   * One role's brief, written from a sentence about what it is for.
   *
   * The whole-floor generator writes every brief at once, which is the wrong
   * shape for a role added to a floor that already exists: it would rewrite the
   * three that were already right to add a fourth. This asks for one, and is
   * given the floor it is joining so the brief names the people actually there.
   */
  ipcMain.handle('role:brief', async (_e, floor: Workflow, role: string, said: string) => {
    const want = said.trim()
    if (!want) return { error: 'Say what this role is for first.' }
    const def = floor?.roles?.[role]
    if (!def) return { error: `No role called "${role}" on this floor.` }
    try {
      const out = clean(
        await ask(
          `You are writing one role's brief for a Bullpen floor. A brief is addressed to the ` +
            `agent that will do the job - second person, plain sentences, no headings and no ` +
            `markdown fences.\n\n` +
            `This is the floor as it stands, in the format Bullpen reads:\n\n${toMarkdown(floor)}\n\n` +
            `Write the brief for "${role}" (shown as "${def.label}"), whose job is:\n\n${want}\n\n` +
            `Say what they are for, what they must not do, what they send when a task is ` +
            `finished, and who they send it to - use the ids this floor already uses, and the ` +
            `same {{...}} placeholders the other briefs use. The first sentence is what the ` +
            `floor shows everywhere else, so make it stand on its own. Answer with the brief ` +
            `and nothing else.`
        )
      )
      return out ? { brief: out } : { error: 'The model answered with nothing.' }
    } catch (err) {
      return {
        error: `Could not reach the claude CLI: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  })

  /**
   * The whole file, written again to match the drawing.
   *
   * The drawing is the shape - who is on the floor, who may write to whom, who
   * takes what is typed at it. Everything else in the file is prose about that
   * shape, and prose does not follow a line being moved: a role dragged from
   * under the boss to under an analyst keeps a brief telling it to report to
   * the boss, and the floor runs with the two disagreeing.
   *
   * So the shape is not the model's to change. What comes back is taken for its
   * words - labels, `does`, briefs, card rules, the summary - and the roles,
   * the lines and the two seats are put back exactly as drawn.
   */
  ipcMain.handle('workflow:redraft', async (_e, floor: Workflow) => {
    if (!floor?.roles) return { error: 'No floor to write.' }
    const drawn = toMarkdown(floor)
    const say = (extra = ''): string =>
      `This is a Bullpen floor. The drawing is settled and is not yours to change: the roles, ` +
      `their ids, who each may write to, which one is dispatch and which is entry all stay ` +
      `exactly as they are here.\n\n${drawn}\n\n` +
      `Write the whole file again so that everything else agrees with that drawing:\n` +
      `- every role's "- does:" line, in one sentence\n` +
      `- every brief, addressed to the agent, naming only the roles that role may write to, and ` +
      `saying what it reports and to whom\n` +
      `- a "## how it works" section of three to five sentences for whoever opens this floor next\n` +
      `Leave "## card rules" exactly as it is - what a message does to a card is worked out from ` +
      `the drawing here, and anything you write there is thrown away.\n` +
      `Answer with the whole file in Bullpen's format and nothing else - no fences, no preamble.` +
      extra

    /** The words are the model's; the shape is the drawing's. */
    const keep = (md: string): { markdown: string; problems: string[] } | { error: string } => {
      const parsed = parseMarkdown(md)
      if ('error' in parsed) return { error: parsed.error }
      const w = parsed.workflow
      const filled = withWork(floor).roles
      const roles = Object.fromEntries(
        Object.entries(filled).map(([id, was]) => {
          const now = w.roles[id]
          return [
            id,
            now
              ? { ...was, label: now.label || was.label, does: now.does ?? was.does, brief: now.brief || was.brief }
              : was
          ]
        })
      )
      const next: Workflow = {
        ...floor,
        description: w.description || floor.description,
        summary: w.summary ?? floor.summary,
        roles,
        columns: floor.columns,
        // Worked out, not asked for. What a message does to a card follows from
        // the drawing - who hands work out, who does it, who decides it passed -
        // and a model asked to write those lines wrote a floor where handing
        // work over moved the sender's own card, a worker reporting finished
        // put its card back into `doing`, and the first task typed at the floor
        // opened nothing at all. None of that is visible in the file; it is
        // visible three days later as a board that does not move.
        cardRules: drawnCardRules(withWork({ ...floor, cardRules: [] }))
      }
      return { markdown: toMarkdown(next), problems: lint(next) }
    }

    try {
      let out = keep(clean(await ask(say())))
      if ('error' in out) return out
      if (out.problems.length) {
        const again = keep(
          clean(
            await ask(
              say(
                `\n\nYou wrote this and it was rejected:\n\n${out.markdown}\n\n` +
                  `Fix exactly these and answer with the whole file again:\n` +
                  out.problems.map((p) => `- ${p}`).join('\n')
              )
            )
          )
        )
        if (!('error' in again)) out = again
      }
      return out
    } catch (err) {
      return {
        error: `Could not reach the claude CLI: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  })

  ipcMain.handle('workflow:generate', async (_e, description: string) => {
    const want = description.trim()
    if (!want) return { error: 'Say what the floor should do first.' }

    try {
      const brief = generatorPrompt()
      let md = clean(await ask(`${brief}\n\nWrite the workflow for this floor:\n\n${want}`))
      let problems = check(md)
      if (problems.length) {
        md = clean(
          await ask(
            `${brief}\n\nWrite the workflow for this floor:\n\n${want}\n\n` +
              `You wrote this, and it was rejected:\n\n${md}\n\n` +
              `Fix exactly these and answer with the whole file again:\n${problems.map((p) => `- ${p}`).join('\n')}`
          )
        )
        problems = check(md)
      }
      return { markdown: tidy(md), problems }
    } catch (err) {
      return { error: `Could not reach the claude CLI: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  /**
   * A saved floor, off the disk. Only ever a saved one.
   *
   * Bullpen shipped six floors once, then two, and a way to take the ones you
   * did not want off the list - which was a note in the config, a button to
   * undo it, and a delete that meant two different things depending on the row
   * it was on. It ships one floor now, and one floor is not a list to curate.
   */
  ipcMain.handle('workflow:delete', (_e, name: string) => {
    try {
      deleteWorkflow(BULLPEN_HOME, name)
      return { ok: true }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Read the editor's text without applying it: what is wrong with it, and what
   * it would be if applied.
   *
   * The preview comes from the same parse the router would do, not from a
   * second reading of the text in the renderer - a preview that agrees with the
   * editor but not with main is worse than no preview.
   */
  ipcMain.handle('workflow:lint', (_e, text: string) => {
    const parsed = parseMarkdown(text)
    if ('error' in parsed) return { problems: [parsed.error], preview: null }
    return { problems: lint(parsed.workflow, rulebook()), preview: parsed.workflow }
  })

  ipcMain.handle('workflow:set', async (_e, text: string) => {
    const parsed = parseMarkdown(text)
    if ('error' in parsed) return { error: parsed.error }
    const problems = lint(parsed.workflow, rulebook())
    // Refused rather than warned about: every one of these fails silently at
    // runtime - a card that never moves, a report that never reaches anyone -
    // and a floor that looks busy and finishes nothing is the worst outcome
    // this whole file exists to avoid.
    if (problems.length) return { error: problems.join('\n') }
    const retired = await retire(parsed.workflow)
    wf = parsed.workflow
    hive.reserved = { human: wf.human, hire: wf.hire }
    writeConfig(BULLPEN_HOME, { ...readConfig(BULLPEN_HOME), workflow: wf })
    // Applied is also saved: switching away and back should not mean retyping
    // the floor you were just running.
    try {
      saveWorkflow(BULLPEN_HOME, text)
    } catch (err) {
      console.error('[bullpen] could not save the applied workflow:', err)
    }
    godId = fixedId(wf, wf.dispatch)
    // Roles learned under the old workflow name things this one may not have.
    for (const [id, role] of [...roles]) if (!wf.roles[role]) roles.delete(id)
    // What a role never does was read once, at spawn. An agent that survives
    // the switch kept the old floor's answer: a workflow that takes a tool away
    // from a role did not take it away from anyone already running under it,
    // and one that hands a tool back left them still refused. Re-stated from the
    // workflow now in force, for everyone still on the floor.
    for (const a of ptys.list()) {
      if (a.status !== 'running') continue
      approvals.setDenied(a.id, wf.roles[roleOf(a.id)]?.never ?? [])
    }
    activity.push('spawn', 'bullpen', `workflow set to "${wf.name}"`)
    return { workflow: wf, markdown: toMarkdown(wf), retired }
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
    return publishFloor(BULLPEN_HOME, agents, Date.now(), dispatchId())
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
  ipcMain.handle('agent:kill', (_e, id: string) => {
    // Halt takes the queue with it: those notes were waiting for a tool call
    // this agent is not going to make. Same for anything it was blocked on -
    // left pending it stays in the approvals list, and the roster keeps the
    // agent marked blocked, for a process that is already gone.
    approvals.clearSteers(id)
    approvals.clearPending(id)
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
    // Under whatever this floor calls the human: the gate and the card rules
    // both match on it, and an answer that arrived from an address nothing
    // recognises is an answer the router treats as another agent's.
    hive.send({ from: wf.human, to: q.from, subject: `re: ${q.subject}`, body: answer })
    activity.push('answer', HUMAN, `you answered ${q.from}: ${q.subject}`)
    send('ask:pending', [...questions.values()])
    return true
  })
  ipcMain.handle('ask:dismiss', (_e, qid: string) => {
    questions.delete(qid)
    send('ask:pending', [...questions.values()])
    return true
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
    const helper = assistId()
    const rules = helper && ptys.isRunning(helper) ? relayRules() : assignRules()
    const who = owner && owner !== 'decide' ? ` I suggest ${owner} takes it.` : ''
    const brief = `Dispatch: ${task} —${where}${who} ${rules}`
    submitPrompt(target, brief)
    // The operator's own request is work too, and what it does to the board is
    // a rule like any other: `you → boss: opens a card`. It used to be written
    // here instead, which made the one hand-off nobody could change the one the
    // operator makes most.
    const handed = routeCard(wf, { from: HUMAN, to: target, subject: '', body: task }, roleOf, wf.human)
    if (handed?.kind === 'open') cardFor(handed.agent, handed.text, handed.by)
    else if (handed?.kind === 'move') cardTo(handed.agent, handed.status)
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
  ipcMain.handle('board:tasks', (_e, id?: string) => board.tasks(id))
  ipcMain.handle('board:addTask', (_e, id: string, text: string) => {
    const t = board.addTask(id, text)
    pushTasks()
    return t
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
  ipcMain.handle('ui:open', (_e, url: string) => {
    if (!openable(url)) return false
    shell.openExternal(url)
    return true
  })
  /**
   * How the app is drawn on this machine: terminal size, floor colours.
   *
   * Clamped rather than trusted - a font size of 0 is a terminal nobody can
   * read and no way back to this dialog to fix it.
   */
  ipcMain.handle('ui:prefs', () => ({
    fontSize: readConfig(BULLPEN_HOME).ui?.fontSize ?? 12.5,
    floor: readConfig(BULLPEN_HOME).ui?.floor ?? 'green',
    chart: readConfig(BULLPEN_HOME).ui?.chart ?? {},
    view: readConfig(BULLPEN_HOME).ui?.view ?? {}
  }))
  ipcMain.handle(
    'ui:setPrefs',
    (
      _e,
      next: {
        fontSize?: number
        floor?: string
        chart?: Record<string, Record<string, { x: number; y: number }>>
        view?: Record<string, { k: number; tx: number; ty: number }>
      }
    ) => {
      const cfg = readConfig(BULLPEN_HOME)
      const ui = mergeUi(cfg.ui, next)
      writeConfig(BULLPEN_HOME, { ...cfg, ui })
      return ui
    }
  )

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

  ipcMain.handle('approvals:decide', (_e, id: string, d: 'allow' | 'deny') => approvals.decide(id, d))

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

  // The floor's shape, before anything spawns into it: a brief is handed to an
  // agent once and never again, so reading this after the first spawn would
  // leave the boss briefed for a workflow nobody else is on. A saved workflow
  // that no longer parses or no longer lints is not applied - the default chain
  // is a working floor, and a half-applied one is not.
  const saved = readConfig(BULLPEN_HOME).workflow
  if (saved) {
    const parsed = parseWorkflow(saved)
    if ('error' in parsed) {
      console.error(`[bullpen] saved workflow ignored: ${parsed.error}`)
    } else {
      const problems = lint(parsed.workflow, rulebook())
      if (problems.length) {
        console.error(`[bullpen] saved workflow ignored:\n${problems.join('\n')}`)
      } else {
        wf = parsed.workflow
      }
    }
  }
  godId = fixedId(wf, wf.dispatch)
  // What the human and hiring are called here. Routed on, so a floor that
  // addresses its operator as "boss" has mail to "boss" reach the ask-me queue
  // rather than the dead letters.
  hive.reserved = { human: wf.human, hire: wf.hire }

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
