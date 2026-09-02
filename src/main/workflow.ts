import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { lawOn, type Rules } from '../rules.ts'
import {
  BOARD_PARTY,
  CAPABILITY_KINDS,
  HIRE_PARTY,
  HUMAN_PARTY,
  type Capability,
  type CapabilityKind
} from '../workflow-spec.ts'

/**
 * A workflow is the shape of the floor: who exists, who may write to whom, what
 * each of them is told at spawn, and what a message between two of them does to
 * the task board.
 *
 * All four used to be code - a `Role` union, a `TALKS_TO` table, three brief
 * functions and a chain of if/else in the router - which meant the floor could
 * only ever run the one workflow its author happened to want. Somebody else's
 * floor has different people on it, and that is the whole reason this file
 * exists: the workflow is data, and the code reads it.
 */

/**
 * What a role does, as capabilities rather than a name.
 *
 * The router has to know what a message means without knowing what anyone is
 * called. "A builder reported to a planner" moves a card the same way whether
 * the roles are called dev/analyst or engineer/lead. A role may hold more than
 * one: on a small floor the same agent both talks to the human and hands out
 * the work, and a single label could not say that.
 *
 * Defined with the rest of the format in `workflow-spec.ts`, and re-exported
 * here so callers have one import for the whole of a workflow.
 */
export {
  CAPABILITY_KINDS,
  HIRE_PARTY,
  HUMAN_PARTY,
  type Capability,
  type CapabilityKind
}

/**
 * A capability this floor has, in this floor's own words.
 *
 * `drafts`, `edits`, `collects`, `cites` - whatever the work is actually
 * called. `kind` is what the floor does with it: a capability of kind `checks`
 * closes a card whether it is called `tests`, `reviews` or `proofreads`.
 */
export type CapabilityDef = {
  name: string
  what: string
  /**
   * Which of the four this word behaves like, when the floor says.
   *
   * Read again after being ignored for a while. The card rules say the same
   * thing and say it better - `drafts → proofs: in review` names both sides -
   * so this was a second copy that could disagree with them. But it is the only
   * thing a floor can say *before* there are any rules, and without it a floor
   * drawn from scratch cannot be asked who assigns or who checks: both answers
   * come from the rules, and the rules were what we were trying to derive.
   *
   * So it is consulted only when there are no card rules at all. A floor with
   * one written rule is read the way it always was, and the two can never
   * contradict each other because only one of them is ever asked.
   */
  kind?: CapabilityKind
}

/**
 * What one message does to the board, as a line the operator can change.
 *
 * `from` and `to` name a capability, a kind, a role, or one of `anyone`,
 * `staff` (anyone who is not the floor's voice) and `you` (the human). `status`
 * is a column key, or `open` to start a card and `closes` to finish one along
 * with the work it was checking. First matching line wins.
 */
export type CardRule = {
  from: string
  to: string
  /**
   * When this happens, in the operator's own words: "hands the work over",
   * "says it is built", "sends a problem back".
   *
   * The router does not read it - a message from one of these to one of those
   * is a message, and nothing inspects what it says. It is what the line is
   * labelled with on the chart, and what somebody reads to know why the rule
   * is there, which a table of froms and tos never said.
   */
  when?: string
  status: string
  /**
   * Whose card moves. The sender's, unless the line says otherwise: "checks →
   * builds: doing (their card)" is a bug going back, and the card that goes
   * back to doing belongs to the developer being written to, not the checker.
   */
  whose?: 'from' | 'to'
}

/**
 * What a column is for, as opposed to what it is called.
 *
 * A card lands in one of these without anybody sending a message: work starts
 * when an agent takes a turn, stops when it exits, and closes when the floor
 * says so. Those moments have to know which column they mean on a board whose
 * columns are the operator's, and five kinds is what the code outside the card
 * rules actually asks about.
 */
export const COLUMN_KINDS = ['start', 'working', 'waiting', 'stuck', 'done'] as const
export type ColumnKind = (typeof COLUMN_KINDS)[number]

/** One column: its id on the board, its name here, its colour, and its job. */
export type Column = { key: string; label: string; bar: string; kind?: ColumnKind }

/**
 * The board as Bullpen has always drawn it.
 *
 * These keys are what every `board.json` written before the columns were the
 * operator's has in it, which is why they stay the default names rather than
 * being renamed to their kinds.
 */
/**
 * The five column names Bullpen used to ship, kept only so a board that writes
 * `- doing: drafting` still gets a column that means "work has started". They
 * are not given to a floor that does not ask.
 */
export const KNOWN_COLUMNS: Column[] = [
  { key: 'todo', label: 'todo', bar: '#7fc7e8', kind: 'start' },
  { key: 'doing', label: 'doing', bar: '#e8cf6a', kind: 'working' },
  { key: 'wait_test', label: 'wait to test', bar: '#c9a2e8', kind: 'waiting' },
  { key: 'blocked', label: 'blocked', bar: '#e8917f', kind: 'stuck' },
  { key: 'done', label: 'done', bar: '#7fd8a0', kind: 'done' }
]

/**
 * The column that means `kind` on this floor, by key.
 *
 * Falls back to the default name for that kind, then to the first column: a
 * board with nowhere marked `stuck` still has to put an agent that died
 * somewhere, and losing the card is worse than putting it in the wrong place.
 */
export function columnFor(w: Workflow, kind: ColumnKind): string {
  const said = w.columns.find((c) => c.kind === kind)
  if (said) return said.key
  // No column marked for this, and none invented: a floor that has not said
  // where finished work goes has nowhere to put it, and quietly choosing one
  // is how the board came to disagree with the file.
  return w.columns[0]?.key ?? ''
}

/**
 * Where a role's fixed agent works.
 *
 * `~` is the operator's home, because that is how a person writes it, and a
 * role that says nothing works where dispatch works. Here rather than in main
 * because two places ask it - the spawn, and the check that decides whether the
 * one already running is in the right place - and they were not the same
 * question in code, which is what let an agent be killed and restarted on every
 * launch for standing exactly where it was told to.
 */
export function workCwd(w: Workflow, role: string, home: string, fallback: string): string {
  const said = w.roles[role]?.cwd?.trim()
  if (!said) return fallback
  return said.startsWith('~') ? join(home, said.slice(1)) : said
}

/** Whether this floor has a column for `kind` at all. */
export const hasColumn = (w: Workflow, kind: ColumnKind): boolean =>
  w.columns.some((c) => c.kind === kind)

/** The four kinds as capabilities, for a floor that declares none of its own. */
export const DEFAULT_CAPABILITIES: CapabilityDef[] = [
  { name: 'speaksToHuman', kind: 'speaksToHuman', what: 'may write to "you"' },
  { name: 'assigns', kind: 'assigns', what: 'hands work out and may hire' },
  { name: 'builds', kind: 'builds', what: 'does the work and reports when done' },
  { name: 'checks', kind: 'checks', what: 'decides whether it passes' }
]


export type RoleDef = {
  /** What this role does. Empty is legal but inert - it can only carry mail. */
  can: Capability[]
  /**
   * How a refusal names this role to the agent that tripped it: "the boss does
   * not write to a tester". Written to be read mid-sentence, article included.
   */
  label: string
  /**
   * What this role is for, in one sentence a person can read.
   *
   * Capabilities say what the router does with it; this says what the job is.
   * The two are not the same thing, and `assigns` on its own has never told
   * anybody what an analyst actually does with a request.
   */
  does?: string
  /**
   * A role with a fixed agent is part of the floor rather than staff on it: it
   * is spawned at launch under this exact id, and it cannot be fired. Roles
   * without one are hired into.
   */
  fixed?: { id: string; name: string }
  /** Whether the wizard and the `hire` address may create one of these. */
  hireable?: boolean
  /**
   * The command this role runs, when it is not the default `claude`.
   *
   * Written as it would be typed - `claude --model sonnet`, `codex` - and split
   * on spaces. A floor is not obliged to be one model: the role that only reads
   * and reports can run something cheaper than the role that writes the code.
   */
  cli?: string
  /**
   * Where this role's fixed agent works, when it is not where dispatch works.
   * `~` is expanded. Ignored for a hired role - those go where their project is.
   */
  cwd?: string
  /**
   * Tools this role never uses. Refused by the approvals layer, with the reason
   * naming the role - a proofreader that cannot run shell commands is a floor
   * rule, and saying it in the brief only asks the model to agree.
   *
   * Denial only. Nothing here can grant a tool, and none of the dangerous-shell
   * or credential-path checks can be turned off by a workflow.
   */
  never?: string[]
  /**
   * Anything else this floor wants to say about the role, as words of its own.
   *
   * `tone`, `max length`, `style guide`, `escalate to` - the app has no opinion
   * about any of them and never reads one. They are substituted into the brief
   * as `{{tone}}`, which is the whole point: a floor needs to tell its writers
   * things Bullpen has no business knowing, and the alternative was writing the
   * same sentence into four briefs by hand.
   */
  attrs?: Record<string, string>
  /**
   * What an agent of this role is told at spawn, appended to whatever its
   * CLAUDE.md says. `{{...}}` placeholders are filled by `renderBrief`.
   */
  brief: string
}

export type Workflow = {
  name: string
  /** One line, shown where a workflow is picked. */
  description: string
  /**
   * What this floor is for, in prose, for whoever opens it next. Not read by
   * anything at runtime - the router works off the roles and the rules.
   */
  summary?: string
  roles: Record<string, RoleDef>
  /**
   * Who may write to whom. Keys and values are role names, plus two addresses
   * that are not roles: `you` (the human) and `hire` (ask for a new agent).
   *
   * The chain is only a chain if the shortcuts are shut, and a briefing is
   * advice where this is enforcement - an agent that asks anyway gets the
   * message handed back with somewhere else to send it.
   */
  talksTo: Record<string, string[]>
  /** The role a task typed at the floor goes to first. */
  dispatch: string
  /** The role inbound work - webhooks, schedules - goes to. Often not dispatch. */
  entry: string
  /**
   * At or over this much context, an agent is no use for the next piece of
   * work and a new one is hired. The floor's one number.
   *
   * There were two - `reuseBelowPct` above it, for "somebody idle under this
   * takes work". That second number only meant anything while work was typed
   * straight at whoever was free: once the card became a queue and a busy
   * agent could be given the next job without losing the one in hand, "idle"
   * stopped being a threshold and went back to being a preference. Two numbers
   * to keep in step, one of which decided nothing.
   */
  hireAbovePct: number
  /** The capabilities this floor has words for. */
  capabilities: CapabilityDef[]
  /** What each column on the board is called here. */
  columns: Column[]
  /** What a message between two roles does to a card. First match wins. */
  cardRules: CardRule[]
  /**
   * Placeholders this floor adds, and what they stand for.
   *
   * `{{self.id}}` and the rest are Bullpen's, and they are about the floor. A
   * brief also has to say things about the work - which product, which team,
   * which style guide, when the deadline is - and those were only sayable by
   * writing them out in every brief that needed them.
   */
  words: Record<string, string>
  /** What the human is addressed as, and what asking for a new agent is called. */
  human: string
  hire: string
  /**
   * The role that reports to the human, when more than one may write there.
   * Empty means "whoever `talks to` allows", which on most floors is one role.
   */
  voice?: string
  /** What a hire is when nothing said which kind. Empty means the first hireable one. */
  hires?: string
  /**
   * This floor's own words for the three things a card rule can say that are
   * not the name of a column.
   *
   * A floor is written in whatever language its people work in - roles, board
   * columns, briefs and capabilities all already are. These three were not:
   * `opens a card`, `closes it` and `(their card)` were matched in English, so
   * a rule written `mở thẻ` was refused and the file could not be finished in
   * the language the rest of it was in. Absent means the format's own words,
   * which every floor written before this used.
   */
  says?: { open?: string; closes?: string; theirs?: string; when?: string }
}

