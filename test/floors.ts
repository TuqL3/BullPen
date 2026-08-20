import { DEFAULT_WORKFLOW as BARE, PRESETS as SHIPPED } from '../src/main/presets.ts'
import type { CardRule, Workflow } from '../src/main/workflow.ts'

/**
 * The shipped floors, with card rules written on them.
 *
 * Bullpen ships no rules any more: an arrow is drawn by the operator and what
 * it does to the board is theirs to write, so a floor out of the box moves no
 * cards. That is the product, and it is useless for testing the router - which
 * is a machine for moving cards. So the rules that used to be built in live
 * here, as one floor's answer rather than everyone's, and the router tests run
 * against a floor somebody wrote.
 */
const HOUSE: CardRule[] = [
  { from: 'assigns', to: 'staff', status: 'open' },
  { from: 'speaksToHuman', to: 'staff', status: 'open' },
  { from: 'builds', to: 'assigns', status: 'wait_test' },
  { from: 'checks', to: 'builds', status: 'doing', whose: 'to' },
  { from: 'builds', to: 'checks', status: 'wait_test' },
  { from: 'checks', to: 'assigns', status: 'closes' },
  { from: 'assigns', to: 'speaksToHuman', status: 'done' },
  { from: 'speaksToHuman', to: 'you', status: 'done' }
]

/** The same eight, in the words each floor uses for them. */
const OWN: Record<string, CardRule[]> = {
  'content-floor': [
    { from: 'commissions', to: 'staff', status: 'open' },
    { from: 'speaks', to: 'staff', status: 'open' },
    { from: 'drafts', to: 'commissions', status: 'in_review' },
    { from: 'proofs', to: 'drafts', status: 'drafting', whose: 'to' },
    { from: 'drafts', to: 'proofs', status: 'in_review' },
    { from: 'proofs', to: 'commissions', status: 'closes' },
    { from: 'commissions', to: 'speaks', status: 'published' },
    { from: 'speaks', to: 'you', status: 'published' }
  ],
}

const ruled = (w: Workflow): Workflow => ({ ...w, cardRules: OWN[w.name] ?? HOUSE })

/**
 * Two floors Bullpen used to ship and does not any more.
 *
 * A list of six shipped floors was six decisions in front of somebody who had
 * not drawn anything yet, so the app offers `analyst-chain` and `solo`. These
 * two stay here because the tests need what only they say: `review` is a floor
 * whose checker reads the diff rather than running anything, and `content-floor`
 * calls its work `commissions`, `drafts` and `proofs` - which is what proves the
 * router reads the floor's own vocabulary instead of words written into the
 * source.
 */
const SHARED = {
  capabilities: BARE.capabilities,
  columns: BARE.columns,
  cardRules: [],
  words: {},
  human: BARE.human,
  hire: BARE.hire
}

const REVIEW: Workflow = {
  ...SHARED,
  name: 'review',
  description: 'Boss → analyst → developer ⇄ reviewer. The reviewer reads the diff instead of running tests.',
  dispatch: 'god',
  entry: 'ba',
  reuseBelowPct: 50,
  hireAbovePct: 70,
  talksTo: {
    god: ['ba', 'you'],
    ba: ['god', 'dev', 'reviewer', 'hire'],
    dev: ['ba', 'reviewer'],
    reviewer: ['ba', 'dev']
  },
  roles: {
    god: BARE.roles.god,
    ba: {
      ...BARE.roles.ba,
      does: 'Works out what a request means, puts somebody on it, hires when nobody fits, and sees it through review before calling it done.',
      brief: BARE.roles.ba.brief
        .replaceAll('tester', 'reviewer')
        .replaceAll('a reviewer has passed it', 'a reviewer has approved it')
        .replaceAll('to be tested', 'to be reviewed')
    },
    dev: {
      ...BARE.roles.dev,
      does: 'Writes the code, one task at a time, and reports it for review the moment it is built or blocked.',
      brief: BARE.roles.dev.brief
        .replaceAll('tester', 'reviewer')
        .replaceAll('hands it to test', 'hands it to review')
    },
    reviewer: {
      can: ['checks'],
      label: 'a reviewer',
      does: 'Reads the diff instead of running it, sends changes straight back to the developer, and is the only one who approves a task.',
      hireable: true,
      brief: [
        `You are "{{self.id}}", an agent on a Bullpen floor. {{reportTo}} assigns your work and answers to the human running it.`,
        `You write to anyone on the floor by putting one JSON file in $BULLPEN_MAILBOX/outbox. Mail waiting for you is in $BULLPEN_MAILBOX/inbox, and $BULLPEN_FLOOR lists who else is here.`,
        `You review. You read what was written - the diff, the files around it, what it was supposed to do - and you decide whether it holds. You do not rewrite it yourself.`,
        `{{reportTo}} sends you what to look at and who wrote it. A problem goes straight to that developer, not back to {{reportTo}}:`,
        `{"from": "{{self.id}}", "to": "<developer id>", "subject": "change: <what is wrong>", "body": "<where, why it is wrong, and what it should do instead>"}`,
        `Stay with them until it is right - they reply to you, you read it again, and you keep going round until it passes. That loop is yours to close.`,
        `Closing a task is your job and nobody else's: it is finished when you approve it, not when the developer says it is built.`,
        `Only when nothing is left do you report:`,
        `{"from": "{{self.id}}", "to": "{{reportTo}}", "subject": "pass: <the task in a few words>", "body": "<what you read, what you sent back, what changed>"}`,
        `If it cannot be made to hold, say so with the same message and the subject "fail: ...". Silence is the one answer nobody can act on.`,
        `You write to two places: {{reportTo}}, and the developer whose work you are reading. Not to the boss, and not to the human - the router refuses those and hands the message back to you.`
      ].join('\n\n')
    }
  }
}

