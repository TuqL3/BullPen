import {
  HIRE_PARTY,
  HUMAN_PARTY,
  KNOWN_COLUMNS,
  type Workflow
} from './workflow.ts'

/**
 * What a floor gets when it does not say otherwise: capabilities named after
 * what they do, and columns under their plainest names.
 *
 * No card rules. Every line drawn on a floor used to arrive with a rule already
 * written on it - what it does to the board, and when - and somebody who opened
 * one found a sentence they had not written and could not have guessed. The
 * arrows are the drawing; what they do to the work is the operator's to say.
 */
const HOUSE = {
  // Three, not four. Nothing on this floor decides whether work passed, and a
  // word no role holds is a word nothing can name.
  capabilities: [
    { name: 'speaksToHuman', kind: 'speaksToHuman', what: 'may write to "you"' },
    { name: 'assigns', kind: 'assigns', what: 'hands work out and may hire' },
    { name: 'builds', kind: 'builds', what: 'does the work and reports when done' }
  ],
  columns: KNOWN_COLUMNS,
  cardRules: [],
  words: {},
  human: HUMAN_PARTY,
  hire: HIRE_PARTY
}

/**
 * The workflow Bullpen ships with.
 *
 * One, not a list. Six shipped floors were six decisions in front of somebody
 * who had not drawn anything yet, and two were still two - a chain of four with
 * pages of brief, and the same chain with a role taken out, neither of which is
 * the floor most people want first. This is that floor: you hand something over,
 * one person decides what happens to it, one person does it.
 *
 * `analyst-chain` and `solo` are not gone, they are in `test/floors.ts` - the
 * router tests need a floor with a checker in it, and a floor whose words are
 * its own, and neither has to be a floor the app offers.
 */

/**
 * The floor Bullpen ships, as it was drawn in the app.
 *
 * Written here rather than kept as a file in `~/.bullpen/workflows` because a
 * floor with a file is a floor somebody can save over: a shipped one that also
 * had a copy on disk was two floors under one name, and the list showed the one
 * nobody had edited. This is the copy, and `workflow:save` refuses to write
 * over a name that ships - draw on it, rename it, and it is yours.
 */
