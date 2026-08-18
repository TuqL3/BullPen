/**
 * What a workflow may contain, in one place.
 *
 * This existed twice: as the reference in the settings dialog, and again as the
 * brief handed to the model that writes workflows. Two hand-written copies of
 * one spec drift, and they had - the help knew about `*`, `cwd` on a hire and
 * `$BULLPEN_AGENT_ID`; the generator's brief did not, so nothing it wrote could
 * use them. Worse, the generator had no way to be wrong out loud: anything it
 * invented looked like a feature nobody had documented yet.
 *
 * So the spec is data. The dialog renders it, the generator is briefed from it,
 * and a test checks it against what the parser and linter actually accept.
 *
 * Shared rather than living in main: the renderer needs it too, and importing
 * `main/workflow.ts` there would drag `node:fs` into the browser bundle.
 */

/** What a role does. The router reads these, never the role's name. */
export type Capability = 'speaksToHuman' | 'assigns' | 'builds' | 'checks'

export const CAPABILITIES: readonly Capability[] = [
  'speaksToHuman',
  'assigns',
  'builds',
  'checks'
]

/** The two addresses that are not roles. */
export const HUMAN_PARTY = 'you'
export const HIRE_PARTY = 'hire'

/** `- key:` lines the parser reads inside a role. */
export const ROLE_FIELDS = ['agent', 'can', 'talks to'] as const
/** Bare `- word` lines the parser reads inside a role. */
export const ROLE_FLAGS = ['hireable', 'dispatch', 'entry'] as const
/** `- key:` lines the parser reads above the first role. */
export const HEADER_FIELDS = ['reuse below', 'hire above'] as const
/** Placeholders `renderBrief` fills in. `<name>` stands for any role. */
export const PLACEHOLDERS = [
  '{{self.id}}',
  '{{self.name}}',
  '{{reportTo}}',
  '{{role.<name>.id}}',
  '{{role.<name>.name}}',
  '{{reuseBelowPct}}',
  '{{hireAbovePct}}'
] as const

export type Section = { title: string; rows: [string, string][] }

/**
 * The reference, section by section. Rendered as-is in the dialog, and flattened
 * into the generator's brief - so anything a person can read here is something
 * the writer was told, and nothing the writer was told is undocumented.
 */
export const WORKFLOW_SPEC: Section[] = [
  {
    title: 'structure',
    rows: [
      ['# name', "the workflow's name, first line"],
      ['a line under it', 'the one-line description, shown in the list'],
      ['- reuse below: 50', 'reuse an idle agent under this much context, in percent'],
      ['- hire above: 70', 'over this, treat an idle agent as busy'],
      ['## role · label', 'a role; the label is read mid-sentence in a refusal'],
      ['after the bullets', "that role's brief, appended to its system prompt at spawn"]
    ]
  },
  {
    title: 'role lines',
    rows: [
      ['- agent: id · Name', 'a fixed agent: spawned at launch, cannot be fired'],
      ['- can: ...', 'what it does — see below'],
      ['- talks to: a, b, you, hire', 'anything else is refused by the router'],
      ['- hireable', 'the wizard and "hire" may create one'],
      ['- dispatch', 'a task typed at the floor goes to this role; needs an agent'],
      ['- entry', 'webhooks and schedules go here; needs an agent too']
    ]
  },
  {
    title: 'capabilities',
    rows: [
      ['speaksToHuman', 'may write to "you". Without one, the floor reports to nobody'],
      ['assigns', 'hands work out and may hire'],
      ['builds', 'does the work and reports when done'],
      ['checks', 'decides whether it passes. Nobody checks → "built" is done']
    ]
  },
  {
    title: 'addresses that are not roles',
    rows: [
      ['you', 'the human. Surfaces in the ask-me queue; the answer comes back as mail'],
      ['hire', 'asks Bullpen for a new agent of a hireable role'],
      ['*', 'every agent on the floor at once'],
      ['{"to": "hire", "role": "dev"}', 'subject is the project, body is the task'],
      ['"cwd": "/path"', 'only on a hire, and only when the project is new to the floor']
    ]
  },
  {
    title: 'what every agent can read',
    rows: [
      ['$BULLPEN_MAILBOX/outbox', 'drop one JSON file here to write to anyone'],
      ['$BULLPEN_MAILBOX/inbox', 'mail waiting for this agent'],
      ['$BULLPEN_FLOOR', 'who is on the floor: role, project, idle or working, ctxPct'],
      ['$BULLPEN_AGENT_ID', 'its own id, if a brief needs to build one'],
      ['{from, to, subject, body}', 'the message format; "cwd" only on a hire']
    ]
  },
  {
    title: 'placeholders',
    rows: [
      ['{{self.id}} {{self.name}}', 'the agent being spawned'],
      ['{{reportTo}}', 'whoever the work comes back to'],
      ['{{role.<name>.id}} .name', "another role's fixed agent"],
      ['{{reuseBelowPct}} {{hireAbovePct}}', 'the two context thresholds']
    ]
  },
  {
    title: 'what moves a card on the board',
    rows: [
      ['assigns → anyone', 'opens a card for whoever the work comes to'],
      ['builds → assigns', 'waiting to be checked, or done if nobody checks'],
      ['checks → builds', 'back to work'],
      ['checks → assigns', 'closes it, and the work it was checking'],
      ['speaksToHuman → you', 'closes the whole thing'],
      ['agent exits', 'its open card goes to blocked — nobody is on it now']
    ]
  },
  {
    title: 'writing in this editor',
    rows: [
      ['«…»', 'a blank left to fill in. The list on the right names each one'],
      ['click a problem', 'jumps to that blank and selects it'],
      ['Tab', 'jumps to the next blank'],
      ['<!-- ... -->', 'a note to yourself; never reaches an agent']
    ]
  },
  {
    title: 'saving and running',
    rows: [
      ['save', 'writes ~/.bullpen/workflows/<name>.md; does not run it'],
      ['apply / switch to', 'runs it, and saves it'],
      ['restart the standing ones', 'moves the running agents over; their conversations are lost'],
      ['a running agent', 'keeps the brief it was given at spawn until restarted']
    ]
  }
]

