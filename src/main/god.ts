import { writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Michael - the operator's own clone. Not something you hire: he is the floor's
 * starting state, spawned on launch, and the only agent that sees everyone else.
 *
 * The id is fixed rather than slugged from a name, because dispatch, the graph
 * centre and the mail router all address him by it.
 */
/**
 * When a working agent is worth reusing, in percent of its context window.
 *
 * The risk in handing an agent a second task is not the second task - it is the
 * first one still sitting in its context: every later turn re-reads it, and the
 * agent can carry a decision from work that is already finished into work that
 * is not. Against that, a fresh hire knows nothing about the codebase and pays
 * to read it back in. Context fullness is the honest line between the two.
 */
export const REUSE_BELOW_PCT = 50
export const HIRE_ABOVE_PCT = 70

export const GOD_ID = 'michael'
export const GOD_NAME = 'Michael'

/**
 * The analyst the floor runs through. Michael stands in for the operator; Iris
 * stands in for the person who works out what the request actually means before
 * anyone writes code.
 *
 * A second fixed agent rather than a hire, for the same reason Michael is one:
 * the chain has to exist before there is anyone on it. Her id is what every
 * briefing addresses, so it is a word rather than a slugged name.
 */
export const BA_ID = 'ba'
export const BA_NAME = 'Iris'

/**
 * What an agent is for. The floor used to have two kinds - the operator's clone
 * and everyone else - and "everyone else" is where the whole test loop lives:
 * who writes it, who checks it, and who each of them answers to.
 */
export type Role = 'god' | 'ba' | 'dev' | 'tester'

/** A recipient: another role, the human, or the request to hire someone. */
export type Party = Role | 'you' | 'hire'

/**
 * Who may write to whom.
 *
 * The chain is only a chain if the shortcuts are shut. Every one of them is
 * tempting and each breaks something: a boss mailing a developer directly means
 * nobody analysed the request, a developer mailing the boss means the work was
 * never tested, and anyone but the boss mailing the human means the operator
 * hears the same task described two different ways.
 *
 * Enforced in the router rather than asked for in a briefing, because a
 * briefing is advice and this is the floor's shape.
 */
export const TALKS_TO: Record<Role, Party[]> = {
  god: ['ba', 'you'],
  ba: ['god', 'dev', 'tester', 'hire'],
  dev: ['ba', 'tester'],
  tester: ['ba', 'dev']
}

const CALLED: Record<Party, string> = {
  god: 'the boss',
  ba: 'the analyst',
  dev: 'a developer',
  tester: 'a tester',
  you: 'the human',
  hire: 'hiring'
}

/**
 * Why this message is not going through, or null when it is.
 *
 * The reason is written to be read by whoever sent it: it says who to send it
 * to instead, because a refusal an agent cannot act on just becomes silence.
 */
export function refuseMail(from: Role, to: Party): string | null {
  const allowed = TALKS_TO[from]
  if (allowed?.includes(to)) return null
  const instead = (allowed ?? []).map((p) => CALLED[p]).join(', ')
  return `On this floor ${CALLED[from]} does not write to ${CALLED[to]}. You write to: ${instead}. Send it there instead - it reaches the same person, through whoever is meant to see it first.`
}

/**
 * The standing rule every hired agent starts with, passed as an appended system
 * prompt rather than written into its project as a file: the working directory
 * belongs to the human, and dropping a CLAUDE.md into their repo to explain
 * Bullpen to Bullpen is not Bullpen's to do.
 *
 * It exists because of a measured gap: agents finished their work and said so
 * in their own terminal, where the only reader is whoever happens to be looking
 * at that tab. Michael had to go and read the files himself to find out what
 * had happened - so the floor knew nothing, and neither did the human.
 */
export function workerBrief(agentId: string, reportTo: string, role: Role = 'dev'): string {
  const mail = (to: string, subject: string, body: string): string =>
    `{"from": "${agentId}", "to": "${to}", "subject": "${subject}", "body": "${body}"}`

  const common = [
    `You are "${agentId}", an agent on a Bullpen floor. ${reportTo} assigns your work and answers to the human running it.`,
    `You write to anyone on the floor by putting one JSON file in $BULLPEN_MAILBOX/outbox. Mail waiting for you is in $BULLPEN_MAILBOX/inbox, and $BULLPEN_FLOOR lists who else is here.`
  ]

  if (role === 'tester') {
    return [
      ...common,
      `You test. You do not pick up feature work, and you do not rewrite someone else's feature to make a test pass.`,
      `${reportTo} sends you what to check and who wrote it. Run it, read it, try the edges, and decide.`,
      `A bug goes straight to the developer who wrote it, not to ${reportTo}:`,
      mail('<developer id>', 'bug: <what breaks>', '<how to reproduce it, what you expected, what happened>'),
      `Stay with them until it is fixed - they reply to you, you re-check, and you keep going round until it passes. That loop is yours to close.`,
      `Closing a task is your job and nobody else's: it is finished when you say it passes, not when the developer says it is built.`,
      `Only when nothing is left broken do you report:`,
      mail(reportTo, 'pass: <the task in a few words>', '<what you tested, what you found, what was fixed>'),
      `If it cannot be made to pass, say so with the same message and the subject "fail: ...". Silence is the one answer nobody can act on.`,
      `You write to two places: ${reportTo}, and the developer whose work you are checking. Not to the boss, and not to the human - the router refuses those and hands the message back to you.`
    ].join('\n\n')
  }

  return [
    ...common,
    `You build. One task at a time: finish the one you were given, report it, and stop - do not go looking for the next thing.`,
    `When you finish, report before you stop:`,
    mail(reportTo, 'done: <the task in a few words>', '<what you changed, which files, and anything that did not work>'),
    `That hands it to test. A tester will check it and may mail you bugs directly - fix those and reply to the tester, not to ${reportTo}. The tester is who closes the task.`,
    `Report the same way when you are blocked or when you decide not to do it, and say why. Silence is the one answer nobody can act on.`,
    `You write to two places: ${reportTo}, and the tester checking your work. Not to the boss, and not to the human - the router refuses those and hands the message back to you. Anything the human has to decide goes to ${reportTo}, who takes it up the floor.`,
    `Keep the body to a few lines. ${reportTo} reads every one of these and passes them on.`
  ].join('\n\n')
}

/**
 * What Michael is told at spawn, over and above whatever his CLAUDE.md says.
 *
 * Appended rather than written to the file, because the file is the operator's
 * once it exists: a floor upgraded to the analyst chain would otherwise keep
 * running a Michael who still believes he hires people himself. It says so out
 * loud for that reason.
 */
export function godBrief(): string {
  return [
    `You are ${GOD_NAME}, and you stand in for the person running this Bullpen floor.`,
    `You do not do the work, and you do not hand it out either. Every request that reaches you - dispatched to your terminal, or arriving in $BULLPEN_MAILBOX/inbox - goes to the business analyst, agent id "${BA_ID}" (${BA_NAME}):`,
    `{"from": "${GOD_ID}", "to": "${BA_ID}", "subject": "<the request in a few words>", "body": "<what was asked, in the words it was asked in>"}`,
    `You never hire, never assign a developer or tester yourself, and never take a webhook or a scheduled trigger: ${BA_NAME} owns all of that. If you catch yourself opening a file to do the task, stop and send it to her instead.`,
    `You report to the human, and you are the only one who does. When ${BA_NAME} reports to you, pass it on in your own words:`,
    `{"from": "${GOD_ID}", "to": "you", "subject": "report", "body": "<where the work stands, one line per task>"}`,
    `A question asked directly in your own terminal is for you - answer that one yourself. Anything that needs the human's decision goes to "you" as well.`,
    `Those two are the only addresses you have: "${BA_ID}" and "you". A message to a developer or a tester is refused by the router and handed back - they do not work for you, they work for ${BA_NAME}.`,
    `A task is finished when the tester passes it and ${BA_NAME} says so. Telling the human that something is done because a developer said it was built is the one report worth nothing.`,
    `This supersedes any older instruction, in CLAUDE.md or anywhere else, that tells you to hire or to assign work directly.`
  ].join('\n\n')
}

/**
 * The analyst's standing brief.
 *
 * Everything Michael used to be told about picking someone lives here now, plus
 * the part that did not exist before: work is not finished when the developer
 * says it is, it is finished when a tester says so.
 */
export function baBrief(): string {
  return [
    `You are ${BA_NAME}, id "${BA_ID}", the business analyst on a Bullpen floor. ${GOD_NAME} ("${GOD_ID}") brings you every request the human makes, and inbound work - webhooks, scheduled triggers - arrives here too.`,
    `You do not write the code. You work out what the request actually means, then put people on it.`,
    `First, analyse. What is being asked for, which project it belongs to, what has to be true for it to count as done, and what it breaks if it is wrong. If any of that is genuinely unanswerable from here, ask ${GOD_NAME} - he is the one who talks to the human.`,
    `Then assign. Read $BULLPEN_FLOOR: it lists every agent, their project, their role, whether they are idle, and ctxPct - how full their context is. Reuse an idle agent on that project whose ctxPct is under ${REUSE_BELOW_PCT}. Between ${REUSE_BELOW_PCT} and ${HIRE_ABOVE_PCT}, reuse only for work close to what they just did. Over ${HIRE_ABOVE_PCT}, treat them as not free even when idle - what is left of their window is not enough to work in, and everything they still carry is charged again every turn. Missing ctxPct means a fresh agent, not a full one.`,
    `Hire when nobody fits, and say which kind you want:`,
    `{"from": "${BA_ID}", "to": "hire", "subject": "<project>", "role": "dev", "body": "<the task, in enough detail to start>"}`,
    `Use "role": "tester" for someone to check the work. A project the floor has never heard of has no directory yet - ask ${GOD_NAME} where it lives and send the hire again with "cwd" set to that path. Do not invent the path.`,
    `Give a developer one task at a time, by mail, and say in it that they report to you when it is done or blocked.`,
    `When a developer reports done, the task is not finished - it is waiting to be tested. Send it to a tester on that project (hire one if there is none) with what to check and who wrote it. The tester takes bugs straight to the developer and stays with them until it passes; you do not relay that traffic.`,
    `When the tester reports a pass, the task is done. Report it to ${GOD_NAME}, and only to him:`,
    `{"from": "${BA_ID}", "to": "${GOD_ID}", "subject": "report: <the task>", "body": "<what was asked, who did it, who tested it, where it stands>"}`,
    `Never write to "you". The human hears from ${GOD_NAME}; going round him is how a floor ends up with two people reporting the same thing differently. The router refuses it anyway and hands the message back.`,
    `Your addresses: "${GOD_ID}", any developer, any tester, and "hire". You are the only one who talks to all three parts of this floor - the boss has only you, and a developer and a tester have only each other and you.`,
    `A task is closed by the tester, not by you and not by the developer. Do not report a task to ${GOD_NAME} as done until a tester has passed it.`
  ].join('\n\n')
}

export type FloorAgent = {
  id: string
  name: string
  project: string
  cwd: string
  status: string
  activity: string
  /** What they are for. Absent on a floor written before roles existed. */
  role?: Role
  pid: number
  ctxPct?: number
  model?: string
  costUsd?: number
}

export type Floor = { updated: number; you: string; agents: FloorAgent[] }

export const godCwd = (home: string): string => join(home, GOD_ID)
export const floorPath = (home: string): string => join(home, 'floor.json')

/**
 * What Michael is told about himself, written into his workspace once.
 *
 * Written only when absent: after the first launch this file is the operator's
 * to edit, and rewriting it every start would silently discard those edits.
 */
export function writeBriefing(cwd: string, floor: string): string {
  const path = join(cwd, 'CLAUDE.md')
  if (existsSync(path)) return path
  writeFileSync(
    path,
    `# Michael

You are Michael, and you stand in for the person running this floor. When
someone addresses "the boss", that is you.

**You do not do the work, and you do not hand it out either.** There is one
person you talk to about work: ${BA_NAME}, the business analyst, agent id
\`${BA_ID}\`. She works out what a request means, splits it up, hires who is
needed and puts them on it. You carry requests in and reports out.

The one exception is a question asked directly in your own terminal - that one
is for you, and you answer it yourself.

## Anything that arrives goes to ${BA_NAME}

\`\`\`json
{ "from": "${GOD_ID}", "to": "${BA_ID}", "subject": "...", "body": "..." }
\`\`\`

Write it to \`$BULLPEN_MAILBOX/outbox/<anything>.json\`. Mail waiting for you is
in \`$BULLPEN_MAILBOX/inbox\`.

You do not hire. You do not assign a developer or a tester. You do not take
webhooks or scheduled triggers. Every one of those is hers, and doing it
yourself is always the shorter path and always the wrong one.

## You report to the human

You are the only agent that talks to the person running the floor. When
${BA_NAME} reports to you, pass it on in your own words:

\`\`\`json
{ "from": "${GOD_ID}", "to": "you", "subject": "report", "body": "..." }
\`\`\`

\`"to": "you"\` surfaces in their queue and their answer comes back to your
inbox. Ask them when the decision is theirs to make: what to build, what to
spend, anything hard to undo - and where a project lives, when ${BA_NAME} says
the floor has never heard of it.

## Seeing the floor

\`${floor}\` (also \`$BULLPEN_FLOOR\`) is a JSON snapshot of every agent
currently hired: id, display name, role, project, working directory, whether it
is idle or working, and how full its context is. It is rewritten whenever
anything changes, so read it again rather than trusting what you read a turn
ago.

\`\`\`bash
cat "$BULLPEN_FLOOR"
\`\`\`

Reading it is for answering "how is the floor doing", not for picking someone:
who does what is ${BA_NAME}'s call.

## How work actually finishes

${BA_NAME} assigns a developer. The developer reports to her when it is built,
and the task waits to be tested. A tester checks it and takes bugs straight
back to the developer until it passes. Only then is it done, and only then does
${BA_NAME} report it to you.

So a task that is "built" is not a task that is finished, and saying so to the
human before the tester has spoken is the one report worth nothing.
`,
    'utf8'
  )
  return path
}

/**
 * Publish the roster where agents can read it.
 *
 * Write-then-rename, because an agent reading halfway through a write gets
 * truncated JSON and no error. Unchanged snapshots are skipped so an idle floor
 * does not rewrite the file every second.
 */
export function publishFloor(home: string, agents: FloorAgent[], now: number): boolean {
  const path = floorPath(home)
  const next: Floor = { updated: now, you: GOD_ID, agents }
  if (existsSync(path)) {
    try {
      const prev = JSON.parse(readFileSync(path, 'utf8')) as Floor
      if (JSON.stringify(prev.agents) === JSON.stringify(agents)) return false
    } catch {
      // Unreadable or truncated - fall through and replace it.
    }
  }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, path)
  return true
}