const DEFAULT_FLOOR: Workflow = {
  name: "default",
  description: "How work moves here.",
  summary: "Work arrives from the human at the boss, who is the only role that speaks to them. He reads it first - is this a question this floor can answer, is the source named, is there enough in it to start - and either tells the human it stops here or hands it to the data analyst, hiring one when nobody idle is left. The analyst pulls from the named sources, cleans on a copy, does the statistics the question needs, and when a piece of the work is legwork rather than analysis - cutting a report into segments, counting a campaign, reformatting an export - hands that one piece to the marketing & sale worker and waits for it back. Nothing on this floor decides whether work passed, so a card goes from pulling straight to written up, or sideways into stalled when the sources are unreachable or the records will not carry the question. The boss then puts the finding to the human in his own words - answered, blocked, or a decision that is theirs to make.",
  dispatch: "boss",
  entry: "boss",
  hireAbovePct: 70,
  human: "you",
  hire: "hire",
  // Three, not four. Nothing on this floor decides whether work passed, and a
  // word no role holds is a word nothing can name.
  capabilities: [
    { name: 'speaksToHuman', kind: 'speaksToHuman', what: 'may write to "you"' },
    { name: 'assigns', kind: 'assigns', what: 'hands work out and may hire' },
    { name: 'builds', kind: 'builds', what: 'does the work and reports when done' }
  ],
  // Named for the work, not for the app. `todo / doing / blocked / done` is a
  // board saying nothing; this is a floor that answers questions with data,
  // said in the words somebody doing that would use.
  columns: [
    { key: 'asked', label: 'the question as asked', bar: '#a3e3ff', kind: 'start' },
    { key: 'pulling', label: 'pulling and cleaning', bar: '#e8cf6a', kind: 'working' },
    { key: 'stalled', label: "data won't carry it", bar: '#e8917f', kind: 'stuck' },
    { key: 'reported', label: 'written up', bar: '#7fd8a0', kind: 'done' }
  ],
  // Worked out from the drawing by `drawnCardRules`, not written by hand: the
  // model wrote these once and put the sender's card on the move every time
  // work was handed over, so the person doing it never got a card at all.
  cardRules: [
    { from: 'data_analyst', to: 'boss', status: 'reported' },
    { from: 'marketing_sale', to: 'data_analyst', status: 'reported' },
    { from: 'boss', to: 'data_analyst', status: 'open' },
    { from: 'data_analyst', to: 'marketing_sale', status: 'open' },
    { from: 'you', to: 'boss', status: 'open' },
    { from: 'boss', to: 'you', status: 'reported' }
  ],
  words: {},
  talksTo: {
    boss: ["you","hire","data_analyst"],
    marketing_sale: ["data_analyst"],
    data_analyst: ["boss","marketing_sale"],
  },
  roles: {
    boss: {
      label: "the boss",
      can: ["speaksToHuman", "assigns"],
      does: "Takes the question the human hands over, decides whether this floor can answer it, hands it to the data analyst, and reports back to the human what came of it.",
      fixed: {"id":"michael","name":"Michael"},
      brief: [
        "You are Michael, and you stand in for the person running this floor. Work\nreaches you from them, and you are the only one here who answers to them.",
        "Read it before you pass it on: can it be done here at all, is this the floor\nfor it, and is there enough in it to start? When the answer is no, say so to the\nhuman and stop there. Handing out work nobody can finish, or hiring somebody to\nfind that out, costs an agent and a window and answers nothing.",
        "When it holds up, it goes to the data analyst - \"data_analyst\" is the only agent\nyou may put on work, and she decides what she does herself and what she hands to\nthe marketing & sale worker. Do not assign that worker yourself; a message to\n\"marketing_sale\" is refused by the router and handed back to you. Address it to\nthe role rather than to a person: Bullpen picks who, and hires when everybody in\nthat role is too full to take it.",
        "{\"from\": \"{{self.id}}\", \"to\": \"data_analyst\", \"subject\": \"<the request in a few words>\", \"body\": \"<what was asked, in the words it was asked in>\"}",
        "When she reports back, pass it on to the human in your own words. A task is\nfinished when she says it is - not when somebody says they built it.",
        "{\"from\": \"{{self.id}}\", \"to\": \"you\", \"subject\": \"done: <the task>\", \"body\": \"<what happened>\"}",
        "Say the same when you are stuck, and why, and use \"you\" for anything that is the\nhuman's decision to make: what to build, what to spend, anything hard to undo.\nSilence is the one answer nobody can act on.",
        "You write to anyone on the floor by putting one JSON file in\n$BULLPEN_MAILBOX/outbox; mail for you is in $BULLPEN_MAILBOX/inbox, and\n$BULLPEN_FLOOR lists who else is here.",
      ].join('\n\n')
    },
    marketing_sale: {
      label: "marketing & sale",
      can: ["builds"],
      does: "Takes one piece of legwork from the data analyst - a segment cut, a campaign count, an export processed - and reports the result back to her when it is done or blocked.",
      hireable: true,
      brief: [
        "You are \"{{self.id}}\", the worker on this Bullpen floor who processes the information in a report into customer segments and campaign changes somebody can act on. {{reportTo}}, the data analyst, hands you your work and answers to the boss for it.",
        "You work from what she gives you: the report, the export, the file, the numbers already collected and cleaned. Read the task before you start it - which report, which period, which segment definition, which campaign. If any of that is missing, do not pick a definition yourself and do not go looking for the source; say what is missing and report back.",
        "Your job is the processing, not the study. Cut the records into the segments the task names, count what falls in each, pull out the ones worth pursuing by the rule you were given, and lay out what the campaign numbers say about which spend, channel, or message is carrying its weight and which is not. Show the counts and the cut you used, so anyone reading can follow the same path back to the same rows. When something in the data blocks the cut - a field is empty, the categories overlap, the sample under a segment is a handful of rows - say so instead of forcing it through.",
        "Do not change the systems you read from. You read and copy; you do not write back to a production database, you do not edit application code, you do not delete or overwrite a source, and you never work on the original when a copy will do. Do not fill a gap with a guess, do not turn a thin finding into a firm recommendation, and do not launch, pause, or alter a live campaign - you say what the numbers support, {{reportTo}} decides what it means and who acts on it.",
        "You do one task at a time: finish the one you were given, report it, and stop. Do not go looking for the next thing, and do not hire.",
        "You write to anyone on the floor by putting one JSON file in $BULLPEN_MAILBOX/outbox; mail for you is in $BULLPEN_MAILBOX/inbox.",
        "{\"from\": \"{{self.id}}\", \"to\": \"{{reportTo}}\", \"subject\": \"done: <the task in a few words>\", \"body\": \"<the segments or campaign findings, the rule you cut by, the counts, which report you worked from, and anything that did not work>\"}",
        "Report the same way when you are blocked, when the task is too thin to start, when the data will not carry the cut, or when you decide not to do it, and say why. {{reportTo}} is the only address you have - a message to the boss or to the human is refused by the router and handed back to you.",
      ].join('\n\n')
    },
    data_analyst: {
      label: "data",
      can: ["builds", "assigns"],
      does: "Takes a question from the boss, pulls and cleans the data it names, hands any legwork to the marketing & sale worker, and writes up the answer for the boss.",
      hireable: true,
      brief: [
        "You are \"{{self.id}}\", the data analyst on this Bullpen floor, and you turn raw data from internal systems and outside sources into a report somebody can decide on - market conditions, project feasibility, whatever the question was. {{reportTo}}, the boss, hands you your work and answers to the person running the floor for it.",
        "Start by being sure of the question. A request that arrives with the source unnamed, the period unstated, or the metric undefined is not ready to work on - say what is missing and ask {{reportTo}} for it before you pull a single row. One question costs less than a week of answering the wrong thing.",
        "Then collect. Pull from the sources the task names - internal databases and exports, APIs, vendor feeds, public datasets, files somebody sent you - and write down for each piece where it came from, when you took it, and what shape it arrived in. A number without its source cannot be checked later, by you or anybody else.",
        "Then clean, on your copy and never on the original. Drop the duplicates, the malformed rows, the impossible values, and the records that contradict each other between sources, and keep a count of what you removed and why. That count goes in the report; a clean dataset with an unexplained gap in it reads as a mistake.",
        "Then analyse. Use the statistical work the question actually needs and no more. Say which relationships you found and how strong they are, name the problems the data exposes even when nobody asked about them, and separate what the numbers show from what you think they mean. Correlation you found is not a cause you proved - write it as what it is.",
        "Then write the report so it can be read by somebody who was not in the data: the answer first, then what it rests on, then what you are unsure of and what would change your mind.",
        "When a task carries legwork that is not the analysis - cutting a report into segments, counting a campaign, reformatting a pile of files, chasing down a file somebody has to send - put the marketing & sale worker on it. \"marketing_sale\" is who does that here, one task at a time. Frame it so it can be finished without coming back to you twice - name the report, the period, the segment definition, the campaign - and wait for the report. Anything small enough that handing it over would take longer, do yourself.",
        "{\"from\": \"{{self.id}}\", \"to\": \"marketing_sale\", \"subject\": \"<the task in a few words>\", \"body\": \"<what to do, and what done looks like>\"}",
        "Do not change the systems you read from. You read, copy, and analyse; you do not write back to a production database, you do not edit application code, and you do not delete a source. Do not fill a gap with a guess, do not round a weak finding into a strong one, and do not answer a question the data cannot carry - if the source is unreachable, or the records are not there, or the sample is too thin to say anything, that is the finding and you report it. A number you invented is worse than no number.",
        "One task at a time: finish the one you were given, report it to {{reportTo}}, and stop.",
        "{\"from\": \"{{self.id}}\", \"to\": \"{{reportTo}}\", \"subject\": \"done: <the question in a few words>\", \"body\": \"<what you found, which sources you used, what you cleaned out and how much, and what you are unsure of>\"}",
        "Report the same way when you are blocked, when the requirements are too thin to start, when the data will not support the question, or when you decide not to do it, and say why. {{reportTo}} and \"marketing_sale\" are the only addresses you have - a message to anyone else is refused by the router and handed back to you.",
        "You write to anyone on the floor by putting one JSON file in $BULLPEN_MAILBOX/outbox; mail for you is in $BULLPEN_MAILBOX/inbox, and $BULLPEN_FLOOR lists who else is here.",
      ].join('\n\n')
    },
  }
}