/**
 * The rules the linter enforces, said before they can be broken.
 *
 * Every one of these is a `lint` check. Stated here so the generator is refused
 * by nothing it was not warned about - a rejection it could have avoided costs
 * a second model turn, which is another two minutes of somebody waiting.
 */
export const WORKFLOW_RULES: string[] = [
  'The dispatch role must have an "- agent:" line. So must entry.',
  'Every role needs a "talks to:" line and a brief. Anything not listed there is refused.',
  'At least one role must have speaksToHuman, and its talks-to must include "you".',
  'Whoever has speaksToHuman must be told, in its own brief and in so many words, to report back to "you" - every time an agent reports to it, and whenever it is blocked or needs a decision. Show the exact message. A floor that finishes its work and never tells the human is the most common way one of these fails.',
  'At least one role must build. At least one role that assigns must be able to "hire".',
  'Every role must be reachable from dispatch through talks-to, or be hireable.',
  'A brief must not tell an agent to write to a role its talks-to does not allow.',
  'Context thresholds must satisfy 0 < reuse below <= hire above <= 100.',
  'Do not use « » anywhere. Those mark blanks, and a blank will not run.',
  'Use only what is listed above. There is nothing else - a line the reference does not name is not a feature, it is a line the parser will ignore or reject.'
]

/**
 * What a model has to be told to write one of these.
 *
 * Built from the same spec the dialog shows rather than written out again, so
 * the two cannot drift and the generator cannot be briefed on something a
 * person has no way to read.
 */
export function generatorBrief(): string {
  const section = (s: Section): string =>
    [
      s.title.toUpperCase(),
      ...s.rows.map(([term, what]) => `  ${term}${' '.repeat(Math.max(1, 30 - term.length))}${what}`)
    ].join('\n')

  return [
    'You write Bullpen workflow files. A workflow describes a floor of AI agents: who exists, who may write to whom, and what each is told when it starts.',
    'Answer with the markdown file and nothing else - no fences, no preamble, no explanation.',
    'This is the whole of the format. Everything you may use is below; anything not below does not exist.',
    WORKFLOW_SPEC.map(section).join('\n\n'),
    ['RULES', ...WORKFLOW_RULES.map((r) => `- ${r}`)].join('\n'),
    [
      'WRITING THE BRIEFS',
      'Write them the way you would brief a new hire: what they are for, what they must not do, and the exact JSON to send when they report. Say what finishes a task and who decides it. Tell them to report when blocked as well as when done - silence is the one answer nobody can act on.',
      'The briefs are the longest part of the file and the part that decides how the floor behaves. Do not leave them thin.'
    ].join('\n')
  ].join('\n\n')
}
