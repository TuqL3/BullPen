import { CLIENT_ID, awaitToken, deviceCode, type DeviceCode } from './github.ts'
import { hostname } from 'node:os'
import { createGist, findGist, readGist, whoAmI, writeGist } from './gist.ts'
import { readToken, tokenOnDisk, writeToken } from './secret.ts'
import { adopt, bundle, newer, readFloors, type Bundle } from './sync.ts'
import { app, BrowserWindow, dialog, ipcMain, Notification, screen, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
import { Board, boardPath, type Task, type TaskStatus } from './board.ts'
import { Asks, asksPath, REPORTING, type Ask } from './asks.ts'
import { engineArgs, engineFor } from '../engines.ts'
import { bannerModel, configuredModel } from './climodel.ts'
import { newToken, Webhooks } from './webhook.ts'
import { plistValue, Updates, type UpdateState } from './update.ts'
import { newMeter, update as updateCost, type Cost, type Meter } from './cost.ts'
import { lastAssistantText, loginShellPath, mergePath, readCtx, type Ctx } from './ctx.ts'
import {
  floorPath,
  publishTasks,
  tasksPath,
  godCwd,
  publishFloor,
  writeBriefing,
  dropBrief,
  type FloorAgent
} from './god.ts'
import { execFile, execFileSync } from 'node:child_process'
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
  isBoard,
  hasColumn,
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
  trimmed,
  withoutCardRules,
  withWork,
  type Candidate,
  type ColumnKind,
  type Workflow,
  workCwd
} from './workflow.ts'
import { BOARD_PARTY, generatorBrief } from '../workflow-spec.ts'
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

/**
 * Questions agents have addressed to the human, and what was said back.
 *
 * On disk rather than in a `Map`: answering used to delete the entry, so the
 * question and the answer both went the moment they were dealt with, and what
 * had already been decided was unknowable an hour later.
 */
const asks = new Asks(asksPath(BULLPEN_HOME))
let questionSeq = Date.now()


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
 * Folders macOS has asked this app to open, and nobody has taken yet.
 *
 * "Open With - Bullpen" on a folder is a directory looking for an agent, which
 * is the one thing every agent has to be given. The plist entry that puts
 * Bullpen in that menu is in electron-builder.config.mjs.
 *
 * One queue and one way out of it, because the two ways a folder arrives are
 * not the same. On a cold launch macOS delivers the path before there is a
 * window, let alone a renderer with a listener attached; while the app is
 * running it arrives at any moment. So main only ever *nudges* - the renderer
 * pulls with `open:pending`, and pulling is what empties the queue.
 *
 * Pushing the path and queueing it as well was the first version, and it opened
 * the same folder twice: once on the push, and again the next time anything
 * reloaded the window and drained a queue that still held it.
 */
let openQueue: string[] = []

/**
 * Registered at module scope, not inside `whenReady`: the event that carries
 * the folder a cold launch was started for fires before the app is ready, and a
 * listener added afterwards never hears it.
 *
 * Files are dropped rather than guessed at. Only `public.folder` is declared,
 * so a file here means somebody dragged one onto the dock icon, and a directory
 * is the only thing the floor knows what to do with.
 */