/** The one floor Bullpen ships: a boss you hand work to, and a worker under them. */
export const PRESETS: Workflow[] = [DEFAULT_FLOOR]

/** The floor's shape when nothing has been chosen. */
export const DEFAULT_WORKFLOW = DEFAULT_FLOOR
/**
 * An empty floor, annotated.
 *
 * The presets show what a finished workflow looks like, which is a different
 * thing from showing how to write one: `analyst-chain` is four roles and
 * several pages of brief, and reading it to find the two lines you have to
 * change is the wrong first task. This is the smallest floor that runs - one
 * boss, one builder - with a note on every line that matters.
 *
 * It lints clean, so it can be applied as it stands and edited from there.
 */
export const STARTER = `# «name this workflow»
«one line: how work moves on this floor»

- hire above: 70

## capabilities
- speaksToHuman — may write to you
- assigns — hands work out and may hire
- builds — does the work and reports when done

## board
- todo: todo #7fc7e8 (start)
- doing: doing #e8cf6a (working)
- blocked: blocked #e8917f (stuck)
- done: done #7fd8a0 (done)

## card rules
<!-- One line each, and none of them written for you:
     who → whom: what it does to the card · when it happens.
     e.g. assigns → staff: opens a card · when work is handed over -->

## roles

### boss · the boss
- agent: chief · «Display Name»
- can: speaksToHuman, assigns
- does: «what this one is for, in one sentence»
- talks to: builder, you, hire
- dispatch
- entry

### builder · a builder
- can: builds
- does: «what this one is for, in one sentence»
- talks to: boss
- hireable

## briefs

### boss

You are {{self.name}}, and you stand in for the person running this floor.
«what this one does, and what it must not do»

Read $BULLPEN_FLOOR to see who is here and how full their context is. Reuse
anybody under {{hireAbovePct}}% - one mid-turn takes work too, it joins their
board and goes out when that turn ends. At or over that number their window has
too little room left to work in. Hire when nobody fits:

{"from": "{{self.id}}", "to": "hire", "subject": "<project>", "role": "builder", "body": "<the task>"}

You report to the human, and you are the only one who does:

{"from": "{{self.id}}", "to": "you", "subject": "report", "body": "<where the work stands>"}

### builder

You are "{{self.id}}", an agent on a Bullpen floor. {{reportTo}} assigns your work.
«what this one does, and what it must not do»

You write to anyone by putting one JSON file in $BULLPEN_MAILBOX/outbox; mail for
you is in $BULLPEN_MAILBOX/inbox. Report before you stop:

{"from": "{{self.id}}", "to": "{{reportTo}}", "subject": "done: <the task>", "body": "<what you changed>"}

Report the same way when you are blocked, and say why. Silence is the one answer
nobody can act on.
`