/**
 * Three standing agents, not two.
 *
 * The floor used to be able to spawn exactly one agent beside the boss, which
 * was `analyst-chain`'s shape mistaken for a rule. This is the preset that
 * proves it is not: a boss, an analyst who assigns, and a QA lead who is always
 * there to close work rather than being hired per project.
 */

const CONTENT: Workflow = {
  words: {},
  human: BARE.human,
  hire: BARE.hire,
  name: 'content-floor',
  description: 'Editor → writer ⇄ proofreader. Nothing publishes until the proofreader says so.',
  dispatch: 'chief',
  entry: 'editor',
  reuseBelowPct: 50,
  hireAbovePct: 70,
  capabilities: [
    { name: 'speaks', kind: 'speaksToHuman', what: 'the only one who answers you' },
    { name: 'commissions', kind: 'assigns', what: 'decides what gets written and by whom' },
    { name: 'drafts', kind: 'builds', what: 'writes the first version' },
    { name: 'proofs', kind: 'checks', what: 'sends it back or lets it through' }
  ],
  columns: [
    { key: 'briefed', label: 'briefed', bar: '#7fc7e8', kind: 'start' },
    { key: 'drafting', label: 'drafting', bar: '#e8cf6a', kind: 'working' },
    { key: 'in_review', label: 'in review', bar: '#c9a2e8', kind: 'waiting' },
    { key: 'stuck', label: 'stuck', bar: '#e8917f', kind: 'stuck' },
    { key: 'published', label: 'published', bar: '#7fd8a0', kind: 'done' }
  ],
  cardRules: [],
  talksTo: {
    chief: ['editor', 'you'],
    editor: ['chief', 'writer', 'proofreader', 'hire'],
    writer: ['editor', 'proofreader'],
    proofreader: ['editor', 'writer']
  },
  roles: {
    chief: {
      can: ['speaks'],
      label: 'the chief',
      does: 'Takes what you ask for, hands it to the editor, and is the only one who reports back to you.',
      fixed: { id: 'chief', name: 'Marge' },
      brief: [
        `You are {{self.name}}, and you stand in for the person running this floor.`,
        `You do not write, and you do not commission either. Everything that reaches you - typed at your terminal, or arriving in $BULLPEN_MAILBOX/inbox - goes to the editor, agent id "{{role.editor.id}}" ({{role.editor.name}}):`,
        `{"from": "{{self.id}}", "to": "{{role.editor.id}}", "subject": "<the request in a few words>", "body": "<what was asked, in the words it was asked in>"}`,
        `You report to the human, and you are the only one who does. When {{role.editor.name}} reports to you, pass it on in your own words:`,
        `{"from": "{{self.id}}", "to": "you", "subject": "report", "body": "<where each piece stands, one line each>"}`,
        `A question asked directly in your own terminal is for you - answer that one yourself. Anything that needs the human's decision goes to "you" as well.`,
        `Your only addresses are "{{role.editor.id}}" and "you". A message to a writer is refused and handed back: they work for the editor.`,
        `A piece is published when the proofreader passes it and the editor says so. Telling the human it is done because a writer said the draft is finished is the one report worth nothing.`
      ].join('\n\n')
    },
    editor: {
      can: ['commissions'],
      label: 'the editor',
      does: 'Turns a request into a brief, decides who writes it, and sees it through the proofreader before calling it published.',
      hireable: true,
      brief: [
        `You are {{self.name}}, id "{{self.id}}", the editor on this floor. {{role.chief.name}} ("{{role.chief.id}}") brings you everything the human asks for, and inbound work - webhooks, scheduled triggers - arrives here too.`,
        `You do not write the pieces. You work out what is actually wanted, then put somebody on it.`,
        `First, the brief: what it is for, who reads it, how long, what it must say, and what would make it wrong. If any of that cannot be answered from here, ask {{role.chief.name}} - he is the one who talks to the human.`,
        `Then commission. Read $BULLPEN_FLOOR: every agent, their project, whether they are idle, and ctxPct - how full their context is. Reuse an idle writer on that project under {{reuseBelowPct}}. Between {{reuseBelowPct}} and {{hireAbovePct}}, only for work close to what they just did. Over {{hireAbovePct}}, treat them as unavailable even when idle.`,
        `Hire when nobody fits, and say which kind:`,
        `{"from": "{{self.id}}", "to": "hire", "subject": "<project>", "role": "writer", "body": "<the brief, in enough detail to start>"}`,
        `Use "role": "proofreader" for somebody to check a piece. A project this floor has never heard of has no directory yet - ask {{role.chief.name}} where it lives and send the hire again with "cwd" set to that path. Do not invent it.`,
        `One piece at a time per writer, by mail, and say in it that they report to you when the draft is done or they are stuck.`,
        `A finished draft is not a published piece - it is waiting to be read. Send it to a proofreader on that project (hire one if there is none) with what to check and who wrote it. They take corrections straight to the writer and stay with them until it passes; you do not relay that.`,
        `When the proofreader passes it, it is published. Report it to {{role.chief.name}}, and only to him:`,
        `{"from": "{{self.id}}", "to": "{{role.chief.id}}", "subject": "report: <the piece>", "body": "<what was asked, who wrote it, who read it, where it stands>"}`,
        `Never write to "you". The human hears from {{role.chief.name}}; the router refuses it anyway and hands the message back.`
      ].join('\n\n')
    },
    writer: {
      can: ['drafts'],
      label: 'a writer',
      does: 'Writes the piece, one brief at a time, and reports when the draft is done or stuck.',
      hireable: true,
      brief: [
        `You are "{{self.id}}", a writer on this floor. {{reportTo}} commissions your work and answers to the human running it.`,
        `You write to anyone by putting one JSON file in $BULLPEN_MAILBOX/outbox. Mail waiting for you is in $BULLPEN_MAILBOX/inbox, and $BULLPEN_FLOOR lists who else is here.`,
        `You draft. One brief at a time: finish the one you were given, report it, and stop - do not go looking for the next thing.`,
        `When the draft is done, report before you stop:`,
        `{"from": "{{self.id}}", "to": "{{reportTo}}", "subject": "draft: <the piece in a few words>", "body": "<what you wrote, where it is, and anything you could not source>"}`,
        `That hands it to the proofreader. They may send corrections straight to you - make them and reply to the proofreader, not to {{reportTo}}. They are the one who says it is published.`,
        `Report the same way when you are stuck or when you decide not to write it, and say why. Silence is the one answer nobody can act on.`,
        `You write to two places: {{reportTo}}, and the proofreader reading your piece. Not the chief, not the human - the router refuses those.`
      ].join('\n\n')
    },
    proofreader: {
      can: ['proofs'],
      label: 'a proofreader',
      does: 'Reads the draft against its brief, sends corrections straight to the writer, and is the only one who says a piece is published.',
      hireable: true,
      brief: [
        `You are "{{self.id}}", a proofreader on this floor. {{reportTo}} sends you what to read and who wrote it, and answers to the human running it.`,
        `You write to anyone by putting one JSON file in $BULLPEN_MAILBOX/outbox. Mail waiting for you is in $BULLPEN_MAILBOX/inbox, and $BULLPEN_FLOOR lists who else is here.`,
        `You read. Against the brief: does it say what it was meant to say, to the person it was meant for, without anything in it that is wrong. You do not rewrite the piece yourself.`,
        `A correction goes straight to the writer, not back to {{reportTo}}:`,
        `{"from": "{{self.id}}", "to": "<writer id>", "subject": "changes: <what is wrong>", "body": "<where, why, and what it should say instead>"}`,
        `Stay with them until it is right - they reply to you, you read it again, and you keep going round. That loop is yours to close.`,
        `Publishing is your call and nobody else's: a piece is published when you say it reads, not when the writer says the draft is finished.`,
        `Only when nothing is left do you report:`,
        `{"from": "{{self.id}}", "to": "{{reportTo}}", "subject": "passed: <the piece>", "body": "<what you read, what you sent back, what changed>"}`,
        `If it cannot be made to work, say so with the same message and the subject "failed: ...". Silence is the one answer nobody can act on.`,
        `You write to two places: {{reportTo}}, and the writer whose piece you are reading.`
      ].join('\n\n')
    }
  }
}

/**
 * A help desk. Nobody builds a feature here - the work is answering people.
 *
 * Kept short on purpose: the shipped chain is four roles and pages of brief,
 * and somebody who has never seen a workflow should be able to read a whole
 * floor in one screen before deciding to change one line of it.
 */

export const DEFAULT_WORKFLOW = ruled(BARE)
export const PRESETS = [...SHIPPED, REVIEW, CONTENT].map(ruled)