app.on('open-file', (event, path) => {
  event.preventDefault()
  try {
    if (!statSync(path).isDirectory()) return
  } catch {
    return
  }
  openQueue.push(path)
  // A nudge, not the path: whoever is listening comes and takes the queue.
  send('open:waiting')
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

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
  const cmd = said[0] ?? spec.cmd ?? 'claude'
  const cliArgs = said.slice(1)

  // What Bullpen may add, and what it may not. `--append-system-prompt` and
  // `--settings` are claude's own flags: appended to every spawn regardless,
  // they were what stopped a floor from running `codex` at all - the CLI was
  // handed two arguments it did not know and refused to start.
  const engine = engineFor(cmd)
  // So the brief goes where that CLI already looks: a real file in its own
  // workspace, which is also the only form of it anybody can read or correct.
  // claude gets one too - the flag is what it acts on, the file is what a
  // person opens when they want to know what this agent was told.
  dropBrief(spec.cwd, engine.briefFile, wf.roles[role]?.fixed?.name ?? spec.id, brief)

  const state = ptys.spawn({
    ...spec,
    cmd,
    args: [...cliArgs, ...(spec.args ?? []), ...engineArgs(engine, brief, settingsPath)],
    env: {
      ...spec.env,
      BULLPEN_AGENT_ID: spec.id,
      BULLPEN_MAILBOX: hive.agentDir(spec.id),
      BULLPEN_FLOOR: floorPath(BULLPEN_HOME),
      BULLPEN_TASKS: tasksPath(BULLPEN_HOME)
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
  const said: string[] = []

  // Only worth saying to somebody who has anybody to hand to.
  if (down.length) {
    const list = down.map((r) => `"${r}"`).join(', ')
    said.push(
      [
        `Handing work over: address the message to the role, not to a person - ${list}.`,
        `Bullpen puts it in front of whoever is free, hires somebody when nobody is,`,
        `and puts the task on the board under their name. You do not have to know who`,
        `is on the floor or how full their context is.`,
        ``,
        `{"from": "${id}", "to": "${down[0]}", "subject": "<the task in a few words>", "body": "<what is needed>"}`
      ].join('\n')
    )
  }

  /**
   * The two words, said to everybody.
   *
   * These used to sit under the guard above, which is about handing work *out*
   * - so a role that writes to nobody but the human was never told them. That
   * is the one role whose report is the last thing that happens to a task: it
   * reported in whatever words it chose, the board read "fail: ..." as work
   * delivered, and the card closed green on the one hand-off the operator
   * actually reads.
   *
   * English on purpose, in a brief that may be in any language: they are
   * matched as text the way a column key is, and `stuckInstead` in `cards.ts`
   * is what reads them. The sentence around them is the floor's; the two words
   * are not.
   */
  said.push(
    [
      `Start a report with "done: " when a task is finished and "fail: " when it is`,
      `not - those two words exactly, whatever language the rest of your report is`,
      `in. That is what moves the card off the board.`
    ].join('\n')
  )

  /**
   * The board, said to everybody, because everybody is on it.
   *
   * Read from a file and changed by message, which is the same split the floor
   * roster already uses and for a harder reason: two agents reading one list at
   * the same moment both see a card free, and only one of them may come away
   * with it. Main is the only writer, so a claim is a request.
   */
  said.push(
    [
      `The task list is $BULLPEN_TASKS - every card on this floor, who holds it, and`,
      `where it stands. Read it; do not write to it. Work handed to you arrives with`,
      `a "task" id, and quoting that id back on your report is what closes that card`,
      `rather than whichever of yours is newest:`,
      ``,
      `{"from": "${id}", "to": "<whoever gave it to you>", "subject": "done: <the task>", "body": "<what you did>", "task": "<the id you were given>"}`,
      ``,
      `To change the list itself, write to "board":`,
      `  claim   - take a card nobody holds:  {"to": "board", "subject": "claim", "task": "<id>"}`,
      `  done    - mark yours finished:       {"to": "board", "subject": "done", "task": "<id>"}`,
      `  blocked - mark yours stuck, say why: {"to": "board", "subject": "blocked", "task": "<id>", "body": "<why>"}`,
      ...(down.length
        ? [
            `  post    - put work up for a role, for whoever is free to take:`,
            `            {"to": "board", "subject": "post", "role": "${down[0]}", "body": "<the task>"}`
          ]
        : []),
      ``,
      `The board is where work stands, not what was said about it. Anything that`,
      `needs an answer is still a message to a person.`
    ].join('\n')
  )

  return said.join('\n\n')
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

/**
 * Agents seen working, and when that turn started.
 *
 * A set once, which was enough to tell a Stop hook that mattered from one that
 * did not. What it could not say is how long somebody has been in there, and
 * that is the difference between an agent doing a long piece of work and one
 * that is never coming back: a turn that never ends sends no Stop hook, so the
 * id stays in here for the rest of the run. `reportWhenQuiet` waits for this to
 * empty, so one agent hung mid-turn silently ends every progress report after
 * it - the same failure a killed pty used to cause, and that one is guarded on
 * the way out of `exit`. This is the case where nothing exits.
 */
const working = new Map<string, number>()

/** Who is working and has not been in there long enough to be presumed hung. */
const busy = (): string[] => {
  const now = Date.now()
  return [...working].filter(([, since]) => now - since < HUNG_MS).map(([id]) => id)
}

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
/**
 * Every report, newest first.
 *
 * One was kept, and the monitor showed that one - so the round before this one
 * left no trace anywhere except a line in the activity log saying a report had
 * happened, without what it said. A floor that reports three times an hour is a
 * floor whose history was being thrown away as fast as it was written.
 *
 * In memory and capped: this is the record of a session, not an archive, and
 * fifty is more than anybody scrolls back through.
 */
const reports: (Message & { ts: number })[] = []
const REPORTS_KEPT = 50

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
  // And to the floor itself. The renderer's copy is a panel; this one is what
  // an agent reads when it wants to know what else is going on, and it is the
  // only view of the work that exists outside main.
  publishTasks(BULLPEN_HOME, {
    updated: Date.now(),
    columns: wf.columns.map((c) => c.key),
    tasks: board.tasks().map((t) => ({
      id: t.id,
      text: t.text,
      status: t.status,
      agent: t.agentId,
      ...(t.role ? { role: t.role } : {}),
      ...(t.by ? { by: t.by } : {}),
      ...(t.checks ? { checks: t.checks } : {}),
      createdAt: t.createdAt
    }))
  })
}

/**
 * Take everything left under an id off the floor, and say so.
 *
 * Called at both ends of a name's life: when somebody is hired under it, and
 * when whoever held it is taken off the roster. A name is only claimed while
 * its agent is running, so the two are the same event seen twice - the id that
 * a fired developer left behind is the id the next hire on the next project is
 * given, and none of this was about either of them: not the cards, not the
 * schedules, not the context rule, and not the mail still sitting in the inbox
 * its own brief tells it to go and read.
 */
function forgetAgent(id: string): void {
  /**
   * The builds this one was checking, before its cards go with it.
   *
   * `checks` points one way: a check names the build, and the build names
   * nobody. So taking a checker off the roster deleted the only record that
   * anything was being checked, and left the build sitting in the waiting
   * column with nobody looking at it and nothing that would ever move it -
   * work that reads as in progress forever, which is the one thing the board
   * must not say.
   *
   * Put back as stuck rather than finished or re-queued: nobody checked it, and
   * saying so is the honest answer. Whoever picks it up decides the rest.
   */
  for (const card of board.tasks(id)) {
    const built = card.checks ? board.task(card.checks) : undefined
    if (!built || built.status === column('done')) continue
    board.setTaskStatus(built.id, column('stuck'))
    activity.push('task', 'bullpen', `${id} was checking "${built.text.slice(0, 60)}" - nobody is now`)
  }
  const cards = board.forget(id)
  if (cards) {
    pushTasks()
    pushTriggers()
    pushRules()
  }
  const mail = hive.forget(id)
  if (cards || mail) {
    activity.push('task', 'bullpen', `${id}: ${cards} card(s) and ${mail} message(s) cleared`)
  }
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
 * Whether a newer version has been published.
 *
 * Inert until `attach` is called, which only happens in a packaged app - see
 * `whenReady`. `electron-updater` is a CommonJS module that loads Electron on
 * import, so it is imported there and not here: this file is also loaded by
 * tests, which have no Electron for it to find.
 */
const updates = new Updates(app.getVersion())

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
  'stopped agent cannot be given anything, and neither can one mid-turn: ' +
  'a second task handed to a working agent lands as an interruption, and the ' +
  'task it is already on is what pays for it. Never wait for one to finish ' +
  'either - hire instead. ' +
  `Of those, take one whose ctxPct is under ${wf.reuseBelowPct}; at or over ` +
  `that, treat them as not free even when idle, because what is left of ` +
  'their window is not enough to work in and everything they still carry is ' +
  'charged again every turn. Missing ctxPct means a fresh agent, not a full ' +
  'one. ' +
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
function openCard(agentId: string): Task | undefined {
  const finished = column('done')
  return board
    .tasks(agentId)
    .filter((t) => t.status !== finished)
    .at(-1)
}

/**
 * How long an agent may sit idle holding live work before it is chased.
 *
 * From the environment so it can be turned down to something a test can wait
 * for, and up by anybody whose floor does work in longer strides than this.
 *
 * Floored well above one sweep of the router, and that is not tidiness: a
 * report is written to the outbox during the turn and moves the card only once
 * the router has picked it up, which is up to 500ms after the Stop hook says
 * the turn ended. Anything shorter chases every agent that did report, on the
 * strength of having looked a fraction of a second too early.
 */
const STALL_MS = Math.max(Number(process.env.BULLPEN_STALL_MS) || 5 * 60_000, 2_000)

/** Cards already chased once, by card id: a second silence is not a third ask. */
const chased = new Set<string>()

/**
 * How long a turn may run before it is presumed hung rather than thorough.
 *
 * Long on purpose. A real turn can read a codebase, and writing off work that
 * was merely slow is worse than a late report - so nothing here stops, kills or
 * interrupts anything. It says so on the board, tells Michael, and stops one
 * stuck turn from muting the floor.
 *
 * Never below twice the stall window: an agent chased for a report takes a turn
 * to answer, and a ceiling under that would call that answer a hang.
 */
const HUNG_MS = Math.max(Number(process.env.BULLPEN_HUNG_MS) || 30 * 60_000, STALL_MS * 2)

/** Turns already given up on, so the floor is told once rather than every tick. */
const hung = new Set<string>()

/**
 * Posted cards already given back, by card id.
 *
 * Its own set rather than sharing `hung`, which holds agent ids. A uuid cannot
 * collide with a slug so nothing was broken, but one set answering two
 * questions is a set whose `delete` is right for one caller and silently wrong
 * for the other - `hung` is cleared when an agent's turn ends, and a card has
 * no turn to end.
 */
const dropped = new Set<string>()

/**
 * A turn that has run past `HUNG_MS`.
 *
 * Nothing is killed. The agent may still come back, and if it does its Stop
 * hook clears it from both sets and the floor carries on - what this undoes is
 * only the silence: a card that reads as live work when nobody is doing it, and
 * a progress report that can never fire again while this id sits in `working`.
 */
function sweepHung(): void {
  const now = Date.now()

  for (const [id, since] of working) {
    if (now - since < HUNG_MS || hung.has(id)) continue
    if (!ptys.isRunning(id)) continue
    hung.add(id)
    const card = openCard(id)
    const mins = Math.round((now - since) / 60_000)
    if (card && card.status !== column('stuck')) cardTo(id, column('stuck'))
    activity.push('dead', id, `${id} has been mid-turn for ${mins}m with no end to it`)
    // Said to the human as well, because the one agent this cannot be reported
    // through is the one who does the reporting: Michael hung is Michael not
    // passing anything on, and the floor would have gone quiet with nobody
    // anywhere saying why.
    notify('stuck', `${id} has not finished`, `${mins} minutes mid-turn, still going`, {
      tab: 'monitor',
      id
    })
    if (ptys.isRunning(dispatchId()) && id !== dispatchId()) {
      hive.send({
        from: 'bullpen',
        to: dispatchId(),
        subject: `no end to a turn: ${id}`,
        body:
          `${id} started a turn ${mins} minutes ago and has not finished it. ` +
          (card ? `It was given "${card.text}", and that card is on the board as stuck. ` : '') +
          'Nothing has been killed - it may still come back. Ask it where it got to, ' +
          'and put somebody else on the work if it cannot say.'
      })
    }
    reportDue = true
  }
}

/**
 * An agent that finished its turn and told nobody.
 *
 * Everything on this floor moves because somebody sent a message. That is the
 * whole design and it is also its one open end: an agent that simply does not
 * write one is indistinguishable, from outside, from an agent still thinking.
 * The card sits in the working column, the assigner waits for a report that is
 * not coming, and the floor reads as busy forever - `reportWhenQuiet` only
 * fires when work was handed over, and asks a model to go and find out, which
 * is the same unreliable step one level up.
 *
 * So: the turn ended, the card did not move, and the app knows both. Wait long
 * enough that a message still in the outbox has been routed - the router
 * sweeps every 500ms and this is minutes - then ask once. If the next silence
 * is the same card in the same column, stop asking and say so: the card goes
 * to the floor's stuck column and Michael is told, because a board that goes
 * on calling this live work is the board lying about the floor.
 *
 * Re-armed by the Stop hook rather than by itself. The chase is a prompt, that
 * prompt is a turn, and the end of that turn comes back through here.
 */
function watchForStall(id: string): void {
  const card = openCard(id)
  if (!card) return
  // Not work that is meant to be sitting. `waiting` is a build parked for a
  // checker and `stuck` is somebody who already said so - both are cards whose
  // silence is the point.
  //
  // Asked of the floor before the column is named, never `column(kind)` alone:
  // that falls back to the first column for a kind the floor does not have, so
  // on a board with no `waiting` the test read as "is this card in `asked`" -
  // which is where every card starts, and nothing was ever watched.
  const parked = (['waiting', 'stuck'] as const)
    .filter((kind) => hasColumn(wf, kind))
    .map((kind) => column(kind))
  if (parked.includes(card.status)) return

  setTimeout(() => {
    const now = openCard(id)
    // Moved, closed, or replaced by the next task: whatever happened, the
    // agent is not silent about this one.
    if (!now || now.id !== card.id || now.status !== card.status) return
    // Working again, or gone. A dead pty already sends its card to `stuck` on
    // the way out, and one mid-turn is not silent yet.
    if (!ptys.isRunning(id) || working.has(id)) return

    const what = card.text.slice(0, 80)
    if (chased.has(card.id)) {
      cardTo(id, column('stuck'))
      activity.push('dead', id, `${id} went quiet holding "${what}" - the card is stuck`)
      // Michael, because he is the one who reports to the human, and this is
      // the report nobody else is going to make.
      if (ptys.isRunning(dispatchId())) {
        hive.send({
          from: 'bullpen',
          to: dispatchId(),
          subject: `no report: ${what}`,
          body:
            `${id} was given this and has been idle since without telling anyone where it ` +
            `stands. It was asked once and said nothing. The card is on the board as stuck. ` +
            `Find out where it got to, or put somebody else on it.`
        })
      }
      reportDue = true
      return
    }

    chased.add(card.id)
    activity.push('trigger', id, `chased ${id} for a report on "${what}"`)
    submitPrompt(
      id,
      `[bullpen] Your turn ended and you are still holding this task: "${card.text}". ` +
        'Nobody has been told where it stands. Report it now: one message to whoever handed ' +
        'it to you, with the subject starting "done: " if it is finished and "fail: " if it ' +
        'is not - those two words exactly. If you are waiting on somebody, say so and say who. ' +
        'Silence is the one answer nobody can act on.'
    )
  }, STALL_MS).unref?.()
}

/**
 * Say that an agent has been given something, on the board.
 *
 * Assignments happen in the mail, between agents, with nothing in the UI to
 * click - so the board was a list only the operator ever wrote to, describing
 * work nobody was doing. A card per assignment makes it the floor's list.
 */
function cardFor(
  agentId: string,
  text: string,
  by = agentId,
  meta: { role?: string; checks?: string } = {}
): string | null {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300)
  if (!clean) return null
  // Not a second card for the same instruction: Michael re-sends a task when he
  // chases it, and a chase is not a new job.
  const open = openCard(agentId)
  if (open && open.text === clean) return open.id
  const made = board.addTask(agentId, clean, column('start'), { by, ...meta })
  // Logged against whoever handed it over, not whoever received it: this line
  // is what the assigner's own page is made of.
  activity.push('task', by, `${by === agentId ? agentId : `${by} → ${agentId}`}: ${clean.slice(0, 80)}`)
  pushTasks()
  return made?.id ?? null
}

/**
 * A tester has spoken, which is the only thing that finishes a task.
 *
 * The developer's card is sitting in wait_test with nobody's word on it but the
 * developer's. A pass closes it and the tester's own card with it; a fail puts
 * the tester's card in blocked and leaves the work where it is, because the
 * developer is being mailed about it directly and is not finished.
 */
function testerReported(testerId: string, subject: string, taskId?: string): void {
  const failed = /^\s*(fail|bug|broken)\b/i.test(subject)
  // The checker's own card, by name where the message said which.
  const own = cardOf(testerId, taskId)
  cardTo(testerId, failed ? column('stuck') : column('done'), taskId)
  if (failed) return

  /**
   * The build this check was of, where the board knows.
   *
   * `checks` is written when the check is handed over, and it is the whole
   * answer: one build closes, and two features under test at once stop being
   * able to close each other. Only the sweep below is left for cards opened
   * before the link existed, or handed over without one.
   */
  const built = own?.checks ? board.task(own.checks) : undefined
  if (built) {
    board.setTaskStatus(built.id, column('done'))
    pushTasks()
    return
  }

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
function said(from: string, subject: string, taskId?: string): void {
  if (/^\s*(done|pass|finished|shipped|ok)\b/i.test(subject)) cardTo(from, column('done'), taskId)
  else if (/^\s*(fail|bug|broke|blocked|stuck|error)\b/i.test(subject)) {
    cardTo(from, column('stuck'), taskId)
  }
}

/** Move an agent's open card, if it has one. */
/**
 * The card a message is about, for one agent.
 *
 * `taskId` is what the message quoted, and it is honoured only when that card
 * belongs to this agent. Two reasons, both of them real failures: a rule may
 * move the *receiver's* card - "checks → builds: doing (their card)" is a bug
 * going back - and the id on that message is the sender's. And a message
 * handed to a role is stamped with the card just opened for whoever took it,
 * so a tester reporting a pass carried the analyst's card id, not its own.
 *
 * Falling back to the newest open card is what everything did before any of
 * this, and is still right for a message that quoted nothing.
 */
const cardOf = (agentId: string, taskId?: string): Task | undefined => {
  const named = taskId ? board.task(taskId) : undefined
  return named && named.agentId === agentId ? named : openCard(agentId)
}

/**
 * Move a card, by name where the message said which one.
 *
 * `taskId` is what the message quoted back. Only honoured when that card is
 * this agent's: a rule may move the *receiver's* card - "checks → builds: doing
 * (their card)" is a bug going back - and the id on that message belongs to the
 * sender. Falling back to the newest open card is what this always did, and is
 * still right for a message that quoted nothing.
 */
function cardTo(agentId: string, status: TaskStatus, taskId?: string): void {
  const open = cardOf(agentId, taskId)
  if (!open || open.status === status) return
  board.setTaskStatus(open.id, status)
  pushTasks()
}

/**
 * Cards the operator has released to the agent they were typed for.
 *
 * A card added by hand told the agent nothing, and telling it about every card
 * as it was typed would spend a turn on a list still being written. So adding
 * a card and starting the work are two acts: this is what the second one
 * wrote, and `pump` is what reads it.
 *
 * In memory on purpose. Opening the app again is not a decision to spend
 * tokens, and a queue that resumed itself on launch would be one.
 */
const released = new Set<string>()

/** How many times one card may be handed over before it is called stuck. */
const HANDOVERS = 3
const handovers = new Map<string, number>()

/**
 * Hand an agent the next card it has been released to work on.
 *
 * Called when a turn ends as well as when the operator confirms one, so a
 * queue is worked to the end rather than one card per press. An agent whose
 * card is still live is left alone: a second task typed into a terminal
 * mid-turn is one of the two being forgotten.
 */
function pump(id: string): void {
  if (!ptys.isRunning(id) || working.has(id) || waiting.has(id)) return
  // Asked of the floor before the column is named: `column(kind)` alone falls
  // back to the first column for a kind this floor does not have, which is
  // where every card starts - and every queued card would read as live work.
  const live = (['working', 'waiting'] as const)
    .filter((kind) => hasColumn(wf, kind))
    .map((kind) => column(kind))
  const mine = board.tasks(id)
  if (mine.some((t) => live.includes(t.status))) return
  const next = mine.find((t) => released.has(t.id) && t.status === column('start'))
  if (!next) return

  const what = next.text.slice(0, 80)
  // A card that keeps coming back is a card this agent cannot do, and a queue
  // that re-sends it forever is a bill with nothing at the end of it.
  const tries = (handovers.get(next.id) ?? 0) + 1
  if (tries > HANDOVERS) {
    released.delete(next.id)
    board.setTaskStatus(next.id, column('stuck'))
    pushTasks()
    activity.push('dead', id, `${id} was given "${what}" ${HANDOVERS} times and it is still open - the card is stuck`)
    return
  }
  handovers.set(next.id, tries)
  board.setTaskStatus(next.id, column('working'))
  pushTasks()
  submitPrompt(
    id,
    `[bullpen] From your board: ${next.text}. Work it now. When it is finished, mail a report ` +
      'with the subject starting "done: " - "fail: " if it is not - to whoever is waiting on it. ' +
      'That report is what closes the card.'
  )
  activity.push('task', id, `started "${what}" from the board`)
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
  if (!reportDue || busy().length > 0) return
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
  return spawnAgent({ id, cwd, args: [], role: wf.dispatch, ...size })
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
async function retire(next: Workflow): Promise<string[] | null> {
  const going: string[] = []
  for (const a of ptys.list()) {
    if (a.status !== 'running') continue
    const role = roles.get(a.id) ?? roleOfFixedId(wf, a.id)
    if (!role) continue
    if (hasPlaceFor(next, { id: a.id, role, standing: standing.has(a.id) })) continue
    going.push(a.id)
  }
  // Killed mid-turn, an agent's work is gone: no record beyond an activity
  // line, and nobody was asked. An idle one is nothing to ask about - there is
  // nothing in its hands - so only the ones holding a card stop the switch.
  //
  // The second answer keeps the floor that is running rather than keeping the
  // agents: a floor applied with the agents it has no place for still on it is
  // the half-applied state everything else here exists to avoid. Escape and the
  // window close come back as that answer too, so the accident is never the
  // destructive one.
  const holding = going.filter((id) => openCard(id))
  if (holding.length && win) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Stand them down', `Keep "${wf.name}"`],
      defaultId: 1,
      cancelId: 1,
      message: `"${next.name}" has no role for ${holding.length} agent(s) still holding work.`,
      detail: `${holding.join(', ')} - what they are doing is lost when they are stood down.`
    })
    if (response === 1) return null
  }
  const gone: string[] = []
  for (const id of going) {
    await stop(id)
    roles.delete(id)
    standing.delete(id)
    gone.push(id)
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
  return spawnAgent({ id, cwd, args: [], role, ...size })
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
    hung.delete(id)
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
    if (move?.kind === 'open') {
      cardFor(move.agent, move.text, move.by, { role: roleOf(move.agent) })
      // And the one who handed it over is now waiting on it. Nothing else ever
      // wrote the working column on a floor with nobody to check work - a card
      // opened in `todo` and jumped to `done`, and the column in between was a
      // stage the board could not reach. Only where the floor has one:
      // `columnFor` falls back to the first column, which would send the card
      // it was about to advance back to the start. No-ops for the human, who
      // has no card, and for anybody who has not been given one.
      if (hasColumn(wf, 'working')) cardTo(msg.from, column('working'), msg.task)
    }
    else if (move?.kind === 'move') cardTo(move.agent, move.status, msg.task)
    else if (move?.kind === 'checked') testerReported(move.agent, move.subject, msg.task)
    else said(msg.from, msg.subject, msg.task)

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
   * Somebody able to take work in this role, hiring when nobody is free.
   *
   * The pick-or-hire half of `assignTo`, on its own because it has a second
   * caller now: a card posted for a role has to reach somebody too, and it does
   * not open a card - the card already exists, unheld, waiting to be claimed.
   * Written twice it would have been two answers to "who staffs this floor",
   * and the hire is the expensive half to get wrong.
   *
   * No card, no message, no side effect on the board. Just a name, or null.
   */
  const staffFor = (role: string, from: string, brief = ''): string | null => {
    if (!wf.roles[role]) return null
    const staff: Candidate[] = ptys
      .list()
      .filter((a) => a.status === 'running' && a.id !== from)
      .map((a) => ({
        id: a.id,
        role: roleOf(a.id),
        idle: !working.has(a.id),
        ctxPct: currentCtx(a.id)?.pct
      }))

    const free = pickForRole(wf, role, staff)
    if (free) return free
    if (wf.roles[role].hireable !== true) return null

    /**
     * Nobody free, so somebody new - and hiring is Michael's, wherever the ask
     * came from.
     *
     * The chain already worked: an analyst asking for a developer falls through
     * to the analyst's own workspace, so the hire happened. What it did not do
     * was say whose hire it was. Every step of a floor three deep read as that
     * step staffing the floor itself, which is four people each appearing to do
     * the one job that belongs to one desk.
     *
     * Michael is that desk, and his workspace is the one directory on the floor
     * that is always there. So it is the last resort rather than giving up: the
     * only way to reach the old `null` was an asker whose pty had exited
     * between writing the message and the router picking it up, and losing a
     * hire to that is losing it to a race.
     *
     * Michael has no project to borrow either - the roster publishes an empty
     * one for anybody core, and he is never in `hires` - so there is nothing to
     * fall back to between the asker and the floor's own name.
     */
    const project = projectOf(from) || slug(wf.name)
    const cwd =
      projectCwd(project) ?? ptys.list().find((a) => a.id === from)?.cwd ?? currentGodCwd()
    mkdirSync(cwd, { recursive: true })
    const name = nextHireName(project)
    try {
      const state = spawnAgent({
        id: nameId(name),
        cwd,
        args: [],
        cols: 100,
        rows: 30,
        role,
        // Whoever asked is still who the work reports to. Being hired by
        // Michael and answering to Michael are not the same thing.
        reportTo: from
      })
      hires.set(state.id, { name, project })
      forgetAgent(state.id)
      reportDue = true
      // Logged against Michael, because he is who hired: the line used to read
      // as the asker doing it, and on a floor three deep that is four different
      // people each appearing to staff the floor themselves.
      activity.push(
        'spawn',
        dispatchId(),
        `${from} needed a ${role} and none was free - ${dispatchId()} hired ${name}`
      )
      // `brief` with it: the roster shows a new hire with what it was hired to
      // do, and dropping it left an agent appearing on the floor with no sign
      // of why. The explicit hire path has always sent it.
      send('agent:hired', { ...state, name, project, role, ...(brief ? { brief } : {}) })
      return state.id
    } catch (err) {
      console.error(`[bullpen] could not hire a ${role}:`, err)
      return null
    }
  }

  /**
   * Cards nobody has taken, past the point where somebody should have.
   *
   * `offer` tells one agent a posted card is there and leaves it unheld on
   * purpose, so a busy one can pass. Nothing then looked at it again: an offer
   * declined - or made to an agent that never read it - left the card on the
   * list with no holder, no chase, and nothing that would ever mention it. The
   * silent-agent watchdog cannot see it, because it watches agents and this
   * card has none.
   *
   * Offered once more, then handed back to whoever posted it. `chased` is the
   * same set the silent-agent path uses and is keyed by card id, so a card gets
   * one second chance here exactly as an agent gets one there.
   *
   * Beside `offer` rather than inside `sweepHung`, which is where it started:
   * that one is module-level and this needs the pick-or-hire path, which is not.
   */
  function sweepUnclaimed(): void {
    const now = Date.now()
    for (const card of board.tasks('')) {
      if (now - card.createdAt < STALL_MS || card.status === column('stuck')) continue
      if (!chased.has(card.id)) {
        chased.add(card.id)
        if (offer(card)) continue
      }
      if (dropped.has(card.id)) continue
      dropped.add(card.id)
      board.setTaskStatus(card.id, column('stuck'))
      pushTasks()
      activity.push('dead', card.by ?? 'bullpen', `nobody took "${card.text.slice(0, 60)}"`)
      const tell = card.by && ptys.isRunning(card.by) ? card.by : dispatchId()
      if (ptys.isRunning(tell)) {
        hive.send({
          from: 'bullpen',
          to: tell,
          subject: `nobody took: ${card.text.slice(0, 60)}`,
          task: card.id,
          body:
            `This was posted for "${card.role ?? 'nobody in particular'}" and has been offered ` +
            'twice with nobody claiming it. It is on the board as stuck. Hand it to somebody by ' +
            'name, or take it off the list.'
        })
      }
      reportDue = true
    }
  }

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
    // Not `role === roleOf(from)`. That was here to stop an agent handing work
    // to itself, which the candidate list already does by dropping `from` - and
    // what it actually blocked was two different agents in the same role. A
    // floor that draws a line from a role back to itself means "hand it to
    // another one of me", and it was read as meaning nothing: refused before
    // `refuseMail` was ever asked, so the drawing had no say. A floor that
    // draws no such line still refuses, one line further down.
    if (!wf.roles[role]) return null
    // Asked before anybody is chosen or hired: the chain refuses this message
    // a moment later anyway, and hiring somebody for work that will not be
    // delivered leaves an agent standing on the floor with nothing to do.
    if (from !== 'bullpen' && from !== wf.human && from !== 'webhook') {
      if (refuseMail(wf, roleOf(from), role)) return null
    }

    // What the work is, for the board and for the roster.
    const what = [msg.subject, msg.body].filter(Boolean).join(' — ')
    const who = staffFor(role, from, what)
    if (!who) return null

    // Written here rather than left to a card rule. Written here rather than left to a card
    // A floor with no rules still has work being handed over, and a board that
    // shows none of it is the app lying about what the floor is doing.

    /**
     * A check is somebody else's build, being looked at.
     *
     * This is the one moment both cards are in hand: the sender quoted the card
     * they are handing over, and a card is about to be opened for the role that
     * decides whether it passed. Recorded so a pass closes that build and
     * nothing else - the alternative, and what this replaces, was "every card
     * waiting on this project", which closed every feature under test the
     * moment any one of them passed.
     */
    const build = msg.task ? board.task(msg.task) : undefined
    const checks =
      can(wf, role, 'checks') && build && build.agentId && build.agentId !== who
        ? build.id
        : undefined

    const opened = cardFor(who, what, from, { role, checks })
    // Never over the top of one the sender already quoted. `task` means "the
    // card this message is about", and on a report that is the sender's own -
    // stamping the card just opened for the reader clobbered it, so a report
    // that named which of two jobs it had finished arrived naming neither.
    // `cardTo` ignores an id that is not the agent's anyway, so the sender's is
    // the one worth keeping.
    if (!msg.task) msg.task = opened ?? undefined
    return who
  }

  /**
   * Put a posted card in front of somebody who could take it.
   *
   * A card on the list wakes nobody. An agent acts when something is typed at
   * it and at no other time, so `post` without this was a card written to a
   * file that every agent could read and none had any reason to open - the one
   * failure mode a shared list invites, and the reason the list is a payload
   * here rather than a transport.
   *
   * Offered, not assigned: the card stays unheld until somebody claims it, so
   * an agent that is busy or unwilling leaves it for the next one. Returns who
   * was told, or null when the floor has nobody for that role.
   */
  function offer(card: Task): string | null {
    const role = card.role ?? ''
    if (!wf.roles[role]) return null
    const who = staffFor(role, card.by ?? dispatchId(), card.text)
    if (!who) return null
    hive.send({
      from: 'bullpen',
      to: who,
      subject: `up for grabs: ${card.text.slice(0, 60)}`,
      task: card.id,
      body:
        `${card.by ?? 'somebody'} put this on the board for "${role}" and nobody has taken it.\n\n` +
        `${card.text}\n\n` +
        `Take it by writing {"from": "${who}", "to": "board", "subject": "claim", "task": "${card.id}"} ` +
        'to your outbox, then work it and report the way you report anything. ' +
        'Leave it if you are already on something - it stays on the list for somebody else.'
    })
    activity.push('task', dispatchId(), `offered "${card.text.slice(0, 60)}" to ${who}`)
    return who
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

  /**
   * Undeliverable, and said so - the same reason `blocked` answers.
   *
   * `blocked` is a message the floor refused; this is one it accepted and then
   * could not place, which from the sender's side is worse: they were allowed
   * to write it. A message to a role nobody holds and nobody could be hired
   * into used to end here, logged and pushed at the UI and never mentioned to
   * the agent waiting on the reply.
   *
   * Three different silences, so three different sentences. `?` is a file that
   * did not parse - the message hive built already says so. `*` is a broadcast
   * that reached nobody, which is a floor of one rather than a bad address.
   * Anything else is a name, and `refuseMail` is what says where it should
   * have gone instead - for a role that exists and could not be staffed it
   * says nothing, and that is the case worth spelling out.
   */
  hive.on('dead', (msg: Message) => {
    activity.push('dead', msg.from, `undeliverable to ${msg.to}: ${msg.subject}`)
    send('hive:dead', msg)
    if (!ptys.isRunning(msg.from)) return
    const why =
      msg.to === '?'
        ? msg.body
        : msg.to === '*'
          ? 'Nobody else is on the floor, so the broadcast reached no one.'
          : (refuseMail(wf, roleOf(msg.from), msg.to) ??
            (!wf.roles[msg.to]
              ? `There is nobody called "${msg.to}" on this floor.`
              : // Named before the staffing answer, because "nobody could be
                // hired into it" reads as a floor that ran out of room when
                // what happened is that the sender addressed their own job.
                msg.to === roleOf(msg.from)
                ? `"${msg.to}" is your own role, so there is nobody else in it to hand this to. Do it yourself, or send it to whoever handed it to you.`
                : `Nobody holds "${msg.to}" and nobody could be hired into it. Say so to whoever handed you this, or take it on yourself if you can.`))
    hive.send({
      from: 'bullpen',
      to: msg.from,
      subject: `not delivered: ${msg.subject}`,
      body: `${why}\n\nNothing was delivered. Your message is unchanged in the dead letters if you need it back.`
    })
  })
  hive.on('question', (msg: Message) => {
    // Stamped here: an agent writes the json itself and rarely sets `ts`, so
    // without this every question reads as "— ago" wherever it is shown.
    const ts = msg.ts || Date.now()
    if (msg.from === godId && (reportWanted || REPORTING.test(msg.subject))) {
      reportWanted = false
      const report = { ...msg, ts }
      reports.unshift(report)
      reports.length = Math.min(reports.length, REPORTS_KEPT)
      activity.push('message', msg.from, `${msg.from} reported: ${msg.subject}`)
      notify('report', `${msg.from} reported`, msg.body, { tab: 'monitor', id: msg.from })
      send('report:new', report)
      return
    }
    const q: Ask = { id: `q${++questionSeq}`, from: msg.from, subject: msg.subject, body: msg.body, ts }
    asks.add(q)
    activity.push('question', msg.from, `${msg.from} asks you: ${msg.subject}`)
    notify('ask', `${msg.from} asks you`, msg.subject, { tab: 'ask me', id: msg.from })
    send('ask:pending', asks.pending())
  })

  // A router tick that throws would otherwise be an EventEmitter 'error' with
  // no listener, which takes the whole main process down over one bad message.
  hive.on('error', (err: unknown) => {
    activity.push('dead', 'bullpen', `mail router error: ${err instanceof Error ? err.message : String(err)}`)
  })

  /**
   * A change to the task list, asked for rather than made.
   *
   * `$BULLPEN_TASKS` is a file and every agent can read it. None of them may
   * write it: two reading the same list at the same moment both see a card
   * free, and only one may come away holding it. So the list is read directly
   * and changed by message, and main is the only writer there is.
   *
   * Four verbs, and no more. Anything richer belongs in the mail an agent
   * already sends - a card says where work stands, not what was decided about
   * it, and a board that carried the conversation would be a second inbox
   * nobody is prompted to read.
   */
  hive.on('board', (msg: Message) => {
    const verb = msg.subject.trim().toLowerCase().split(/\s+/)[0] ?? ''
    const reply = (body: string): void => {
      hive.send({ from: 'bullpen', to: msg.from, subject: `re: board ${verb}`, body })
    }
    const card = msg.task ? board.task(msg.task) : undefined
    const mine = (): boolean => {
      if (!card) {
        reply(msg.task ? `There is no card ${msg.task}.` : 'Name the card in "task".')
        return false
      }
      if (card.agentId !== msg.from) {
        reply(`Card ${card.id} is ${card.agentId || 'nobody'}'s, not yours. Claim it first.`)
        return false
      }
      return true
    }

    if (verb === 'post') {
      // Work put on the list for a role rather than for a person. `assignTo` is
      // still what finds somebody, so this is the same hand-off the mail makes -
      // the difference is that the card exists first, and is what the message
      // points at rather than what it is reconstructed from.
      const role = (msg.role ?? '').trim()
      if (!wf.roles[role]) return reply(`"${role}" is not a role on this floor.`)
      // The floor still says who may hand work to whom. Posting is a hand-off
      // with the taker left open, not a way around the lines on the chart.
      const refused = refuseMail(wf, roleOf(msg.from), role)
      if (refused) return reply(refused)
      const made = board.addTask('', msg.body.trim() || msg.subject, column('start'), {
        by: msg.from,
        role
      })
      if (!made) return reply('A card needs something written on it.')
      pushTasks()
      activity.push('task', msg.from, `${msg.from} posted for ${role}: ${made.text.slice(0, 80)}`)
      // And put in front of somebody. A card nobody is told about is a card
      // nobody opens: an agent acts when something is typed at it and at no
      // other time, so the list is where work lives, not how it travels.
      const told = offer(made)
      reply(
        told
          ? `Posted as ${made.id}, and ${told} has been told it is there.`
          : `Posted as ${made.id}, but nobody holds "${role}" and nobody could be hired into it - ` +
            'it will sit on the list until somebody can.'
      )
      return
    }

    if (verb === 'claim') {
      if (!card) return reply(msg.task ? `There is no card ${msg.task}.` : 'Name the card in "task".')
      if (card.role && card.role !== roleOf(msg.from)) {
        return reply(`Card ${card.id} is work for "${card.role}", which is not what you are here.`)
      }
      if (!board.claim(card.id, msg.from)) {
        return reply(`Card ${card.id} is already ${board.task(card.id)?.agentId}'s.`)
      }
      pushTasks()
      activity.push('task', msg.from, `${msg.from} took "${card.text.slice(0, 80)}"`)
      reply(`Yours: ${card.id}. Report on it the way you report on anything else.`)
      return
    }

    if (verb === 'done' || verb === 'blocked') {
      if (!mine()) return
      const where = column(verb === 'done' ? 'done' : 'stuck')
      cardTo(msg.from, where, card!.id)
      activity.push('task', msg.from, `${msg.from} says ${verb}: ${card!.text.slice(0, 80)}`)
      // Said on the board is not said to the person waiting. Whoever handed it
      // over is told, because a card moving is not a report - and the card knows
      // who that was, which is why `by` is on it.
      // Only to somebody who can actually be written to. `by` is whoever opened
      // the card, and that is not always an agent: the webhook opens cards, and
      // so does the operator through the panel - mail to either is dead mail
      // and a "not delivered" bounce at the agent that did nothing wrong.
      if (card!.by && card!.by !== msg.from && ptys.isRunning(card!.by)) {
        hive.send({
          from: msg.from,
          to: card!.by,
          subject: `${verb === 'done' ? 'done' : 'fail'}: ${card!.text.slice(0, 60)}`,
          body: msg.body || `Marked ${verb} on the board.`,
          task: card!.id
        })
      }
      return
    }

    reply('The board takes "post", "claim", "done" and "blocked", and nothing else.')
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
    // The workflow says which roles may be hired into. A hire that names one
    // gets it; a hire that names nothing gets the next role down the chain from
    // whoever asked - the one they may write to, and the one they are waiting
    // on.
    //
    // It used to fall straight to whoever builds. On a floor of
    // boss → analyst → developer → tester that turned "the floor is empty, hire
    // somebody to take this request" into a developer: three desks past the one
    // the boss can hand work to, briefed to report to a role with nobody in it.
    // The work stopped there, and the floor had no analyst on it at all.
    const asked = msg.role?.trim().toLowerCase() ?? ''
    const downstream = (wf.talksTo[roleOf(msg.from)] ?? []).filter(
      (r) => wf.roles[r]?.hireable === true
    )
    const role =
      wf.roles[asked]?.hireable === true
        ? asked
        : (downstream[0] ??
          rolesWith(wf, 'builds').find((r) => wf.roles[r].hireable) ??
          wf.dispatch)
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
        args: [],
        cols: 100,
        rows: 30,
        role,
        // Whoever asked for the hire is who the work comes back to.
        reportTo: msg.from
      })
      hires.set(state.id, { name, project })
      forgetAgent(state.id)
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
      working.set(id, Date.now())
      hung.delete(id)
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
      hung.delete(id)
      if (working.delete(id)) {
        reportFinished(id)
        // Finished a turn - so if it still holds live work, nobody has been
        // told where that work stands.
        watchForStall(id)
      }
      reportWhenQuiet()
      // Free again: whatever else the operator released is next.
      pump(id)
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
  updates.on('state', (s: UpdateState) => send('update:state', s))
  // Once per version, through the same door every other "you are wanted" goes
  // through. `notify` is already the thing that stays quiet while the window
  // has focus and says nothing twice in a row.
  updates.on('found', (next: string) => {
    notify('update', `New version available - ${next}`, 'Open the app to update.', {
      tab: 'terminal'
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
   * Bring an agent back up under the same id, somewhere else or on another model.
   *
   * A CLI reads its working directory and its `--model` once, at startup, so
   * both are a restart and there is no way to make them anything else - the
   * same reason `god:move` restarts Michael. Done here rather than as kill and
   * spawn from the renderer because `spawnAgent` refuses an id that is still
   * running: the renderer would have had to watch for the exit event and race
   * it, and losing that race is a dead row on the roster with no way back.
   */
  ipcMain.handle('agent:restart', async (_e, spec: AgentSpec) => {
    await stop(spec.id)
    // Whatever it was refused before, restated from the floor in force. It is
    // the same agent in the same role; only where it works and what it runs on
    // have moved.
    try {
      return spawnAgent(spec)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

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
        const state = startGod(target, size)
        // Saved only once the CLI is actually up. Written before the spawn, a
        // machine with no `claude` on PATH recorded the directory as chosen and
        // never showed the first-run dialog again: every later launch failed the
        // same way with the reason going nowhere but the console.
        writeConfig(BULLPEN_HOME, { ...readConfig(BULLPEN_HOME), godCwd: target })
        return { ...state, name: wf.roles[wf.dispatch]?.fixed?.name ?? dispatchId() }
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
  /**
   * The version this is, and the one there could be.
   *
   * Four channels: what the state is, ask again, fetch it, and put it on. The
   * last one takes the whole app down with it - every agent on the floor is a
   * child of this process - so the renderer asks before calling it.
   */
  /**
   * What was asked for before anything could listen. Drained, not read: a
   * folder handed over twice opens two wizards for one directory.
   */
  ipcMain.handle('open:pending', () => {
    const paths = openQueue
    openQueue = []
    return paths
  })

  ipcMain.handle('update:get', () => updates.get())
  ipcMain.handle('update:check', () => updates.check())
  ipcMain.handle('update:download', () => updates.download())
  ipcMain.handle('update:install', () => updates.install())
  // Not a step in any update any more - both platforms install for themselves.
  // Kept as the way out when one of them cannot: an error state, or somebody
  // who wants the list rather than the newest.
  ipcMain.handle('update:page', () => {
    void shell.openExternal(updates.releasesUrl)
    return true
  })

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

  /**
   * The same floors on the other machine.
   *
   * Three presses, not a background daemon: a sync that runs on its own is a
   * sync that overwrites work while somebody is in the middle of it, and last
   * write wins has no opinion about who was typing. Say when.
   */
  /** The code somebody is typing into github.com right now. */
  let pending: DeviceCode | null = null

  // Reads the token's file, never the token. Drawing this pane used to decrypt
  // it, and on macOS decrypting means the keychain, which means a password
  // prompt on every build whose signature has changed - which is every build.
  ipcMain.handle('sync:status', () => {
    const cfg = readConfig(BULLPEN_HOME)
    const stored = tokenOnDisk(BULLPEN_HOME)
    return {
      gist: cfg.sync?.gist ?? '',
      machine: cfg.sync?.machine ?? hostname(),
      hasToken: stored.has,
      user: cfg.sync?.user ?? '',
      // Whether the token that is *here* was encrypted, which is what the pane
      // warns about. Asking `safeStorage` whether it could encrypt one is the
      // same keychain trip this handler exists to avoid.
      keyring: stored.encrypted,
      canSignIn: Boolean(CLIENT_ID),
      floors: Object.keys(readFloors(BULLPEN_HOME)).length
    }
  })

  /**
   * Sign in to GitHub without a server.
   *
   * Two presses in one flow: this hands back the code to show, and `sync:wait`
   * blocks until the person has typed it in. Split because the code has to be
   * on screen *while* the polling happens - one call that did both would show
   * the code only after it had already been used.
   */
  ipcMain.handle('sync:signIn', async () => {
    // Said here rather than left to `deviceCode`: the button is always on
    // screen, so this is the first press on a build that shipped without a
    // client id, and it should read as "not in this build" rather than as a
    // failure the person pressing it could have avoided.
    if (!CLIENT_ID) return { error: 'Signing in is not set up in this build.' }
    const got = await deviceCode(CLIENT_ID)
    if (got.error || !got.code) return { error: got.error ?? 'GitHub did not send a code.' }
    pending = got.code
    // Opened here rather than in the renderer: the page is on github.com and
    // the window has no business navigating anywhere.
    shell.openExternal(got.code.url)
    return { userCode: got.code.userCode, url: got.code.url, expires: got.code.expires }
  })

  ipcMain.handle('sync:wait', async () => {
    if (!pending) return { error: 'Nothing to wait for. Start again.' }
    const code = pending
    const res = await awaitToken(CLIENT_ID, code)
    pending = null
    if (res.error || !res.token) return { error: res.error ?? 'GitHub would not say why.' }
    writeToken(BULLPEN_HOME, res.token)
    await remember(res.token)
    return { ok: true }
  })

  /** Ask GitHub who the token belongs to, and keep the answer. */
  const remember = async (token: string): Promise<string> => {
    const who = await whoAmI(token)
    if (!who.login) return ''
    const cfg = readConfig(BULLPEN_HOME)
    writeConfig(BULLPEN_HOME, { ...cfg, sync: { ...cfg.sync, user: who.login } })
    return who.login
  }

  /**
   * Who is signed in, asked rather than remembered.
   *
   * The dialog draws the remembered name first and calls this after, because a
   * token can outlive the answer: revoked on github.com, or signed in before
   * this was ever recorded. An error here is not fatal - it means the name on
   * screen is the last one that was true.
   */
  ipcMain.handle('sync:whoami', async () => {
    const token = readToken(BULLPEN_HOME)
    if (!token) return { error: 'Not signed in.' }
    const who = await whoAmI(token)
    if (who.error || !who.login) return { error: who.error ?? 'GitHub sent no login.' }
    await remember(token)
    return { login: who.login }
  })

  ipcMain.handle(
    'sync:set',
    (_e, next: { token?: string; machine?: string }) => {
      if (next.token !== undefined) {
        writeToken(BULLPEN_HOME, next.token.trim())
        // The name belongs to the token. Left behind, the dialog says somebody
        // is signed in as an account this machine can no longer reach.
        if (!next.token.trim()) {
          const cfg = readConfig(BULLPEN_HOME)
          writeConfig(BULLPEN_HOME, { ...cfg, sync: { ...cfg.sync, user: '', gist: '' } })
        }
      }
      const fields = ['machine'] as const
      if (fields.some((f) => next[f] !== undefined)) {
        const cfg = readConfig(BULLPEN_HOME)
        writeConfig(BULLPEN_HOME, {
          ...cfg,
          sync: {
            ...cfg.sync,
            ...Object.fromEntries(
              fields.filter((f) => next[f] !== undefined).map((f) => [f, next[f]!.trim()])
            )
          }
        })
      }
      return { ok: true }
    }
  )

  const bundleHere = (machine: string): Bundle => bundle(BULLPEN_HOME, machine)

  /**
   * The gist this machine syncs through: the one already on the account, or a
   * new one.
   *
   * Worked out rather than asked for. There was a field for the id and a button
   * to make one, which meant the second machine could not sync until somebody
   * had carried a hex string across to it - on a setup where both ends are
   * signed in to the same GitHub account and the file has the same name in
   * both. Whatever this resolves is written back, so it is looked up once.
   */
  const gistFor = async (token: string, machine: string): Promise<{ gist?: string; error?: string }> => {
    const saved = readConfig(BULLPEN_HOME).sync?.gist
    if (saved) return { gist: saved }
    const found = await findGist(token)
    if (found.error) return { error: found.error }
    const gist = found.gist ?? (await createGist(token, bundleHere(machine))).gist
    if (!gist) return { error: 'GitHub would not make a gist to sync through.' }
    const cfg = readConfig(BULLPEN_HOME)
    writeConfig(BULLPEN_HOME, { ...cfg, sync: { ...cfg.sync, gist, machine } })
    return { gist }
  }

  /**
   * Read what is up there, and let the clock decide.
   *
   * Both directions in one press. Asking an operator to know whether they are
   * ahead or behind is asking them to keep the answer this function computes.
   */
  ipcMain.handle('sync:now', async () => {
    const token = readToken(BULLPEN_HOME)
    if (!token) return { error: 'Not signed in to GitHub yet.' }
    const cfg = readConfig(BULLPEN_HOME)
    const machine = cfg.sync?.machine ?? hostname()
    const found = await gistFor(token, machine)
    if (found.error || !found.gist) return { error: found.error ?? 'No gist to sync through.' }
    const gist = found.gist
    const here = bundleHere(machine)

    const got = await readGist({ token, gist })
    if (got.error) return { error: got.error }

    // Nothing up there yet, or this machine is the newer one: push.
    if (!got.bundle || newer(here, got.bundle) === 'here') {
      const put = await writeGist({ token, gist }, here)
      if (put.error) return { error: put.error }
      return { went: 'up' as const, floors: Object.keys(here.floors).length, at: here.at }
    }

    const done = adopt(BULLPEN_HOME, got.bundle)
    return { went: 'down' as const, from: got.bundle.from, at: got.bundle.at, ...done }
  })

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
  const SHIPPED_IS_READ_ONLY = true

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
    // list, and the floor it was made on carried on unchanged. Refused rather
    // than allowed-and-lost: draw on it all you like, and the moment you want
    // to keep what you drew, it is yours under your own name.
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
    // The same desk as every other door. A patch may name a different agent on
    // the dispatch role, and this one used to take it.
    seatGod(next)
    // Noted, not refused. A floor half-drawn is a floor mid-thought: somebody
    // adds a role before the line that reaches it, or a line before the rule
    // that uses it, and refusing to save until every check passes means the
    // work in front of them cannot be put down. The problems come back with the
    // save so they can be shown, and the floor is what they drew.
    const problems = lint(next, rulebook())
    const retired = await applyFloor(next)
    if (retired === null) return kept()
    return { workflow: wf, markdown: toMarkdown(wf), problems, retired }
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
   * The front desk, which is Michael on every floor there has ever been.
   *
   * Not a default and not a suggestion: the desk work is dispatched to is the
   * same desk everywhere - the same agent, the same face on the roster, the
   * same id every brief already writes to. What the floor calls the *role* is
   * its own business; who sits there is not.
   *
   * Seated rather than checked, because a floor refused for naming somebody
   * else is a floor somebody has to fix by hand to say a thing they did not
   * mean. Returns whether it had to change anything, so the caller knows
   * whether what it was handed is still what it should keep.
   */
  const GOD = { id: 'michael', name: 'Michael' } as const

  const seatGod = (w: Workflow): boolean => {
    const desk = w.roles[w.dispatch]
    if (!desk) return false
    if (desk.fixed?.id === GOD.id && desk.fixed?.name === GOD.name) return false
    w.roles = { ...w.roles, [w.dispatch]: { ...desk, fixed: { ...GOD } } }
    return true
  }

  /**
   * What a written floor has to be true of, whatever the model wrote.
   *
   * Rules a model can forget are not rules. Three of them are worth more than
   * the prompt line asking for them:
   *
   * The front desk is Michael - see `seatGod`. The model picks a plausible id
   * and a plausible name every time: `chief · Michael` on one floor,
   * `lead · Dana` on the next.
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
    if (!w.roles[w.dispatch]) return markdown
    seatGod(w)
    const named = (r: string | undefined): boolean => Boolean(r && w.roles[r])
    return toMarkdown({
      ...w,
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
      `- "## board": the stages a card moves through on a floor that does *this* work, in this ` +
      `floor's own words. A writing floor is not a support desk and neither is a delivery team, ` +
      `so name the stages the way somebody doing this work would say them out loud. Each line is ` +
      `"- key: label #colour (kind)", the kind being one of start, working, waiting, stuck, done. ` +
      `Exactly one column per kind, and always a start and a done. Only give it a "waiting" one ` +
      `if somebody on this floor decides whether work passed - that is the column work sits in ` +
      `while it waits to be checked - and only a "stuck" one if being blocked is worth seeing on ` +
      `the board.\n` +
      `Leave "## card rules" out of your answer entirely - what a message does to a card is ` +
      `worked out from the drawing here, and anything written there is thrown away. Copying the ` +
      `ones above back is worse than leaving them out: they name the stages of the board you were ` +
      `just asked to replace, and a file naming a stage its own board does not have will not read.\n` +
      `Answer with the whole file in Bullpen's format and nothing else - no fences, no preamble.` +
      extra

    /** The words are the model's; the shape is the drawing's. */
    const keep = (md: string): { markdown: string; problems: string[] } | { error: string } => {
      const parsed = parseMarkdown(withoutCardRules(md))
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
      // The board is the model's, when what came back is a board at all. It is
      // the one part of the shape that is about the *work* rather than about
      // who does it - `briefed → drafting → in review → published` is a floor
      // of writers saying what it does, and `todo → doing → done` is the app
      // saying nothing. Pinned to the drawing's own columns before, so every
      // floor written here came out with the same four words.
      const board = isBoard(w.columns) ? w.columns : floor.columns
      const shape = { ...floor, columns: board, roles }
      const next: Workflow = {
        ...shape,
        description: w.description || floor.description,
        summary: w.summary ?? floor.summary,
        // Worked out, not asked for. What a message does to a card follows from
        // the drawing - who hands work out, who does it, who decides it passed -
        // and a model asked to write those lines wrote a floor where handing
        // work over moved the sender's own card, a worker reporting finished
        // put its card back into `doing`, and the first task typed at the floor
        // opened nothing at all. None of that is visible in the file; it is
        // visible three days later as a board that does not move.
        cardRules: drawnCardRules(withWork({ ...shape, cardRules: [] }))
      }
      return { markdown: toMarkdown(trimmed(next)), problems: lint(trimmed(next)) }
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

  /**
   * Make a floor the one that runs.
   *
   * Everything applying a floor means, in one place. It was in two: `workflow:set`
   * did all of this, and `workflow:patch` set `wf` and saved and stopped there -
   * no reseating of the front desk, no board cleared, no tool refusals re-read,
   * so a floor applied through the second door came up with cards keyed to
   * columns it no longer had, agents holding permissions it had taken away, and
   * whoever the patch named sitting at Michael's desk.
   *
   * The two doors still differ where they are meant to: one refuses a floor that
   * does not lint, the other notes the problems and saves anyway, because a
   * half-drawn floor is a floor mid-thought. What happens *after* that decision
   * is the same either way, and is here.
   *
   * `saved` is the text to keep on disk - what was typed, unless the desk had to
   * be reseated, in which case what is running is not what was typed.
   */
  async function applyFloor(next: Workflow, saved?: string): Promise<string[] | null> {
    // Before `wf` moves, while the old floor can still say who was who.
    const retired = await retire(next)
    // The human was asked and said no. Nothing has moved yet - this is the
    // first line of the switch - so there is nothing to undo.
    if (retired === null) return null
    wf = next
    hive.reserved = { human: wf.human, hire: wf.hire, board: BOARD_PARTY }
    godId = fixedId(wf, wf.dispatch)
    writeConfig(BULLPEN_HOME, { ...readConfig(BULLPEN_HOME), workflow: wf })
    const markdown = toMarkdown(wf)
    try {
      saveWorkflow(BULLPEN_HOME, saved ?? markdown)
    } catch (err) {
      console.error('[bullpen] could not save the applied workflow:', err)
    }
    // The board with them. A card carries the key of a column on the floor it
    // was opened on, and this floor's columns are not those - so what was left
    // behind was not stale work, it was work in no column at all: not shown
    // anywhere, and still counted. Cleared rather than migrated, because a card
    // is about a floor and this is a different one. The two sets go with them:
    // a card id that will never be looked up again is one they need not hold.
    chased.clear()
    dropped.clear()
    const cardsDropped = board.clearTasks()
    if (cardsDropped) {
      pushTasks()
      activity.push('task', 'bullpen', `${cardsDropped} card(s) cleared for "${wf.name}"`)
    }
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
    return retired
  }

  /**
   * What a door says when the human answered the stand-down question with no.
   *
   * Reported as an error because that is the one shape every caller already
   * shows: a refusal with a reason, and the floor still running is the one
   * named in it. `wf` is untouched - `applyFloor` stops before it moves.
   */
  const kept = (): { error: string } => ({
    error: `Kept "${wf.name}" - the agents holding work are still on it.`
  })

  ipcMain.handle('workflow:set', async (_e, text: string) => {
    const parsed = parseMarkdown(text)
    if ('error' in parsed) return { error: parsed.error }
    // Michael's desk, whatever the file says. The chart forces it on the way
    // out of `staffed` and the generator on the way out of `tidy`, and this is
    // the door neither of those covers: markdown typed into the file column and
    // applied as it stands, which was the one way left to seat somebody else at
    // the desk the operator types at.
    const reseated = seatGod(parsed.workflow)
    const problems = lint(parsed.workflow, rulebook())
    // Refused rather than warned about: every one of these fails silently at
    // runtime - a card that never moves, a report that never reaches anyone -
    // and a floor that looks busy and finishes nothing is the worst outcome
    // this whole file exists to avoid.
    if (problems.length) return { error: problems.join('\n') }
    // Saved as written, unless the desk had to be reseated - then what is
    // running is not what was typed, and keeping the typed copy would show a
    // floor with somebody else's name on the front desk every time it opened.
    const retired = await applyFloor(parsed.workflow, reseated ? undefined : text)
    if (retired === null) return kept()
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
  /**
   * Off the roster for good: the board forgets it too.
   *
   * Separate from `agent:kill` because firing an agent that has already exited
   * never kills anything - the row just goes - and that is the case that left
   * the cards behind. The renderer calls this on every fire, running or not.
   */
  ipcMain.handle('agent:forget', (_e, id: string) => {
    approvals.clearSteers(id)
    approvals.clearPending(id)
    forgetAgent(id)
    return true
  })
  // Asked for once per terminal, when its buffer is first created. Applying a
  // floor reloads the window and leaves the agents that have a place on the new
  // one running, so the renderer comes back with an empty xterm attached to a
  // pty that has already printed everything it is going to.
  ipcMain.handle('pty:backlog', (_e, id: string) => ptys.backlog(id))
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

  /**
   * A turn that never ends has no event to hang this off.
   *
   * Everything else here is driven by something happening - a hook, a message,
   * an exit. The one failure with no event of its own is the one where nothing
   * happens at all, so it takes a clock. Unref'd, and `reportWhenQuiet` is
   * called after: writing a hung turn off is often exactly what makes the floor
   * quiet enough to report.
   */
  setInterval(() => {
    try {
      sweepHung()
      sweepUnclaimed()
      reportWhenQuiet()
    } catch (err) {
      console.error('[bullpen] hung-turn sweep failed:', err)
    }
    // Half the window it is watching for, capped at a minute: a sweep slower
    // than the thing it looks for would report a hung turn twice as late as it
    // had to, and one faster than a second is a clock for no reason.
  }, Math.min(Math.max(HUNG_MS / 2, 1_000), 60_000)).unref?.()

  /**
   * What this agent's CLI would start on with no flag from us.
   *
   * Read on demand rather than stored on the agent: it is a file on disk that
   * the operator may edit between one menu opening and the next, and a copy
   * taken at spawn would be the answer to a question nobody asked yet.
   */
  ipcMain.handle('agent:configModel', (_e, id: string, cmd: string, cwd: string) => {
    const fromFiles = configuredModel(cmd, cwd, app.getPath('home'))
    if (fromFiles) return fromFiles
    // Last: what the CLI itself printed when it came up. Nobody having written
    // a model down does not mean nobody knows which one is answering - it means
    // the only thing that does is the process, and it says so on its first
    // screen. See `bannerModel` for how narrow that read is.
    return bannerModel(ptys.backlog(id), engineFor(cmd).models)
  })
  ipcMain.handle('agent:ctx', (_e, id: string) => currentCtx(id))
  ipcMain.handle('agent:cost', (_e, id: string) => currentCost(id))
  ipcMain.handle('activity:list', (_e, limit?: number) => activity.list(limit))

  ipcMain.handle('ask:list', () => asks.pending())
  // Re-read on a reload: the report is the one thing on the monitor that did
  // not happen while this window was open.
  ipcMain.handle('report:list', () => reports)
  ipcMain.handle('dispatch:last', () => lastDispatch)
  ipcMain.handle('ask:answer', (_e, qid: string, answer: string) => {
    // Stamped, not deleted. The question, its wording and what was said back
    // are what somebody reads a day later to know what has already been decided.
    const q = asks.answer(qid, answer)
    if (!q) return false
    // The reply travels back through the hive, so the agent receives it exactly
    // as it receives any other message - no second delivery mechanism.
    // Under whatever this floor calls the human: the gate and the card rules
    // both match on it, and an answer that arrived from an address nothing
    // recognises is an answer the router treats as another agent's.
    hive.send({ from: wf.human, to: q.from, subject: `re: ${q.subject}`, body: answer })
    activity.push('answer', HUMAN, `you answered ${q.from}: ${q.subject}`)
    send('ask:pending', asks.pending())
    return true
  })
  ipcMain.handle('ask:dismiss', (_e, qid: string) => {
    if (!asks.dismiss(qid)) return false
    send('ask:pending', asks.pending())
    return true
  })
  /** Everything ever asked, answers and all, newest first. */
  ipcMain.handle('ask:history', () => asks.all())

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
    // The floor's starting column, not `todo`. A card typed in by hand is a
    // card like any other, and this used to store a key off a board that no
    // longer has one: the floor Bullpen ships starts at `asked`, so every
    // hand-added card landed in a column the board cannot draw and nothing
    // could move it out of.
    const t = board.addTask(id, text, column('start'))
    pushTasks()
    return t
  })
  /**
   * Say yes to a card: this one is work, start it.
   *
   * The board is a list until the operator says so, which is why this is its
   * own call rather than a flag on `addTask` - adding a card costs nothing and
   * this is the press that spends. Everything else released for this agent is
   * worked through after it, one card at a time, as each turn ends.
   */
  ipcMain.handle('board:release', (_e, taskId: string) => {
    const card = board.task(taskId)
    if (!card || !card.agentId) return false
    released.add(card.id)
    pump(card.agentId)
    return true
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
  /**
   * Fire one, past the two rules that suppress the real ones.
   *
   * `notify` says nothing while the window has focus and nothing twice in a few
   * seconds - both true of somebody standing in this dialog pressing the
   * button - so a test routed through it would answer by doing nothing, which
   * is the one answer that cannot be told apart from a broken setup. The switch
   * above is not consulted either: this is how you find out whether turning it
   * on would achieve anything.
   */
  ipcMain.handle('ui:notifyTest', () => {
    if (!Notification.isSupported()) {
      return { error: 'This machine does not show desktop notifications.' }
    }
    try {
      new Notification({
        title: 'Bullpen',
        body: 'Notifications are working. This is what one looks like.'
      }).show()
      return { ok: true as const }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
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
  hive.reserved = { human: wf.human, hire: wf.hire, board: BOARD_PARTY }

  // Before anything is spawned. A packaged mac app is handed launchd's PATH -
  // four system directories - and `claude` is in none of them, so every agent
  // would exit 1 having printed nothing and the terminal tab would just be
  // blank. See loginShellPath in ctx.ts for why this asks a shell.
  if (app.isPackaged && process.platform !== 'win32') {
    const shellPath = loginShellPath((cmd, args) =>
      execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
    )
    if (shellPath) process.env.PATH = mergePath(shellPath, process.env.PATH ?? '')
    else console.error('[bullpen] could not read PATH from the login shell; agents may not start')
  }

  approvals.setTheme(readConfig(BULLPEN_HOME).mode ?? 'light')
  await approvals.start()
  wire()
  createWindow()
  // Packaged only, and one updater per platform - see src/main/update.ts for
  // why macOS cannot use the same one Windows does.
  if (app.isPackaged) {
    try {
      if (process.platform === 'darwin') {
        const { loadSparkleBridgeForApp } = await import('electron-sparkle-updater')
        const bridge = await loadSparkleBridgeForApp((m) => console.log('[sparkle]', m))
        if (!bridge) throw new Error('the Sparkle bridge did not load')
        // The feed and the key are read back out of the bundle this is running
        // from, rather than compiled in: the plist is what CI actually stamped.
        const plist = join(dirname(app.getPath('exe')), '..', 'Info.plist')
        updates.attachSparkle(bridge, (key) => plistValue(plist, key))
      } else {
        const mod = await import('electron-updater')
        updates.attach({ app, autoUpdater: (mod.default ?? mod).autoUpdater })
      }
      updates.start()
    } catch (err) {
      // An app that cannot check for a newer version is an app that runs. This
      // is the last thing startup does for a reason. Said in the window too,
      // not only here: a silent updater and a working one look identical.
      console.error('[bullpen] the updater did not load:', err)
      updates.fail(err)
    }
  }
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
  updates.stop()
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