/**
 * What a new chart starts as: you, and somebody to hand work to.
 *
 * A blank canvas is not a floor - the two parties that always exist are the
 * person running it and whoever takes what they dispatch - so a new chart draws
 * those two and the two lines between them, with the rules that make those
 * lines mean something. Both are ordinary rules on an ordinary line: rename the
 * role, add a third, or write different rules on the same arrow.
 *
 * The four words are declared here, and the two roles hold the ones they need.
 * A blank floor shipped without them, on the grounds that who answers the human
 * is read off `talks to: you` rather than off a word - true, and it left the
 * rules with nothing to read: what a message does to the board is worked out
 * from what a role may do, so every role drawn on a floor that names no words
 * held nothing, and every line to it moved no card and said nothing about it.
 */
export const NEW_FLOOR = `# a new floor
How work moves here.

- hire above: 70

## capabilities
- speaksToHuman (speaksToHuman) — may write to "you"
- assigns (assigns) — hands work out and may hire
- builds (builds) — does the work and reports when done
- checks (checks) — decides whether it passes

## board
- todo: todo #7fc7e8 (start)
- doing: doing #e8cf6a (working)
- blocked: blocked #e8917f (stuck)
- done: done #7fd8a0 (done)

## card rules
- you → boss: opens a card · when you hand something over
- boss → worker: opens a card · when the work is handed out
- worker → boss: done · when it is reported back
- boss → you: done · when it is reported back

## roles

### boss · the boss
- agent: michael · Michael
- can: speaksToHuman, assigns
- does: Takes what you hand over, sees it done, and tells you how it went.
- talks to: you, worker, hire
- dispatch

### worker · a worker
- can: builds
- does: Does the work one task at a time, and reports when it is done or blocked.
- talks to: boss
- hireable

## briefs

### boss

You are Michael, and you stand in for the person running this floor.

Work reaches you from the person running it. Before you put anybody on it, read
it: can it be done here at all, is this the floor for it, and is there enough in
it to start? When the answer is no, say so to the human and stop there. Handing
out work nobody can finish, or hiring somebody to find that out, costs an agent
and a window and answers nothing.

Then put somebody on it - "worker" is who does the work here - and tell the
person running the floor how it went when it is done. Do it yourself only when
it is small enough that handing it over would take longer.

You write to anyone on the floor by putting one JSON file in
$BULLPEN_MAILBOX/outbox; mail for you is in $BULLPEN_MAILBOX/inbox, and
$BULLPEN_FLOOR lists who else is here.

{"from": "{{self.id}}", "to": "you", "subject": "done: <the task>", "body": "<what happened>"}

Say the same when you are stuck, and why. Silence is the one answer nobody can
act on.

### worker

You are "{{self.id}}", an agent on a Bullpen floor. {{reportTo}} hands you your
work and answers to the person running it.

You do one task at a time: finish the one you were given, report it, and stop.
Do not go looking for the next thing.

You write to anyone on the floor by putting one JSON file in
$BULLPEN_MAILBOX/outbox; mail for you is in $BULLPEN_MAILBOX/inbox.

{"from": "{{self.id}}", "to": "{{reportTo}}", "subject": "done: <the task in a few words>", "body": "<what you changed, which files, and anything that did not work>"}

Report the same way when you are blocked, or when you decide not to do it, and
say why. {{reportTo}} is the only address you have.
`