/** What this floor calls a rule that opens a card, closes one, or moves theirs. */
export const saysOpen = (w: Pick<Workflow, 'says'>): string => w.says?.open?.trim() || 'opens a card'
export const saysCloses = (w: Pick<Workflow, 'says'>): string => w.says?.closes?.trim() || 'closes it'
export const saysTheirs = (w: Pick<Workflow, 'says'>): string => w.says?.theirs?.trim() || 'their card'
export const saysWhen = (w: Pick<Workflow, 'says'>): string => w.says?.when?.trim() || 'when'

/**
 * A blank left unfilled in the starter: `«Display Name»`.
 *
 * Its own brackets rather than `<...>`, because a brief is full of `<the task>`
 * and `<what you changed>` - those are instructions to the agent about what to
 * write in a message, and they belong there. A blank the operator was meant to
 * replace has to be distinguishable from a blank the agent is meant to fill.
 */
const BLANK = /«[^»]*»/

const partyLabel = (w: Workflow, party: string): string | null =>
  party === w.human ? 'the human' : party === w.hire ? 'hiring' : null

/**
 * What a capability behaves like, or null when the floor never declared it.
 *
 * A name that is itself one of the four kinds needs no declaration: `builds` is
 * a capability of kind `builds` on every floor that never said otherwise.
 */
/** Whether this role answers to a word, by its own name or a capability it has. */
const holds = (w: Workflow, role: string, word: string): boolean =>
  word === role || (w.roles[role]?.can ?? []).includes(word)

/**
 * Whether `role` answers to a word in a rule.
 *
 * Four things a rule may name, in the order somebody writing one would expect:
 * the role itself, a capability by the name this floor gave it, and the two
 * crowds - `anyone`, and `staff` for anyone who is not the floor's voice.
 *
 * Here rather than in `cards.ts`, where it was, because the linter has to ask
 * the same question the router will: a law about which lines a rule covers,
 * answered by a second reading of the word, is a law that passes floors the
 * router ignores and fails floors it does not.
 */
export function matches(w: Workflow, role: string, word: string): boolean {
  if (word === 'anyone') return true
  if (word === 'staff') return !rolesWith(w, 'speaksToHuman').includes(role)
  return holds(w, role, word)
}

/**
 * The four questions asked outside the card rules, answered from what the floor
 * already says rather than from a label on each capability.
 *
 * Capabilities used to carry a `kind` - which of four things the app should
 * treat them as - and it was a second copy of what the rest of the file already
 * said. Who talks to the human is in `talks to`. Who hands work out is whoever
 * a card rule says opens a card. Who decides it passed is whoever closes one.
 * Keeping the label meant a floor could contradict itself, and a floor with two
 * kinds of approval had to pretend they were the same kind.
 *
 * `holds` rather than `matches`: no crowds and no recursion. `matches` in the
 * router asks this, so this cannot ask that.
 */
export const rolesWith = (w: Workflow, kind: CapabilityKind): string[] => {
  const names = Object.keys(w.roles)
  /**
   * Who a rule of this shape names, or - on a floor that has written none -
   * whoever holds a word the floor declared as that kind.
   *
   * The rules are the better answer and they win whenever there are any: they
   * name both sides. But a floor drawn from scratch has none, and both of the
   * questions the derived rules need are answered by the rules - so a floor
   * with no rules could not be asked who assigns, and nothing it did reached
   * the board. The capability's own bracket is what it can be asked instead.
   */
  const declared = (kind: CapabilityKind): string[] =>
    names.filter((r) =>
      (w.roles[r]?.can ?? []).some((c) => w.capabilities.find((d) => d.name === c)?.kind === kind)
    )

  // Both, not one or the other. The rules were taken as the whole answer
  // whenever a floor had written any - and a floor can write rules and still
  // never write a `closes` one, which said nobody here decides anything passes
  // while its own file declared a capability `(checks)` and a role holding it.
  // Nothing closed, and the file read as though something would.
  const fromRules = (status: string): string[] => {
    const kind: CapabilityKind = status === 'open' ? 'assigns' : 'checks'
    const written = w.cardRules.length
      ? names.filter((r) => w.cardRules.some((rule) => rule.status === status && holds(w, r, rule.from)))
      : []
    return [...new Set([...written, ...declared(kind)])]
  }

  if (kind === 'speaksToHuman') {
    if (w.voice && w.roles[w.voice]) return [w.voice]
    return names.filter((r) => (w.talksTo[r] ?? []).includes(w.human))
  }
  if (kind === 'assigns') return fromRules('open')
  if (kind === 'checks') return fromRules('closes')

  // Whoever builds. Said outright when a capability declares itself `(builds)`,
  // which is the only one of the four that had no way to be said: the other
  // three are read off the lines and the rules, and this was whatever they did
  // not claim. So a floor whose analyst held a word of its own - one the rules
  // never name, because analysis moves a card rather than opening one - counted
  // the analyst as a builder: no tag on the roster, and the agent hired when
  // somebody asked for build work.
  const builders = declared('builds')
  if (builders.length) return builders

  // Nothing said it, so: what the floor hires by default, else everybody the
  // other three questions did not claim. Not "anybody hireable" - a tester is
  // hireable too, and calling it a builder made a pass read as a hand-in.
  if (w.hires && w.roles[w.hires]) return [w.hires]
  const taken = new Set([
    ...rolesWith(w, 'speaksToHuman'),
    ...rolesWith(w, 'assigns'),
    ...rolesWith(w, 'checks')
  ])
  const rest = names.filter((r) => !taken.has(r))
  return rest.length ? rest : names.filter((r) => w.roles[r].hireable)
}

/**
 * What a floor that has written no card rules of its own does to the board.
 *
 * Every one of these was a branch in `cards.ts` once. They moved into the file
 * so a floor of writers could say `drafts → proofs: in review` and have it mean
 * something - and then no floor shipped with any, so a floor out of the box
 * moved no cards at all and every arrow had to be written on by hand before
 * anything appeared on the board.
 *
 * They are back as a default rather than a branch: derived from who does what
 * and what the board's stages are for, consulted only when the floor has
 * written nothing, and beaten by any rule that is written. Roles are named
 * rather than capabilities, because the capability is whatever this floor
 * called it and the role is not.
 */
export function defaultCardRules(w: Workflow): CardRule[] {
  if (w.cardRules.length) return w.cardRules
  const voice = rolesWith(w, 'speaksToHuman')
  const assigns = rolesWith(w, 'assigns')
  const builds = rolesWith(w, 'builds')
  const checks = rolesWith(w, 'checks')
  const col = (kind: ColumnKind): string => columnFor(w, kind)
  const out: CardRule[] = []
  const add = (from: string, to: string, status: string, whose?: 'to'): void => {
    if (!from || !to || !status) return
    out.push({ from, to, status, ...(whose ? { whose } : {}) })
  }

  // Handing work over opens a card, whoever hands it over.
  for (const a of [...assigns, ...voice]) add(a, 'staff', 'open')
  // Built, and waiting on whoever decides it passed.
  for (const b of builds) for (const a of assigns) add(b, a, col('waiting'))
  for (const b of builds) for (const c of checks) add(b, c, col('waiting'))
  // Sent back: the card that moves is the builder's, not the checker's.
  for (const c of checks) for (const b of builds) add(c, b, col('working'), 'to')
  // Passed. This closes the work being checked as well as the checker's card.
  for (const c of checks) for (const a of assigns) add(c, a, 'closes')
  // And up, until somebody tells the human.
  for (const a of assigns) for (const v of voice) add(a, v, col('done'))
  for (const v of voice) add(v, w.human, col('done'))
  return out
}

/**
 * The rules the drawing itself says, one per line, by name.
 *
 * `defaultCardRules` answers "what does a floor that wrote nothing do", and it
 * answers in words - `assigns → staff` - because it has to hold for whoever
 * ends up holding those words. That is the right answer for a floor with no
 * rules and the wrong one to *write down*: `staff` is everybody who does not
 * answer the human, so it names pairs that have no line between them, and a
 * floor edited afterwards drifts from it silently.
 *
 * This writes the same shape as rules about roles, and only where a line
 * actually exists. What comes out is a `## card rules` section that matches the
 * drawing exactly, and goes on matching it because the next edit rewrites it.
 *
 * One rule per direction, first one wins - which is also how the router reads
 * them, so what is written is what will fire.
 */
/**
 * The same floor, with a word for the work on every role that had none.
 *
 * What a message does to a card is worked out from what each role may do, so a
 * role holding nothing is a role every line to it is silent about - the drawing
 * shows the hand-off, the briefs describe it, and the board never hears. A role
 * that says nothing about itself does the work: that is what a floor is for,
 * and it is the reading that makes the lines mean something.
 *
 * Only the empty ones. Anything written stays written, including a role
 * deliberately left inert on a floor whose rules name it by its own name.
 */
export function withWork(w: Workflow): Workflow {
  const builds = w.capabilities.find((c) => c.kind === 'builds')?.name
  if (!builds) return w
  const roles = Object.fromEntries(
    Object.entries(w.roles).map(([id, def]) => [
      id,
      (def.can ?? []).length ? def : { ...def, can: [builds] }
    ])
  )
  return { ...w, roles }
}

export function drawnCardRules(w: Workflow): CardRule[] {
  const talks = (a: string, b: string): boolean =>
    (w.talksTo[a] ?? []).includes(b) || (a === w.human && b === w.dispatch)
  const voice = rolesWith(w, 'speaksToHuman')
  const assigns = rolesWith(w, 'assigns')
  const builds = rolesWith(w, 'builds')
  // Whoever only checks. A role that hands work out *and* decides work passed -
  // an analyst who sizes a request and signs the result off - is the assigner
  // towards everybody it hands to, and writing the checker's rules for it said
  // the opposite: work sent down came back up as a card being returned.
  const checks = rolesWith(w, 'checks').filter((r) => !assigns.includes(r))
  const col = (kind: ColumnKind): string => columnFor(w, kind)
  /** Whether the board has a column for this at all. */
  const has = (kind: ColumnKind): boolean => w.columns.some((c) => c.kind === kind)

  const out: CardRule[] = []
  const taken = new Set<string>()
  const add = (from: string, to: string, status: string, whose?: 'to'): void => {
    if (!from || !to || !status || from === to) return
    if (!talks(from, to)) return
    const key = `${from}\u0000${to}`
    if (taken.has(key)) return
    taken.add(key)
    out.push({ from, to, status, ...(whose ? { whose } : {}) })
  }

  // The order is the order the router reads them in, so the narrow ones go
  // first: a role that both builds and checks would otherwise be caught by the
  // hand-out rule before anything about checking ever ran.
  for (const c of checks) for (const a of [...assigns, ...voice]) add(c, a, 'closes')
  // Only where the board has somewhere to put it. `columnFor` falls back to the
  // first column when a floor never said which one is which, and a rule that
  // sends finished work to the column new work lands in is worse than no rule.
  if (has('working')) for (const c of checks) for (const b of builds) add(c, b, col('working'), 'to')
  if (has('waiting')) {
    for (const b of builds) for (const c of checks) add(b, c, col('waiting'))
    for (const b of builds) for (const a of assigns) add(b, a, col('waiting'))
  }
  if (has('done')) for (const a of assigns) for (const v of voice) add(a, v, col('done'))
  // A builder reporting to whoever handed it out, on a floor with nobody to
  // check it. `wait to test` is the right answer where there is a checker and a
  // column to wait in; without either, built is as far as the work goes and the
  // card is done - and with neither rule written, a worker reporting finished
  // moved nothing at all and its card sat in `doing` forever.
  if (!has('waiting') && has('done')) {
    for (const b of builds) for (const a of [...assigns, ...voice]) add(b, a, col('done'))
  }
  // Handing work over opens a card, whoever hands it over and whoever to.
  for (const a of [...assigns, ...voice]) for (const r of Object.keys(w.roles)) add(a, r, 'open')
  // The human handing work to the floor opens the first card of all. Every rule
  // above is about one role writing to another, so the one message that starts
  // everything - somebody typing a task at the floor - was the one message that
  // put nothing on the board.
  add(w.human, w.dispatch, 'open')
  // And the last step of anything here: the human is told.
  if (has('done')) for (const v of voice) add(v, w.human, col('done'))

  /**
   * Anything still uncovered, so that no line drawn is silent.
   *
   * Everything above is a rule about a pair of capabilities - who assigns, who
   * builds, who checks - and a floor can be drawn whose lines those pairs do
   * not name: two builders working to each other, a role holding a word nobody
   * writes rules about. Those lines came out of `write it` with nothing on
   * them, which is a hand-off the board never hears about and nothing in the
   * file says so.
   *
   * Which way it goes is the only question left, and the drawing answers it:
   * towards somebody further from the operator, work is being handed over and a
   * card opens; back towards them, it is being reported and the card is done.
   */
  const depth = new Map<string, number>([[w.dispatch, 0]])
  for (const queue = [w.dispatch]; queue.length; ) {
    const here = queue.shift() as string
    for (const to of w.talksTo[here] ?? []) {
      if (!w.roles[to] || depth.has(to)) continue
      depth.set(to, (depth.get(here) ?? 0) + 1)
      queue.push(to)
    }
  }
  const far = (r: string): number => depth.get(r) ?? Number.MAX_SAFE_INTEGER
  for (const [from, tos] of Object.entries(w.talksTo)) {
    if (!w.roles[from]) continue
    for (const to of tos) {
      if (!w.roles[to] || to === from) continue
      if (taken.has(`${from}\u0000${to}`)) continue
      // Away from the operator, or level with them, work is being handed over.
      // Only a line that goes back *up* is a report. Level counted as a report
      // before, so two workers drawn side by side had the one who passed work
      // across marked as having finished it.
      if (far(to) >= far(from)) add(from, to, 'open')
      else if (has('done')) add(from, to, col('done'))
    }
  }
  return out
}

/** Whether what came back is a board at all: keys of its own, a start, an end. */
/**
 * A file with its `## card rules` section taken out.
 *
 * `write it` throws the model's rules away either way - the drawing decides
 * what a message does to a card - but the file was parsed before that happened,
 * and a model asked to leave the section alone copies the old rules back. Those
 * name the stages of the board it was in the same breath asked to replace, so
 * the whole file refused to read: `"done" is not a column on this board`.
 *
 * Its heading and every line under it, up to the next heading or the end.
 */
export const withoutCardRules = (markdown: string): string =>
  markdown.replace(/^##[ \t]+card rules\b[^\n]*\n(?:(?!^##[ \t])[^\n]*\n?)*/im, '')

/**
 * The floor's own `## how it works`, taken out of the text.
 *
 * Prose a model is shown is prose a model copies back. A redraft is handed the
 * drawing to write *about*, and the summary written for the floor it used to be
 * came back word for word on the floor it had become - a delivery team of six
 * whose "how it works" described a data analyst and a marketing worker that
 * were nowhere on it, read by everybody who opened the floor afterwards.
 *
 * The same answer as `## card rules`: it cannot copy what it was never shown.
 * The heading is matched the way the parser matches it, both spellings.
 */
export const withoutSummary = (markdown: string): string =>
  markdown.replace(/^##[ \t]+how (it|this floor) works\b[^\n]*\n(?:(?!^##[ \t])[^\n]*\n?)*/im, '')

export function isBoard(columns: Workflow['columns']): boolean {
  if (columns.length < 2) return false
  const keys = new Set(columns.map((c) => c.key))
  if (keys.size !== columns.length) return false
  if (columns.some((c) => !/^[\w-]+$/.test(c.key) || !c.label.trim())) return false
  return columns.some((c) => c.kind === 'start') && columns.some((c) => c.kind === 'done')
}

/**
 * What the floor no longer needs, taken out.
 *
 * A file grows things nobody uses and nothing says so: a capability declared
 * and held by no role, a column no rule can move a card into. Neither breaks
 * anything, which is why they survive every edit - and a floor read by
 * somebody new is read as though every line in it is load-bearing.
 *
 * Four kinds stay whatever the rules say, because a card reaches them without
 * one: work lands in `start`, handing it over moves the sender to `working`, a
 * blocked report is read off the subject into `stuck`, and `done` is where
 * anything ends.
 */
export function trimmed(w: Workflow): Workflow {
  const held = new Set(Object.values(w.roles).flatMap((r) => r.can))
  // A rule sends a card to a column by key, and a board can be rewritten under
  // it - renamed by hand, or written again for the work this floor actually
  // does. What is left is a rule naming a stage that is not there, and it does
  // not fail quietly: `toMarkdown` writes the key it was given, and the file it
  // wrote will not read back - `"done" is not a column on this board`.
  const keys = new Set(w.columns.map((c) => c.key))
  const cardRules = w.cardRules.filter(
    (r) => r.status === 'open' || r.status === 'closes' || keys.has(r.status)
  )
  const reached = new Set(cardRules.map((r) => r.status))
  // The four a card reaches without a rule naming it: work lands in `start`,
  // handing it over moves the sender to `working`, a blocked report is read
  // off the subject into `stuck`, and `done` is where anything ends. One of
  // each, because everything that asks "where does work in progress go" takes
  // the first - so a second column of the same kind is a stage no card can
  // reach unless a rule names it outright.
  const first = new Set<string>()
  const structural = (c: Workflow['columns'][number]): boolean => {
    if (c.kind !== 'start' && c.kind !== 'working' && c.kind !== 'stuck' && c.kind !== 'done') {
      return false
    }
    if (first.has(c.kind)) return false
    first.add(c.kind)
    return true
  }
  return {
    ...w,
    cardRules,
    capabilities: w.capabilities.filter((c) => held.has(c.name)),
    columns: w.columns.filter((c) => structural(c) || reached.has(c.key))
  }
}

export const can = (w: Workflow, role: string, kind: CapabilityKind): boolean =>
  rolesWith(w, kind).includes(role)

/**
 * Whether the floor *said* this role is one of the four, in its own file.
 *
 * `can` answers the router's question - who behaves like a checker here - and
 * reads the card rules as well as the capability table, so a role that closes a
 * card counts as one whether or not anybody wrote it down. That is the right
 * answer for moving cards and the wrong one for anything that asks who this
 * floor is *organised* around: a floor whose summariser opens one card for the
 * reviewer became, by that reading, a second person work could be handed to,
 * and dispatch was told to send every request to them.
 *
 * So: what the file declares, and nothing inferred.
 */
export const declares = (w: Workflow, role: string, kind: CapabilityKind): boolean =>
  (w.roles[role]?.can ?? []).some((c) => w.capabilities.find((d) => d.name === c)?.kind === kind)

/** True when this role holds that exact capability, by the name it was given. */
export const hasCapability = (w: Workflow, role: string, cap: string): boolean =>
  (w.roles[role]?.can ?? []).includes(cap)

/** The roles nobody can fire: they have a fixed agent and no way to re-hire. */
export const coreRoles = (w: Workflow): string[] =>
  Object.keys(w.roles).filter((r) => w.roles[r].fixed)

/** The agent id a fixed role runs under, or null when the role is hired into. */
export const fixedId = (w: Workflow, role: string): string | null =>
  w.roles[role]?.fixed?.id ?? null

/** The role a fixed agent id belongs to, or null. */
export const roleOfFixedId = (w: Workflow, id: string): string | null =>
  Object.keys(w.roles).find((r) => w.roles[r].fixed?.id === id) ?? null

const nameOf = (w: Workflow, party: string): string =>
  partyLabel(w, party) ?? w.roles[party]?.label ?? party

/**
 * Why this message is not going through, or null when it is.
 *
 * The reason is written for whoever sent it: it says where to send it instead,
 * because a refusal an agent cannot act on just becomes silence.
 */
export function refuseMail(w: Workflow, from: string, to: string): string | null {
  const allowed = w.talksTo[from]
  if (allowed?.includes(to)) return null
  const instead = (allowed ?? []).map((p) => nameOf(w, p)).join(', ')
  if (!instead) {
    return `On this floor ${nameOf(w, from)} writes to nobody. Nothing was delivered.`
  }
  return `On this floor ${nameOf(w, from)} does not write to ${nameOf(w, to)}. You write to: ${instead}. Send it there instead - it reaches the same person, through whoever is meant to see it first.`
}

/**
 * Fill a brief's placeholders.
 *
 * `{{self.id}}` / `{{self.name}}` - the agent being spawned.
 * `{{reportTo}}`                  - whoever the work comes back to.
 * `{{role.<name>.id}}` / `.name`  - a fixed role's agent, by role name.
 * `{{hireAbovePct}}`               - the one context number this floor has.
 *
 * `{{reuseBelowPct}}` is still filled, undocumented, with the same number: the
 * floor had two of them once and a brief on disk that still names the old one
 * would otherwise put `{{reuseBelowPct}}` verbatim into a real system prompt.
 *
 * An unknown placeholder is left standing rather than blanked: a brief that
 * reads `{{role.qa.id}}` in the agent's own terminal is a bug someone can see,
 * where an empty string is a brief that quietly tells it to mail nobody.
 */
/** An agent as the picker sees it: what it is, whether it is free, how full. */
export type Candidate = { id: string; role: string; idle: boolean; ctxPct?: number }

/**
 * Who takes a task handed to a role rather than to a person.
 *
 * Anybody in the role with room left, idle first and emptiest first within
 * that. Nobody eligible is not an error - it means hire, which is the caller's
 * job.
 *
 * There used to be two questions and two numbers: `pickForRole` for somebody
 * idle under `reuseBelowPct`, then `roomForRole` for anybody under
 * `hireAbovePct`. The first was written when work was typed straight at
 * whoever took it, where a second task landing mid-turn cost the first. Work
 * is queued on the taker's own card now, so a busy agent can hold the next
 * job without losing the one in hand - and "idle" went back to being a
 * preference rather than a threshold. What is left is one number: at or over
 * it, a window has too little room to work in, and that is a hire.
 *
 * An agent with no reading yet has not completed a turn, which is empty rather
 * than full: a fresh hire must be usable on the turn after it is made.
 */
export function pickForRole(w: Workflow, role: string, staff: Candidate[]): string | null {
  const room = staff.filter((a) => a.role === role && (a.ctxPct ?? 0) < w.hireAbovePct)
  if (!room.length) return null
  // Idle before busy, then emptiest: of two who can both take it, the one not
  // mid-turn starts sooner and the one with more window left finishes.
  const order = [...room].sort(
    (a, b) => Number(b.idle) - Number(a.idle) || (a.ctxPct ?? 0) - (b.ctxPct ?? 0)
  )
  return order[0].id
}

export function renderBrief(
  w: Workflow,
  role: string,
  vars: { id: string; name?: string; reportTo?: string }
): string {
  const brief = w.roles[role]?.brief ?? ''
  // Spaces allowed inside the braces: a floor's own word is whatever it calls
  // the thing - "escalate to", "max length" - and making people slug it would
  // be one more rule to remember for no reason the code has.
  return brief.replace(/\{\{([\w.\- ]+)\}\}/g, (whole, raw: string) => {
    const key = raw.trim()
    if (key === 'self.id') return vars.id
    if (key === 'self.name') return vars.name ?? vars.id
    if (key === 'reportTo') return vars.reportTo ?? ''
    // Kept, undocumented, for briefs written before the floor had one number.
    // A brief on disk that still says it would otherwise put `{{reuseBelowPct}}`
    // verbatim into a real agent's system prompt.
    if (key === 'reuseBelowPct') return String(w.hireAbovePct)
    if (key === 'hireAbovePct') return String(w.hireAbovePct)
    // The role's own words first, then the floor's - the narrower answer wins,
    // so a writer with its own `tone` is not overruled by the house one. Both
    // come after the built-ins: `{{self.id}}` cannot be redefined by a
    // workflow, because a brief that says it and gets somebody else's is a
    // message sent by the wrong agent.
    const own = w.roles[role]?.attrs
    if (own && key in own) return own[key]
    if (key in w.words) return w.words[key]
    const m = /^role\.([\w-]+)\.(id|name|label)$/.exec(key)
    if (m) {
      const def = w.roles[m[1]]
      if (!def) return whole
      if (m[2] === 'label') return def.label
      // A role with nobody standing in it is still an address: mail to the role
      // name is put in front of whoever is free, or somebody is hired. Leaving
      // the braces in the brief - which is what this did - put `{{role.ba.id}}`
      // in front of a model as if it were a name.
      if (!def.fixed) return m[2] === 'id' ? m[1] : def.label
      return m[2] === 'id' ? def.fixed.id : def.fixed.name
    }
    return whole
  })
}

/**
 * The placeholders in a brief that `renderBrief` would leave standing.
 *
 * Left standing is the right behaviour - an empty string is a brief that
 * quietly tells an agent to mail nobody - but it is only visible if somebody
 * opens that agent's terminal and reads its system prompt. A floor drawn by a
 * model invents them freely: `{{workdir}}` and `{{rules}}` read like things the
 * app would obviously know, and neither is, so every agent on that floor was
 * spawned being told to write its work to a directory called `{{workdir}}`.
 *
 * Kept in step with `renderBrief` by hand, which is a copy - but the copy is
 * one function long and the alternative is a linter that has to render a brief
 * to find out whether it is broken.
 */
export function unresolved(w: Workflow, role: string): string[] {
  const brief = w.roles[role]?.brief ?? ''
  const own = w.roles[role]?.attrs ?? {}
  const BUILT_IN = ['self.id', 'self.name', 'reportTo', 'reuseBelowPct', 'hireAbovePct']
  const out = new Set<string>()
  for (const m of brief.matchAll(/\{\{([\w.\- ]+)\}\}/g)) {
    const key = m[1].trim()
    if (BUILT_IN.includes(key) || key in own || key in w.words) continue
    const named = /^role\.([\w-]+)\.(id|name|label)$/.exec(key)
    if (named && w.roles[named[1]]) continue
    out.add(`{{${key}}}`)
  }
  return [...out]
}

/**
 * What is wrong with this workflow, as lines a person can act on.
 *
 * Worth having because every one of these fails silently at runtime: a role
 * nobody can reach never gets work, a floor with no way to the human does its
 * job and tells nobody, and a brief naming an address the router refuses puts
 * the agent in a loop of being handed its own message back. None of that shows
 * up as an error - it shows up as a floor that looks busy and finishes nothing.
 */
export function lint(w: Workflow, rules?: Rules): string[] {
  const bad: string[] = []
  const names = Object.keys(w.roles)
  if (names.length === 0) return ['A workflow needs at least one role.']

  /**
   * Whether a law is switched on.
   *
   * The rules file decides which of these run: take `must-open` out of it and
   * nothing checks that a card ever reaches the board. Given no rules at all -
   * a test, or a caller that has not loaded them - everything runs, because a
   * missing rulebook is not permission.
   *
   * What a failure *says* stays here rather than coming from the rules: the
   * rules say "nothing may name something that does not exist", and this can
   * say which line named what.
   */
  const on = (id: string): boolean => !rules || lawOn(rules, id)

  // Under this floor's names for them: a workflow that calls the human `boss`
  // has `talks to: boss`, and checking against `you` would call that a typo.
  const known = new Set([...names, w.human, w.hire])
  if (on('names-exist')) {
    for (const [from, tos] of Object.entries(w.talksTo)) {
      if (!w.roles[from]) bad.push(`talksTo names "${from}", which is not a role.`)
      for (const to of tos) {
        if (!known.has(to)) {
          bad.push(`"${from}" is allowed to write to "${to}", which does not exist.`)
        }
      }
    }
  }
  if (on('roles-are-complete')) {
    for (const r of names) {
      if (!w.talksTo[r]) bad.push(`"${r}" has no talksTo entry, so it can write to nobody.`)
      if (!w.roles[r].brief.trim()) {
        bad.push(`"${r}" has an empty brief - it will spawn knowing nothing.`)
      }
    }
  }

  if (on('names-exist')) {
    if (!w.roles[w.dispatch]) bad.push(`dispatch is "${w.dispatch}", which is not a role.`)
    if (!w.roles[w.entry]) bad.push(`entry is "${w.entry}", which is not a role.`)
  }
  if (on('dispatch-has-agent') && w.dispatch && !w.roles[w.dispatch]?.fixed) {
    bad.push(`"${w.dispatch}" takes the work typed at the floor, so it needs a fixed agent - there is nobody to give it to at launch.`)
  }
  /**
   * The boss has somebody to hand to.
   *
   * Dispatch is who a task typed at the floor goes to, and what that role is
   * for is deciding what happens to it - not doing it. A floor whose dispatch
   * writes only to the human is a floor where every task stops at the first
   * desk: it reads as finished drawing and does nothing, and the drawing gives
   * no hint of it, because the one line on it is the line back to you.
   *
   * `hire` does not count. Hiring is asking for somebody in a role, and on a
   * floor with no other role there is no role to ask for.
   */
  if (on('dispatch-hands-off') && w.roles[w.dispatch]) {
    const handsTo = (w.talksTo[w.dispatch] ?? []).filter((to) => w.roles[to] && to !== w.dispatch)
    if (handsTo.length === 0) {
      bad.push(
        `"${w.dispatch}" takes what is typed at the floor and can write to nobody but "${w.human}" - draw a line from it to whoever does the work.`
      )
    }
  }

  // Fixed or hireable: inbound work is put in front of whoever holds the role,
  // and somebody is hired when nobody does - so a role nobody stands in is only
  // a problem if nobody can be put in it either.
  if (
    on('dispatch-has-agent') &&
    w.entry &&
    !w.roles[w.entry]?.fixed &&
    w.roles[w.entry]?.hireable !== true
  ) {
    bad.push(`"${w.entry}" takes inbound work, and has neither an agent nor anyone to hire.`)
  }

  if (on('one-voice') && rolesWith(w, 'speaksToHuman').length === 0) {
    bad.push('Nobody can write to the human, so the floor can never report anything.')
  }
  if (on('builds-exist') && rolesWith(w, 'builds').length === 0) {
    bad.push('Nobody builds, so no task can ever be worked on.')
  }
  if (on('must-open') && rolesWith(w, 'assigns').length === 0 && rolesWith(w, 'builds').length > 0) {
    bad.push('Nobody assigns, so work reaches a builder only if the human hands it over directly.')
  }
  for (const r of rolesWith(w, 'speaksToHuman')) {
    if (!(w.talksTo[r] ?? []).includes(w.human)) {
      bad.push(`"${r}" is meant to speak to the human but talksTo does not allow "${w.human}".`)
    }
    // Being allowed to write to the human is not the same as being told to.
    // A floor whose voice is never instructed to report does all its work and
    // then says nothing - it looks busy and finishes in silence, which is the
    // failure the operator notices last.
    if (on('voice-is-told') && !new RegExp(`["']${w.human}["']`).test(w.roles[r].brief)) {
      bad.push(
        `"${r}" is the floor's voice but its brief never tells it to write to "${w.human}" - work would finish and the human would never hear.`
      )
    }
  }
  if (on('can-hire') && rolesWith(w, 'assigns').every((r) => !(w.talksTo[r] ?? []).includes(w.hire))) {
    if (rolesWith(w, 'assigns').length > 0) {
      bad.push('No role that assigns may "hire", so an empty floor can never staff itself.')
    }
  }

  // Reachability from dispatch: a role nothing routes to sits idle forever.
  const seen = new Set<string>([w.dispatch])
  const queue = [w.dispatch]
  while (queue.length) {
    for (const to of w.talksTo[queue.shift() as string] ?? []) {
      if (w.roles[to] && !seen.has(to)) {
        seen.add(to)
        queue.push(to)
      }
    }
  }
  // Hiring reaches any hireable role, whoever does the hiring.
  const hires = rolesWith(w, 'assigns').some((r) => (w.talksTo[r] ?? []).includes(w.hire))
  for (const r of names) {
    if (seen.has(r)) continue
    if (hires && w.roles[r].hireable) continue
    if (on('reachable')) {
      bad.push(`Nothing routes to "${r}" from "${w.dispatch}" - work can never reach it.`)
    }
  }

  /**
   * A brief whose braces are filled in.
   *
   * Anything the app does not know is left standing, so an invented placeholder
   * is not an error anywhere - it is a sentence in a real system prompt reading
   * `write it to {{workdir}}/spec.md`. The agent either asks what that means or,
   * worse, makes something up.
   */
  if (on('brief-placeholders')) {
    for (const r of names) {
      const left = unresolved(w, r)
      if (left.length) {
        bad.push(
          `"${r}" is briefed with ${left.join(', ')}, which nothing fills in - the agent is handed the braces themselves. Declare them under "## words" or take them out.`
        )
      }
    }
  }

  // A brief that names an address its own role may not use is a briefing the
  // router will spend the floor's time refusing.
  for (const r of names) {
    const allowed = new Set(w.talksTo[r] ?? [])
    for (const m of w.roles[r].brief.matchAll(/\{\{role\.([\w-]+)\.(?:id|name)\}\}/g)) {
      const target = m[1]
      if (on('brief-obeys-talks-to') && w.roles[target] && !allowed.has(target) && target !== r) {
        bad.push(`"${r}" is briefed to write to "${target}", which talksTo refuses.`)
      }
    }
  }

  // The floor's own vocabulary. A rule naming a word nothing answers to is a
  // rule that never fires, and a card that never moves is the kind of failure
  // that looks like an agent ignoring you.
  const capNames = new Set(w.capabilities.map((c) => c.name))
  if (on('unique-keys')) {
    for (const c of w.capabilities) {
      if (w.capabilities.filter((o) => o.name === c.name).length > 1) {
        bad.push(`"${c.name}" is declared twice under capabilities.`)
      }
    }
  }
  // A role's `can` names words this floor declared. The markdown parser refuses
  // an unknown one on the spot; a workflow that arrived as JSON has never been
  // past that, and the two have to agree on what is legal.
  if (on('names-exist')) {
    for (const r of names) {
      for (const c of w.roles[r].can) {
        if (!capNames.has(c)) {
          bad.push(`"${r}" can "${c}", which this floor never declared as a capability.`)
        }
      }
    }
  }

  const CROWDS = new Set(['anyone', 'staff'])
  const answersTo = (word: string): boolean =>
    CROWDS.has(word) ||
    Boolean(w.roles[word]) ||
    capNames.has(word) ||
    (CAPABILITY_KINDS as readonly string[]).includes(word)
  for (const rule of on('names-exist') ? w.cardRules : []) {
    // The human is a sender as well as an address. `to` was exempt and `from`
    // was not, so the one rule every floor has - somebody types a task and a
    // card opens - was reported as a rule that never fires, while the router
    // was firing it.
    if (rule.from !== w.human && !answersTo(rule.from)) {
      bad.push(`No role, capability or crowd answers to "${rule.from}", so "${rule.from} → ${rule.to}" never fires.`)
    }
    if (rule.to !== w.human && !answersTo(rule.to)) {
      bad.push(`No role, capability or crowd answers to "${rule.to}", so "${rule.from} → ${rule.to}" never fires.`)
    }
  }
  /**
   * Every line drawn, covered by a rule.
   *
   * A rule is what a message between two roles does to the board, and the rules
   * are worked out from what each role may do - so a floor whose roles hold no
   * capability, or hold the wrong one, gets rules for some of its lines and
   * none for the others. Nothing said so: the briefs told two agents to work
   * together, the drawing showed the line, and the board never heard about
   * either of them. Silence is what this is here to break.
   *
   * Only when the floor has written rules at all. One that has written none is
   * read through `defaultCardRules`, which answers in words and covers whoever
   * ends up holding them.
   */
  if (on('lines-have-rules') && w.cardRules.length) {
    const covers = (from: string, to: string): boolean =>
      w.cardRules.some(
        (r) =>
          (from === w.human ? r.from === w.human : matches(w, from, r.from)) &&
          (to === w.human ? r.to === w.human : matches(w, to, r.to))
      )
    // Between roles, not to and from the human. A floor whose first card opens
    // one hop in - the human hands over, the boss hands on, and that is the
    // card - is a floor somebody wrote on purpose; a hand-off between two
    // agents that moves nothing is not.
    const lines: [string, string][] = []
    for (const [from, tos] of Object.entries(w.talksTo)) {
      if (!w.roles[from]) continue
      for (const to of tos) if (w.roles[to] && to !== from) lines.push([from, to])
    }
    for (const [from, to] of lines) {
      if (!covers(from, to)) {
        bad.push(
          `Nothing says what a message from "${from}" to "${to}" does to the board, so that line moves no card.`
        )
      }
    }
  }

  // The rules this floor will actually run under, which is not the same as the
  // ones it wrote: a floor that writes none gets `defaultCardRules`, and since
  // the canvas stopped editing card rules that is most floors drawn by hand.
  // Asked of the written ones, this refused to save a drawing whose cards move
  // perfectly well.
  if (on('must-open') && !defaultCardRules(w).some((r) => r.status === 'open')) {
    bad.push('No card rule opens a card, so nothing this floor does will ever reach the board.')
  }

  /**
   * Closing a card is what a role that checks work does, and nothing else.
   *
   * `rolesWith` reads the card rules as well as the capability table - on
   * purpose, because a floor may declare `(checks)` and never write a `closes`
   * rule - and the other direction is where it bites: a floor that writes
   * `closes it` from a role holding no `(checks)` word has just made that role
   * a checker, and nothing anywhere says so. One came out declaring `(checks)`
   * on exactly one of six roles and running with four, its own summary line
   * saying only the reviewer could finish anything.
   *
   * What that buys the role is not a label. `closes` hands the router
   * `testerReported`, which closes the sender's card *and the work it was
   * checking* - and where no check was ever linked, that means every card
   * sitting in the waiting column for the project. A spec being handed in
   * closed every build that was queued for review.
   *
   * Only `closes`. Opening a card without declaring `(assigns)` is how most
   * dispatch roles are written and does no damage of its own.
   */
  if (on('closes-is-a-check')) {
    const CROWDS_TOO = new Set(['anyone', 'staff'])
    for (const rule of w.cardRules) {
      if (rule.status !== 'closes' || CROWDS_TOO.has(rule.from)) continue
      for (const r of names) {
        if (!matches(w, r, rule.from) || declares(w, r, 'checks')) continue
        bad.push(
          `"${rule.from} → ${rule.to}" closes a card, which is what a role that checks work does - but "${r}" holds no capability marked (checks), so it is counted as one anyway and can close work it never looked at. Mark its capability (checks), or move the card to a column instead.`
        )
      }
    }
  }

  /**
   * The card the operator opened has a way of closing.
   *
   * Dispatch gets a card the moment a task is typed at the floor, and only a
   * rule about what it says to the human ever moves that one. `lines-have-rules`
   * cannot see it - that check is deliberately about lines between two roles -
   * so a floor could cover every hand-off it draws and still leave the one card
   * the operator is actually looking at sitting in the first column through the
   * whole job and after it. Two floors in a row were written that way.
   */
  if (on('dispatch-reports') && w.cardRules.length && w.roles[w.dispatch]) {
    const tells = w.cardRules.some(
      (r) => r.to === w.human && (r.from === w.dispatch || matches(w, w.dispatch, r.from))
    )
    if (!tells) {
      bad.push(
        `Nothing says what happens to the card when "${w.dispatch}" tells "${w.human}" where the work stands, so the task typed at the floor never leaves the board.`
      )
    }
  }

  /**
   * Every card a rule moves was opened, and every card opened can close.
   *
   * `cardTo` returns on the spot when the agent it names holds no open card, so
   * a rule that moves a card nobody was ever given is not an error anywhere -
   * it is a line in the file, an arrow on the chart, and nothing at all on the
   * board. One floor came out with twelve of its thirteen rules like that: the
   * only `opens a card` on it went to the role that writes the spec, and the
   * six columns after that one were unreachable, the column marked (working)
   * among them.
   *
   * The other half is the same failure read backwards. The one card that floor
   * did open had no rule that ever finished it, so every request left a card
   * parked in "writing the spec" for good - which is exactly what "the agents
   * keep making cards and nothing ever closes" looks like from the chair the
   * operator is sitting in.
   *
   * `closes it` is exempt from the first half on purpose: it hands the router
   * `testerReported`, which falls back to sweeping the waiting column when the
   * checker holds no card of its own, and that is how the floors here are
   * written.
   */
  if (on('cards-open-and-close') && w.cardRules.length) {
    const doneKey = hasColumn(w, 'done')
      ? columnFor(w, 'done')
      : (w.columns.find((c) => c.key === 'done')?.key ?? null)
    // On a floor where nobody checks, a rule pointing at the column work waits
    // in finishes the card instead - the same swap the router makes.
    const waitingIsDone =
      hasColumn(w, 'waiting') && rolesWith(w, 'checks').length === 0
        ? columnFor(w, 'waiting')
        : null
    /** Whose card this rule moves: the sender's, unless the line says otherwise. */
    const moved = (rule: CardRule): string => (rule.whose === 'to' ? rule.to : rule.from)
    /** The roles one side of a rule stands for. The human holds no card. */
    const holders = (side: string): string[] =>
      side === w.human ? [] : names.filter((r) => matches(w, r, side))

    // Dispatch is handed one the moment a task is typed at the floor.
    const opened = new Set<string>(w.roles[w.dispatch] ? [w.dispatch] : [])
    for (const rule of w.cardRules) {
      if (rule.status === 'open') for (const r of holders(rule.to)) opened.add(r)
    }

    for (const rule of w.cardRules) {
      if (rule.status === 'open' || rule.status === 'closes') continue
      const who = holders(moved(rule))
      if (!who.length || who.some((r) => opened.has(r))) continue
      bad.push(
        `"${rule.from} → ${rule.to}" moves ${who.map((r) => `"${r}"`).join(' or ')}'s card, and nothing ever opens one - so the line moves nothing. Open a card where the work is handed over, or add "(their card)" to move the other side's instead.`
      )
    }

    /**
     * Whose card a `closes it` finishes: the checker's, and the build's.
     *
     * `testerReported` closes the sender's own card and then the work it was
     * checking - by the `checks` link where the hand-over wrote one, and by
     * sweeping the waiting column where it did not. So the card a checker
     * finishes is whichever one a rule parks in that column, and reading only
     * the sender would have called every floor here broken: `tester → dev:
     * closes it` is the one line that ever finishes the developer's card.
     */
    const waiting = hasColumn(w, 'waiting') ? columnFor(w, 'waiting') : null
    const swept = new Set<string>()
    for (const rule of w.cardRules) {
      if (waiting !== null && rule.status === waiting) {
        for (const r of holders(moved(rule))) swept.add(r)
      }
    }
    const finishes = (rule: CardRule, r: string): boolean =>
      rule.status === 'closes'
        ? holders(rule.from).includes(r) || swept.has(r)
        : (rule.status === doneKey || rule.status === waitingIsDone) &&
          holders(moved(rule)).includes(r)
    for (const r of opened) {
      if (w.cardRules.some((rule) => finishes(rule, r))) continue
      bad.push(
        `"${r}" is given a card and no rule ever finishes it, so every task leaves one behind on the board. Point one of its lines at "${doneKey ?? 'the done column'}", or let a role that checks work close it.`
      )
    }
  }

  /**
   * Every role holds at least one word the app can read.
   *
   * The name of a capability is the floor's and the bracket is the app's: "who
   * hands work out", "who does it", "who decides it passed" and "who answers
   * the human" are asked of every floor there is, and a role holding nothing
   * but unbracketed words answers none of them - so `rolesWith` classifies it
   * by what is left over. A floor came back having bracketed one capability of
   * six: its coordinator was counted as the builder because that is the role it
   * hires by default, and the three roles that actually spec, plan and build
   * counted as nothing at all - hired for the wrong work and tagged on the
   * roster as something they are not. The board still moved, because card rules
   * name roles outright; nothing anywhere said the rest of the file had stopped
   * meaning anything.
   *
   * Per role, not per capability. A word with no bracket that sits beside one
   * that has it is a name for the card rules to match on and classifies
   * nothing - `- cites — used by the rules, and by nothing else` is a floor
   * saying so on purpose. It is a role with no bracket anywhere that the app
   * cannot place.
   */
  if (on('capabilities-have-kinds')) {
    const KINDS = new Set<string>(CAPABILITY_KINDS)
    // A capability named for one of the four says which it is by saying it.
    const kindOf = (name: string): string | undefined =>
      w.capabilities.find((c) => c.name === name)?.kind ?? (KINDS.has(name) ? name : undefined)
    for (const r of names) {
      const can = w.roles[r].can ?? []
      if (!can.length || can.some((c) => kindOf(c))) continue
      bad.push(
        `"${r}" holds ${can.map((c) => `"${c}"`).join(', ')}, and not one of them says in brackets which of the four it behaves like - so nothing can ask whether this role hands work out, does it, checks it or answers the human, and it is classified by whatever is left over. Write one of (speaksToHuman), (assigns), (builds) or (checks) after the name.`
      )
    }
  }

  if (on('must-finish') && w.columns.length === 0) bad.push('A board needs at least one column.')
  for (const c of w.columns) {
    if (on('unique-keys') && w.columns.filter((o) => o.key === c.key).length > 1) {
      bad.push(`Two columns share the key "${c.key}" - a card can only be in one of them.`)
    }
    if (!c.key.trim()) bad.push('A column with no key cannot hold a card.')
  }
  // "The card an agent is on" is "its newest that is not finished", so a board
  // with nothing marked done has every card read as live work forever - and the
  // agent never gets another one, because it already has one open.
  if (on('must-finish') && w.columns.length > 0 && !hasColumn(w, 'done') && !w.columns.some((c) => c.key === 'done')) {
    bad.push('No column is marked (done), so nothing on this board can ever be finished.')
  }

  if (on('addresses-are-not-roles')) {
    if (w.human === w.hire) bad.push('The human and hiring cannot share one address.')
    // `BOARD_PARTY` with them: the router checks the reserved names before it
    // looks for an agent, so a role called `board` is a role nothing can reach
    // and every message meant for it lands on the task list instead.
    for (const address of [w.human, w.hire, BOARD_PARTY]) {
      if (w.roles[address]) bad.push(`"${address}" is both a role and a reserved address.`)
    }
  }

  if (on('thresholds-ordered') && !(w.hireAbovePct > 0 && w.hireAbovePct <= 100)) {
    bad.push('The hire threshold must satisfy 0 < hireAbovePct <= 100.')
  }

  // The starter is a form with the answers left out, and the blanks look like
  // ordinary prose once they are three screens up: `<what this one does>` would
  // be handed to a real agent as its standing instruction, and it would follow
  // it. Named here rather than left to be noticed.
  const blank = (text: string): string | null =>
    on('no-blanks') ? (BLANK.exec(text)?.[0] ?? null) : null
  if (blank(w.name)) bad.push(`The workflow still has "${blank(w.name)}" for its name.`)
  if (blank(w.description)) {
    bad.push(`The description still has "${blank(w.description)}" in it.`)
  }
  for (const r of names) {
    const inBrief = blank(w.roles[r].brief)
    if (inBrief) bad.push(`"${r}" still has "${inBrief}" in its brief - that is what it is told.`)
    const inDoes = w.roles[r].does && blank(w.roles[r].does as string)
    if (inDoes) bad.push(`"${r}" still has "${inDoes}" for what it does.`)
    const inFixed = w.roles[r].fixed && blank(`${w.roles[r].fixed?.id} ${w.roles[r].fixed?.name}`)
    if (inFixed) bad.push(`"${r}" still has "${inFixed}" for its agent.`)
  }
  return [...new Set(bad)]
}

/**
 * Read an unknown blob as a workflow, or say why it is not one.
 *
 * Hand-edited JSON is the point of this file, so a bad shape has to come back
 * as a sentence rather than a crash on the first missing field.
 */
/**
 * A percentage, or the one that was already there.
 *
 * The two context thresholds arrive from a number input, and an input somebody
 * has cleared hands back `NaN`. Stored, it made `pickForRole` compare against
 * it - every comparison false, so nobody was ever free and every hand-off hired
 * somebody new - and put "reuse one whose ctxPct is under NaN" into a brief a
 * real agent then tried to follow.
 */
export const pctOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(1, Math.round(v))) : fallback

export function parseWorkflow(raw: unknown): { workflow: Workflow } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'A workflow must be a JSON object.' }
  const o = raw as Record<string, unknown>
  if (typeof o.name !== 'string' || !o.name.trim()) return { error: 'A workflow needs a name.' }
  if (!o.roles || typeof o.roles !== 'object') return { error: 'A workflow needs a "roles" object.' }

  const roles: Record<string, RoleDef> = {}
  for (const [key, v] of Object.entries(o.roles as Record<string, unknown>)) {
    if (!/^[\w-]+$/.test(key)) return { error: `Role name "${key}" must be letters, digits, - or _.` }
    if (!v || typeof v !== 'object') return { error: `Role "${key}" must be an object.` }
    const d = v as Record<string, unknown>
    // Whatever the floor calls its work. Which names exist is checked against
    // the floor's own `## capabilities` by `lint`, not against a list here.
    const can = Array.isArray(d.can) ? d.can.filter((c): c is Capability => typeof c === 'string') : []
    if (typeof d.brief !== 'string') return { error: `Role "${key}" needs a "brief" string.` }
    let fixed: RoleDef['fixed']
    if (d.fixed !== undefined) {
      const f = d.fixed as Record<string, unknown>
      if (!f || typeof f !== 'object' || typeof f.id !== 'string' || !/^[\w-]+$/.test(f.id)) {
        return { error: `Role "${key}" has a "fixed" without a usable id.` }
      }
      fixed = { id: f.id, name: typeof f.name === 'string' && f.name.trim() ? f.name : f.id }
    }
    roles[key] = {
      can,
      label: typeof d.label === 'string' && d.label.trim() ? d.label : key,
      brief: d.brief,
      ...(typeof d.does === 'string' && d.does.trim() ? { does: d.does.trim() } : {}),
      ...(typeof d.cli === 'string' && d.cli.trim() ? { cli: d.cli.trim() } : {}),
      ...(typeof d.cwd === 'string' && d.cwd.trim() ? { cwd: d.cwd.trim() } : {}),
      ...(Array.isArray(d.never) && d.never.every((t) => typeof t === 'string')
        ? { never: d.never as string[] }
        : {}),
      ...(d.attrs && typeof d.attrs === 'object'
        ? {
            attrs: Object.fromEntries(
              Object.entries(d.attrs as Record<string, unknown>).filter(
                ([, v]) => typeof v === 'string'
              ) as [string, string][]
            )
          }
        : {}),
      ...(fixed ? { fixed } : {}),
      ...(d.hireable === true ? { hireable: true } : {})
    }
  }

  const talksTo: Record<string, string[]> = {}
  for (const [from, v] of Object.entries((o.talksTo ?? {}) as Record<string, unknown>)) {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      return { error: `talksTo["${from}"] must be a list of names.` }
    }
    talksTo[from] = [...new Set(v as string[])]
  }

  const pct = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback

  const caps = Array.isArray(o.capabilities)
    ? (o.capabilities as CapabilityDef[])
        .filter((c) => c && typeof c.name === 'string')
        .map((c) => ({
          name: c.name,
          what: typeof c.what === 'string' ? c.what : '',
          ...((CAPABILITY_KINDS as readonly string[]).includes(c.kind ?? '') ? { kind: c.kind } : {})
        }))
    : []
  const cols = Array.isArray(o.columns)
    ? (o.columns as Column[]).filter((c) => c && typeof c.key === 'string' && c.key.trim())
    : []
  const rules = Array.isArray(o.cardRules)
    ? (o.cardRules as CardRule[]).filter(
        (r) => r && typeof r.from === 'string' && typeof r.to === 'string' && typeof r.status === 'string'
      )
    : []

  const workflow: Workflow = {
    name: o.name.trim(),
    description: typeof o.description === 'string' ? o.description : '',
    roles,
    talksTo,
    capabilities: caps,
    columns: cols,
    cardRules: rules,
    words:
      o.words && typeof o.words === 'object'
        ? Object.fromEntries(
            Object.entries(o.words as Record<string, unknown>).filter(
              ([, v]) => typeof v === 'string'
            ) as [string, string][]
          )
        : {},
    human: typeof o.human === 'string' && o.human.trim() ? o.human.trim() : HUMAN_PARTY,
    hire: typeof o.hire === 'string' && o.hire.trim() ? o.hire.trim() : HIRE_PARTY,
    ...(typeof o.voice === 'string' && o.voice.trim() ? { voice: o.voice.trim() } : {}),
    ...(typeof o.hires === 'string' && o.hires.trim() ? { hires: o.hires.trim() } : {}),
    ...(o.says && typeof o.says === 'object'
      ? {
          says: Object.fromEntries(
            Object.entries(o.says as Record<string, unknown>).filter(
              ([k, v]) =>
                ['open', 'closes', 'theirs', 'when'].includes(k) && typeof v === 'string' && v.trim()
            )
          ) as Workflow['says']
        }
      : {}),
    dispatch: typeof o.dispatch === 'string' ? o.dispatch : Object.keys(roles)[0] ?? '',
    entry: typeof o.entry === 'string' ? o.entry : typeof o.dispatch === 'string' ? o.dispatch : '',
    hireAbovePct: pct(o.hireAbovePct, 70)
  }
  return { workflow }
}

/**
 * A workflow, written the way a person would write one.
 *
 * JSON was the wrong surface for this. Three of the fields are short - who
 * exists, who writes to whom - and the fourth is several paragraphs of prose
 * per role, which in JSON becomes one string with `\n\n` in it. That is the
 * part somebody customising a floor actually has to write, and it was the part
 * the format made hardest.
 *
 * The cast comes first, then the briefs:
 *
 * ```markdown
 * # my-floor
 * One line about how work moves here.
 *
 * - hire above: 70
 *
 * ## roles
 *
 * ### boss · the boss
 * - agent: michael · Michael
 * - can: speaksToHuman
 * - does: takes what you dispatch, hands it to the lead, and reports back to you
 * - talks to: lead, you
 * - dispatch
 *
 * ## briefs
 *
 * ### boss
 * You are {{self.name}}, and you stand in for the person running this floor.
 * ...the rest of the brief, as many paragraphs as it needs...
 * ```
 *
 * Roles before prose, because that order is what makes the file readable: the
 * first thing a person needs from a workflow is who is on this floor and what
 * each of them is for, and that answer used to be four definitions buried under
 * four pages of instructions. The original single-section form - `## role` with
 * its bullets and then its brief - is still read, so nothing saved before this
 * stopped opening.
 */
export function parseMarkdown(text: string): { workflow: Workflow } | { error: string } {
  // HTML comments come out first. The starter template teaches the format by
  // annotating itself, and without this every note in it would be swept into
  // the brief of whichever role it sat under - and handed to a real agent.
  const lines = text
    .replace(/\r\n?/g, '\n')
    // A comment on a line of its own takes the line with it. Left behind as a
    // blank it ended the bullet block early, and every bullet under it - `-
    // dispatch` among them - was read as the first line of the brief. The file
    // parsed; the workflow it described was not the one on screen.
    .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\n/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')

  const title = lines.findIndex((l) => /^#\s+\S/.test(l))
  if (title === -1) return { error: 'Start with `# <workflow name>` on its own line.' }
  const name = lines[title].replace(/^#\s+/, '').trim()

  // Both heading levels, because which one names a role depends on the form:
  // `## roles` / `### <role>` in the two-part shape, `## <role>` in the old one.
  type Head = { at: number; level: number; text: string }
  const heads: Head[] = []
  lines.forEach((l, i) => {
    const m = /^(#{2,3})\s+(\S.*)$/.exec(l)
    if (m) heads.push({ at: i, level: m[1].length, text: m[2].trim() })
  })
  if (heads.length === 0) {
    return { error: 'Add at least one role, as `### <role name>` under `## roles`.' }
  }

  const header = lines.slice(title + 1, heads[0].at)
  const description = header.find((l) => l.trim() && !l.trim().startsWith('-'))?.trim() ?? ''

  /** `- key: value` out of a block of lines, case- and spacing-insensitive. */
  const field = (block: string[], key: string): string | null => {
    const re = new RegExp(`^\\s*[-*+]\\s*${key}\\s*:\\s*(.+)$`, 'i')
    for (const l of block) {
      const m = re.exec(l)
      if (m) return m[1].trim()
    }
    return null
  }
  /** A bare `- flag` with no value. */
  const flag = (block: string[], word: string): boolean =>
    block.some((l) => new RegExp(`^\\s*[-*+]\\s*${word}\\s*$`, 'i').test(l))

  // `Number('')` is 0, not NaN, so a missing field has to be caught before the
  // conversion - otherwise every unset threshold reads as zero and lints as
  // out of range.
  const num = (v: string | null, fallback: number): number => {
    if (v === null || !v.trim()) return fallback
    const n = Number(v.replace('%', '').trim())
    return Number.isFinite(n) ? Math.round(n) : fallback
  }

  const list = (v: string | null): string[] =>
    (v ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)

  // `### boss · the boss` - the part after the separator is the label used in
  // refusals ("the boss does not write to a tester").
  const nameOfHead = (head: string): string => head.split(/\s+[·|]\s+/)[0].trim()

  const ROLES_SECTION = /^roles?\b/i
  const BRIEFS_SECTION = /^briefs?\b/i
/**
 * The section a floor is described in, in the operator's own words.
 *
 * Everything else in the file is what the router reads. This is the one part
 * written for whoever opens the floor next - the drawing says who writes to
 * whom, and nothing anywhere said what the floor is for.
 */
const HOW_SECTION = /^how (it|this floor) works\b/i
  // Sections that describe the floor rather than the people on it. Named here
  // so neither form mistakes one for a role called "board".
  const CAPS_SECTION = /^capabilit(y|ies)\b/i
  const WORDS_SECTION = /^words?\b/i
  const BOARD_SECTION = /^(board|columns?)\b/i
  const RULES_SECTION = /^card[\s-]*rules?\b/i
  const aside = (t: string): boolean =>
    CAPS_SECTION.test(t) || BOARD_SECTION.test(t) || RULES_SECTION.test(t) || WORDS_SECTION.test(t)
  const twoPart = heads.some((h) => h.level === 2 && ROLES_SECTION.test(h.text))

  /** The bullet lines under a top-level section, by which section it is. */
  const asides: Record<string, string[]> = {}
  heads.forEach((h, k) => {
    if (h.level !== 2 || !aside(h.text)) return
    const body = lines.slice(h.at + 1, heads[k + 1]?.at ?? lines.length)
    const key = CAPS_SECTION.test(h.text)
      ? 'caps'
      : BOARD_SECTION.test(h.text)
        ? 'board'
        : WORDS_SECTION.test(h.text)
          ? 'words'
          : 'rules'
    asides[key] = [...(asides[key] ?? []), ...body]
  })

  /** What the floor is for, when the file says. Prose, kept as written. */
  const howHead = heads.find((h) => h.level === 2 && HOW_SECTION.test(h.text))
  const summary = howHead
    ? lines
        .slice(
          howHead.at + 1,
          heads.find((h) => h.level === 2 && h.at > howHead.at)?.at ?? lines.length
        )
        .join('\n')
        .trim()
    : ''

  /** One role's heading and everything under it, in either form. */
  const blocks: { head: string; body: string[] }[] = []
  /** Briefs written apart from the definitions, by role name. */
  const briefs: Record<string, string> = {}

  if (!twoPart) {
    const tops = heads.filter((h) => h.level === 2 && !aside(h.text))
    tops.forEach((h, k) =>
      blocks.push({ head: h.text, body: lines.slice(h.at + 1, tops[k + 1]?.at ?? lines.length) })
    )
  } else {
    // The cast first, so the second pass knows which `###` names a role.
    let section = ''
    heads.forEach((h, k) => {
      if (h.level === 2) {
        section = ROLES_SECTION.test(h.text) ? 'roles' : BRIEFS_SECTION.test(h.text) ? 'briefs' : ''
        return
      }
      if (section === 'roles') {
        blocks.push({ head: h.text, body: lines.slice(h.at + 1, heads[k + 1]?.at ?? lines.length) })
      }
    })

    const named = new Set(blocks.map((b) => nameOfHead(b.head)))
    let current = ''
    let from = 0
    const keep = (end: number): void => {
      if (!current) return
      const text = lines.slice(from, end).join('\n').trim()
      briefs[current] = briefs[current] ? `${briefs[current]}\n\n${text}` : text
      current = ''
    }
    section = ''
    for (const h of heads) {
      if (h.level === 2) {
        keep(h.at)
        section = ROLES_SECTION.test(h.text) ? 'roles' : BRIEFS_SECTION.test(h.text) ? 'briefs' : ''
        continue
      }
      if (section !== 'briefs') continue
      // A `###` inside a brief that is not one of the role names is part of
      // that brief: briefs are prose, and prose is allowed its own headings.
      const key = nameOfHead(h.text)
      if (!named.has(key)) continue
      keep(h.at)
      current = key
      from = h.at + 1
    }
    keep(lines.length)
  }

  if (blocks.length === 0) {
    return { error: 'No roles found. Define them as `### <role name>` under `## roles`.' }
  }

  // `- drafts (builds) — writes the first version`. The kind in brackets is what
  // the floor does with it; without one, the name has to be a kind itself.
  const CAP_LINE = /^\s*[-*+]\s*([\w-]+)\s*(?:\(([\w]+)\))?\s*(?:[—–·:-]+\s*(.*))?$/
  const capabilities: CapabilityDef[] = []
  for (const line of asides.caps ?? []) {
    const m = CAP_LINE.exec(line)
    if (!m) continue
    // `- drafts (builds) — writes the first version`. What the floor does with
    // the word, for a floor that has not written any card rules yet. Anything
    // in the brackets that is not one of the four is ignored rather than
    // refused: a floor written before this still opens.
    const kind = (CAPABILITY_KINDS as readonly string[]).includes(m[2] ?? '')
      ? (m[2] as CapabilityKind)
      : undefined
    capabilities.push({ name: m[1], what: (m[3] ?? '').trim(), ...(kind ? { kind } : {}) })
  }

  // `- in_review: In review #c9a2e8 (waiting)`. The key is this board's own -
  // it is what a card is stored under - and the kind in brackets is what the
  // floor uses the column for when nobody sent a message.
  // The label is whatever is left once the colour and the kind have been taken
  // off the end - not "anything that is not a # or a bracket". Excluding them
  // meant a column called `C# work` or `to #do` matched nothing at all and was
  // dropped without a word, taking the board's starting column with it.
  const COL_LINE =
    /^\s*[-*+]\s*([\w-]+)\s*[:·—–]\s*(.*?)\s*(#[0-9a-fA-F]{3,8})?\s*(?:\(([\w]+)\))?\s*$/
  const written: Column[] = []
  for (const line of asides.board ?? []) {
    const m = COL_LINE.exec(line)
    if (!m) continue
    const kind = m[4] as ColumnKind | undefined
    if (kind && !(COLUMN_KINDS as readonly string[]).includes(kind)) {
      return { error: `Column "${m[1]}" is for "${kind}", which is not one of: ${COLUMN_KINDS.join(', ')}.` }
    }
    // A column called `todo` or `done` gets its job without being told, because
    // that is what those words mean and every board written before this used
    // them. Anything else says what it is for or is just a column.
    const fallback = KNOWN_COLUMNS.find((c) => c.key === m[1])
    written.push({
      key: m[1],
      label: m[2].trim() || fallback?.label || m[1],
      bar: m[3] ?? fallback?.bar ?? '#7fc7e8',
      // A column that says nothing about its job still has one when its key is
      // a name Bullpen already knows - which is what keeps `- doing: drafting`
      // meaning the column work starts in.
      ...(kind ? { kind } : fallback?.kind ? { kind: fallback.kind } : {})
    })
  }
  // What the file says, and nothing else. A floor used to be handed four
  // capabilities, five columns and eight card rules it never asked for, which
  // made "what does this floor do" a question you could not answer by reading
  // it - half the answer was in the source.
  const columns: Column[] = written

  /**
   * A column by its key or by whatever this floor calls it.
   *
   * Both sides flattened, which they were not: the word a rule uses had its
   * spaces and hyphens folded and the key it was compared against did not, so a
   * board declaring `- cho-mo-xe: chờ mở xe` refused `- dev → boss: cho-mo-xe`
   * - the file naming its own column by the key it had just given it, and being
   * told that is not a column on this board. Nothing about the message hinted
   * that the two spellings were the same word; the floor simply would not save,
   * and the fix was to go back and pick a key with no hyphen in it.
   */
  const flatten = (word: string): string => word.trim().toLowerCase().replace(/[\s-]+/g, '_')
  const columnKey = (word: string): string | null => {
    const flat = flatten(word)
    return columns.find((c) => flatten(c.key) === flat || flatten(c.label) === flat)?.key ?? null
  }

  /**
   * What this floor calls the three things a rule can say that are not a column.
   *
   * The rest of a floor is written in the language its people work in; these
   * were matched in English, so a rule written `mở thẻ` was refused and the
   * file could not be finished in the language the rest of it was in. The
   * format's own words still read, so nothing written before this stopped.
   */
  const said3 = (key: string, fallback: string): string =>
    (field(header, key) ?? '').trim().toLowerCase() || fallback
  const OPENS = said3('opens a card', 'opens a card')
  const CLOSES = said3('closes it', 'closes it')
  const THEIRS = said3('their card', 'their card')
  const WHEN = said3('when', 'when')
  const esc = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const THEIRS_AT_END = new RegExp(`\\((${esc(THEIRS)}|their card|theirs)\\)\\s*$`, 'i')

  // `- drafts → assigns: in review`, and the two that are not columns:
  // `opens a card`, and `closes it` - which finishes the work being checked too.
  // `:` only. `·` already means something on this line - it separates what
  // happens from when it happens - and taking it as the first separator too
  // read "when: ..." as the status.
  const RULE_LINE = /^\s*[-*+]\s*(.+?)\s*(?:→|->|=>)\s*(.+?)\s*:\s*(.+?)\s*$/
  const cardRules: CardRule[] = []
  for (const line of asides.rules ?? []) {
    const m = RULE_LINE.exec(line)
    if (!m) continue
    // "doing (their card) · when they send it back" - the bracket says whose
    // card moves, and anything after the dot is why the rule is there.
    const [saidPart, ...whenParts] = m[3].split('·')
    const when = whenParts
      .join('·')
      .replace(new RegExp(`^\\s*(?:${esc(WHEN)}|when)\\s+`, 'i'), '')
      .trim()
    const said = saidPart.trim().toLowerCase()
    const theirs = THEIRS_AT_END.test(said)
    const words = saidPart.replace(THEIRS_AT_END, '').trim()
    const opens = said.startsWith(OPENS) || /^opens?\b/.test(said)
    const closes = said.startsWith(CLOSES) || /^closes?\b/.test(said)
    const status = opens ? 'open' : closes ? 'closes' : columnKey(words)
    if (!status) {
      // The status alone, and the columns there are to choose from. It quoted
      // the whole cell - the ` · when ...` note included - so the thing it said
      // was not a column was a sentence nobody had offered as one, and it never
      // said what the board actually holds. Both halves matter to the model
      // being handed this back to fix as much as to the person reading it.
      return {
        error: `"${saidPart.trim()}" is not a column on this board, and not "${OPENS}" or "${CLOSES}". The columns are: ${columns.map((c) => c.key).join(', ') || '(none - the board is empty)'}.`
      }
    }
    cardRules.push({
      from: m[1].trim(),
      to: m[2].trim(),
      status,
      ...(theirs ? { whose: 'to' as const } : {}),
      ...(when ? { when } : {})
    })
  }

  // `- {{team}} — Falcon`. The braces are optional in the file; what reaches
  // `renderBrief` is the bare name, because that is what it substitutes.
  const WORD_LINE = /^\s*[-*+]\s*\{?\{?([\w.-]+)\}?\}?\s*[—–:-]+\s*(.*)$/
  const words: Record<string, string> = {}
  for (const line of asides.words ?? []) {
    const m = WORD_LINE.exec(line)
    if (m) words[m[1]] = m[2].trim()
  }

  const declared = capabilities
  const known = new Set<string>([...declared.map((c) => c.name), ...CAPABILITY_KINDS])

  const roles: Record<string, RoleDef> = {}
  const talksTo: Record<string, string[]> = {}
  let dispatch = ''
  let entry = ''

  for (const { head, body } of blocks) {
    const [rawRole, rawLabel] = head.split(/\s+[·|]\s+/)
    const role = rawRole.trim()
    if (!/^[\w-]+$/.test(role)) {
      return { error: `"${role}" is not a usable role name - letters, digits, - and _ only.` }
    }
    if (roles[role]) return { error: `"${role}" appears twice.` }

    // The bullet list is however many bullets follow the heading; anything
    // after them is brief, whether it was written here or under `## briefs`.
    //
    // The config block is the run of bullets directly under the heading, and it
    // ends at the first blank line after them. Ending it only at the first
    // non-bullet swallowed a brief that opened with a list - "- report when you
    // are done" read as a role field, vanished from the brief, and the agent was
    // never told. Nothing errored; the instruction was simply gone.
    let end = 0
    for (let j = 0; j < body.length; j++) {
      if (/^\s*[-*+]\s+\S/.test(body[j])) {
        end = j + 1
        continue
      }
      // A blank line before the bullets start is just spacing under the heading.
      if (!body[j].trim()) {
        if (end > 0) break
        continue
      }
      break
    }
    const block = body.slice(0, end)
    const brief = [body.slice(end).join('\n').trim(), briefs[role] ?? ''].filter(Boolean).join('\n\n')

    const caps = list(field(block, 'can'))
    const bad = caps.find((c) => !known.has(c))
    if (bad) {
      return {
        error: `"${role}" has an unknown capability "${bad}". This floor has: ${[...known].join(', ')}.`
      }
    }

    let fixed: RoleDef['fixed']
    const agent = field(block, 'agent')
    if (agent) {
      const [id, display] = agent.split(/\s+[·|(]\s*/)
      const cleanId = id.trim()
      if (!/^[\w-]+$/.test(cleanId)) {
        return { error: `"${role}" has agent id "${cleanId}" - letters, digits, - and _ only.` }
      }
      fixed = { id: cleanId, name: (display ?? '').replace(/\)\s*$/, '').trim() || cleanId }
    }

    const does = field(block, 'does')
    const cli = field(block, 'cli')
    const where = field(block, 'cwd')
    const never = list(field(block, 'never'))

    // Everything else on the bullet list is this floor's own word for this
    // role. Read rather than refused, because the alternative is a format that
    // can only ever say what Bullpen thought of first.
    const OWN = new Set(['agent', 'can', 'does', 'talks to', 'talksto', 'cli', 'cwd', 'never'])
    const attrs: Record<string, string> = {}
    for (const line of block) {
      const m = /^\s*[-*+]\s*([^:]+?)\s*:\s*(.+)$/.exec(line)
      if (m && !OWN.has(m[1].trim().toLowerCase())) attrs[m[1].trim()] = m[2].trim()
    }
    roles[role] = {
      can: caps as Capability[],
      label: (rawLabel ?? '').trim() || role,
      brief,
      ...(does ? { does } : {}),
      ...(Object.keys(attrs).length ? { attrs } : {}),
      ...(cli ? { cli } : {}),
      ...(where ? { cwd: where } : {}),
      ...(never.length ? { never } : {}),
      ...(fixed ? { fixed } : {}),
      ...(flag(block, 'hireable') ? { hireable: true } : {})
    }
    talksTo[role] = list(field(block, 'talks to') ?? field(block, 'talksto'))
    if (flag(block, 'dispatch')) dispatch = role
    if (flag(block, 'entry')) entry = role
  }

  // Said at the top instead: `- dispatch: boss`. Both forms mean the same
  // thing, and refusing the header one was refusing a file over where a fact
  // was written rather than what it said - which is what most people, and
  // every model asked to write one of these, reach for first.
  const said = (key: string): string => (field(header, key) ?? '').trim()
  if (!dispatch && roles[said('dispatch')]) dispatch = said('dispatch')
  if (!entry && roles[said('entry')]) entry = said('entry')

  if (!dispatch) {
    return { error: 'No role is marked `- dispatch`. That is who a task typed at the floor goes to.' }
  }

  /** Whether a header field names a role this floor actually has. */
  const named = (who: string | null | undefined): boolean => Boolean(who?.trim() && roles[who.trim()])

  return {
    workflow: {
      name,
      description,
      ...(summary ? { summary } : {}),
      roles,
      talksTo,
      dispatch,
      entry: entry || dispatch,
      hireAbovePct: num(field(header, 'hire above'), 70),
      capabilities: declared,
      columns,
      cardRules,
      words,
      human: field(header, 'human address')?.trim() || HUMAN_PARTY,
      hire: field(header, 'hire address')?.trim() || HIRE_PARTY,
      // Only when it names somebody who is here. Both of these are read and
      // then silently dropped by everything that asks - `rolesWith` checks
      // `w.roles[w.voice]` before trusting it - so a floor carrying
      // `- reports to you: boss` on a floor whose roles are `god`, `ba`, `dev`
      // and `tester` looked answered and was not, and the line survived every
      // save because nothing on the way through ever looked at it.
      ...(named(field(header, 'reports to you')) ? { voice: field(header, 'reports to you')!.trim() } : {}),
      ...(OPENS !== 'opens a card' || CLOSES !== 'closes it' || THEIRS !== 'their card' || WHEN !== 'when'
        ? {
            says: {
              ...(OPENS !== 'opens a card' ? { open: field(header, 'opens a card')!.trim() } : {}),
              ...(CLOSES !== 'closes it' ? { closes: field(header, 'closes it')!.trim() } : {}),
              ...(THEIRS !== 'their card' ? { theirs: field(header, 'their card')!.trim() } : {}),
              ...(WHEN !== 'when' ? { when: field(header, 'when')!.trim() } : {})
            }
          }
        : {}),
      ...(named(field(header, 'hires')) ? { hires: field(header, 'hires')!.trim() } : {})
    }
  }
}

/**
 * The same workflow, written back out. Round-trips through `parseMarkdown`.
 *
 * Always in the two-part form, whichever form it was read from: the editor
 * shows what this returns, so opening an old workflow is also how it gets
 * rewritten into the shape that can be read at a glance.
 */
/** The opening sentence of a brief, which is what `- does:` was written from. */
const firstLine = (brief: string): string =>
  brief
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
    ?.slice(0, 160) ?? ''

export function toMarkdown(w: Workflow): string {
  const out: string[] = [`# ${w.name}`]
  if (w.description) out.push('', w.description)
  out.push('', `- hire above: ${w.hireAbovePct}`)
  if (w.human !== HUMAN_PARTY) out.push(`- human address: ${w.human}`)
  if (w.hire !== HIRE_PARTY) out.push(`- hire address: ${w.hire}`)
  if (w.voice) out.push(`- reports to you: ${w.voice}`)
  if (w.says?.open) out.push(`- opens a card: ${w.says.open}`)
  if (w.says?.closes) out.push(`- closes it: ${w.says.closes}`)
  if (w.says?.theirs) out.push(`- their card: ${w.says.theirs}`)
  if (w.says?.when) out.push(`- when: ${w.says.when}`)
  if (w.hires) out.push(`- hires: ${w.hires}`)

  // After the header fields, never before them: everything under a `##` belongs
  // to that section, and a summary written above `- hire above:` takes the
  // whole header with it.
  if (w.summary?.trim()) out.push('', '## how it works', '', w.summary.trim())

  // Capabilities first: a role's `- can:` line names them, and reading
  // `can: drafts` before anything says what drafting is is reading backwards.
  // Only when there are any. An empty heading is a section somebody has to
  // decide whether they are supposed to fill in.
  if (w.capabilities.length) {
    out.push('', '## capabilities')
    for (const c of w.capabilities) {
      out.push(`- ${c.name}${c.kind ? ` (${c.kind})` : ''}${c.what ? ` — ${c.what}` : ''}`)
    }
  }

  out.push('', '## roles')
  for (const [role, def] of Object.entries(w.roles)) {
    out.push('', `### ${role}${def.label && def.label !== role ? ` · ${def.label}` : ''}`)
    if (def.fixed) out.push(`- agent: ${def.fixed.id} · ${def.fixed.name}`)
    // Only what this role actually says. Four of these were written whether or
    // not they carried anything: an empty `- can:`, an empty `- talks to:`,
    // `- does:` repeating the brief's own first line back at whoever had just
    // written it, and `- entry` under the `- dispatch` it already defaults to.
    // A file somebody opens to see what their floor is has to be the floor and
    // not a form with blanks in it.
    if (def.can.length) out.push(`- can: ${def.can.join(', ')}`)
    if (def.does && def.does !== firstLine(def.brief)) out.push(`- does: ${def.does}`)
    if (def.cli) out.push(`- cli: ${def.cli}`)
    if (def.cwd) out.push(`- cwd: ${def.cwd}`)
    if (def.never?.length) out.push(`- never: ${def.never.join(', ')}`)
    for (const [key, value] of Object.entries(def.attrs ?? {})) out.push(`- ${key}: ${value}`)
    const talksTo = w.talksTo[role] ?? []
    if (talksTo.length) out.push(`- talks to: ${talksTo.join(', ')}`)
    if (def.hireable) out.push('- hireable')
    if (role === w.dispatch) out.push('- dispatch')
    if (role === w.entry && role !== w.dispatch) out.push('- entry')
  }

  if (Object.keys(w.words).length) {
    out.push('', '## words')
    for (const [name, stands] of Object.entries(w.words)) out.push(`- {{${name}}} — ${stands}`)
  }

  out.push('', '## board')
  for (const c of w.columns) {
    out.push(`- ${c.key}: ${c.label} ${c.bar}${c.kind ? ` (${c.kind})` : ''}`)
  }

  // Only when the floor wrote some. None means it is moved by the ones worked
  // out from who does what, and an empty heading reads as a floor whose cards
  // do not move at all.
  if (w.cardRules.length) out.push('', '## card rules')
  for (const r of w.cardRules) {
    const said =
      r.status === 'open'
        ? saysOpen(w)
        : r.status === 'closes'
          ? saysCloses(w)
          : (w.columns.find((c) => c.key === r.status)?.label ?? r.status)
    const whose = r.whose === 'to' ? ` (${saysTheirs(w)})` : ''
    const when = r.when ? ` · ${saysWhen(w)} ${r.when}` : ''
    out.push(`- ${r.from} → ${r.to}: ${said}${whose}${when}`)
  }

  out.push('', '## briefs')
  for (const [role, def] of Object.entries(w.roles)) {
    out.push('', `### ${role}`, '', def.brief)
  }
  return out.join('\n') + '\n'
}

/**
 * The rules, as the operator may have replaced them.
 *
 * Bullpen ships one - `rules.md`, bundled - and it is what the linter enforces,
 * what the settings dialog draws, and what the model that writes workflows is
 * briefed with. A floor with its own conventions has its own rules, and editing
 * them should not mean editing the source: `~/.bullpen/rules.md` takes over.
 *
 * Read on every call rather than cached, so an edit takes effect on the next
 * open instead of the next launch. It costs one small read of a file nobody
 * touches, at the two moments somebody asked to see or use it.
 *
 * Not seeded on first run. A copy written at install freezes at the version it
 * was installed at, and every later improvement to the shipped document stops
 * reaching the person who accepted the copy - the file is there when somebody
 * decides to write one, and absent until then.
 */
export const formatPath = (home: string): string => join(home, 'rules.md')

export function formatDoc(
  home: string,
  shipped: string
): { text: string; path: string; custom: boolean } {
  const path = formatPath(home)
  try {
    const text = readFileSync(path, 'utf8')
    // An empty file is a truncated save, not an instruction to describe the
    // format as nothing: the writer would be briefed on a blank page.
    if (text.trim()) return { text, path, custom: true }
  } catch {
    // Absent or unreadable - the shipped document is the answer either way.
  }
  return { text: shipped, path, custom: false }
}

/**
 * The workflows on disk.
 *
 * One markdown file per workflow, under `~/.bullpen/workflows`, named for its
 * own `# heading`. Files rather than a blob inside config.json because these
 * are documents: an operator with an opinion about how their floor runs will
 * want to keep several, diff them, and edit one in their own editor without
 * going through this dialog at all.
 *
 * The presets are not stored here. They ship with Bullpen and are offered as
 * starting points; saving one under its own name is what makes it yours.
 */
export const workflowDir = (home: string): string => join(home, 'workflows')

/** A filename that cannot escape the directory it is meant to be in. */
export const workflowFile = (home: string, name: string): string => {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  if (!slug) throw new Error('A workflow needs a name.')
  return join(workflowDir(home), `${slug}.md`)
}

export type SavedWorkflow = { name: string; description: string; markdown: string }

/**
 * Every saved workflow, newest name first.
 *
 * A file that no longer parses is skipped rather than thrown: one bad file in
 * the directory - hand-edited, half-saved - must not take the whole list with
 * it and leave the dialog empty.
 */
export function listWorkflows(home: string): SavedWorkflow[] {
  const dir = workflowDir(home)
  if (!existsSync(dir)) return []
  const out: SavedWorkflow[] = []
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.md')) continue
    try {
      const markdown = readFileSync(join(dir, file), 'utf8')
      const parsed = parseMarkdown(markdown)
      if ('error' in parsed) continue
      out.push({
        name: parsed.workflow.name,
        description: parsed.workflow.description,
        markdown
      })
    } catch {
      // Unreadable is the same as absent as far as the list is concerned.
    }
  }
  return out
}

/** Write one, atomically. Returns what was parsed out of it. */
/**
 * Whether a floor has a place for an agent that is already running.
 *
 * Asked when one floor replaces another. A role that is gone takes its agents
 * with it; a role that is still there keeps whoever is doing it, unless the new
 * floor names somebody else for it and this one was standing in that spot.
 */
export function hasPlaceFor(
  w: Workflow,
  agent: { id: string; role: string; standing: boolean }
): boolean {
  const def = w.roles[agent.role]
  if (!def) return false
  const named = def.fixed?.id
  if (!named || named === agent.id) return true
  // Somebody else is named for this role. A hired agent doing that job is still
  // doing it; the one that was standing in the named spot has been replaced.
  return !agent.standing
}

export function saveWorkflow(home: string, markdown: string): Workflow {
  const parsed = parseMarkdown(markdown)
  if ('error' in parsed) throw new Error(parsed.error)
  // Parse errors only. This used to lint with every law switched on, which was
  // fine while laws were built in and is not now: no floor ships with card
  // rules, so every one of them failed a check nobody had asked for and could
  // not be written to disk at all.
  const dir = workflowDir(home)
  mkdirSync(dir, { recursive: true })
  const path = workflowFile(home, parsed.workflow.name)
  // Write-then-rename: a reader that catches a half-written file gets truncated
  // markdown and no error, which lists as "not a workflow" and looks like loss.
  const tmp = `${path}.tmp`
  writeFileSync(tmp, markdown, 'utf8')
  renameSync(tmp, path)
  return parsed.workflow
}

/** Remove one. Silent when it was not there - the end state is what was asked. */
export function deleteWorkflow(home: string, name: string): void {
  const path = workflowFile(home, name)
  if (existsSync(path)) rmSync(path)
}
