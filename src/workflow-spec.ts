/**
 * The words the parser reads, and the document that explains them.
 *
 * The explanation used to be this file: nine sections of `[term, description]`
 * pairs, rendered by the settings dialog and flattened into the brief handed to
 * the model that writes workflows. A reference written as TypeScript arrays is
 * a reference nobody edits without a build, and it made the format look like
 * code when the format is a document.
 *
 * So the document is `workflow-format.md`, beside this file. The dialog renders
 * it, the generator is briefed with it, and a test checks that every line the
 * parser actually reads is named somewhere in it - a feature the code has and
 * the document does not is a feature nobody can find.
 *
 * What stays here is only what code has to agree on: the exact words the parser
 * matches and the capabilities the router implements. Adding a name to this
 * list does not make the router understand it; adding one to the document does
 * not either. Both are how a feature gets described, not how it gets built.
 */

/**
 * What a capability is *for*, as far as the floor is concerned.
 *
 * A workflow names its own capabilities - `drafts`, `edits`, `collects` - and
 * says which of these four each one behaves like. Four, because that is what
 * anything outside the card rules has to know: who answers the human, who hands
 * work out, who does it, and who decides it passed. A fifth would be a fifth
 * question nothing asks.
 */
export type CapabilityKind = 'speaksToHuman' | 'assigns' | 'builds' | 'checks'

export const CAPABILITY_KINDS: readonly CapabilityKind[] = [
  'speaksToHuman',
  'assigns',
  'builds',
  'checks'
]

/**
 * A capability name. Any word the workflow declares, so this is a string.
 *
 * It was a union of the four kinds, which is why a floor of writers had to call
 * its editor a `tester`: the word was the mechanism. The word is now the
 * operator's, and the mechanism is what the workflow says the word behaves like.
 */
export type Capability = string



/** The two addresses that are not roles. */
export const HUMAN_PARTY = 'you'
export const HIRE_PARTY = 'hire'

/** `- key:` lines the parser reads inside a role. */
export const ROLE_FIELDS = ['agent', 'can', 'does', 'talks to'] as const
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

export function generatorBrief(rules: string, example = ''): string {
  return [
    'You write Bullpen workflow files. A workflow describes a floor of AI agents: who exists, who may write to whom, and what each is told when it starts.',
    'Answer with the markdown file and nothing else - no fences, no preamble, no explanation.',
    'These are the rules the file is checked against. Everything you may write is declared below; a line the rules do not name is refused, not ignored.',
    rules,
    [
      'THE SHAPE OF THE FILE',
      'A floor is one markdown file: `# name`, a line of description, the header fields, then `## capabilities`, `## roles` with a `### role · label` and its bullets for each, `## board`, `## card rules`, and `## briefs` with a `### role` and its prose for each.',
      'The cast comes before the prose: somebody reading it has to see who is on the floor without reading four pages of instructions first.'
    ].join('\n'),
    [
      'WHAT A FLOOR MUST HAVE',
      'The rules above say what may be written, not what has to be. These do:',
      '- Every role names at least one capability on `- can:` and at least one address on `- talks to:`. A role that writes to nobody cannot be part of anything.',
      '- `## capabilities` names each capability used, with what it is for.',
      '- `## board` has at least a starting column, a working column and a finished one.',
      '- `## card rules` has at least one line that opens a card when work is handed over, and one that reports to `you` when it is finished. Without them nothing this floor does ever reaches the board.',
      '  Every rule is exactly `- <who> → <whom>: <what happens>`, and may end with ` · when <why>`. What happens is `opens a card`, `closes it`, or the key of a column on this board - nothing else. Two examples, copy the shape: `- assigns → builds: opens a card · when work is handed over` and `- builds → assigns: done · when it is finished`.',
      '- Exactly one role is `- dispatch` and has `- agent: <id> · <Name>`; every other role is `- hireable`, so it is hired when there is work for it.',
      'An empty `- can:`, an empty `- talks to:`, or an empty section is not a floor. Fill them.'
    ].join('\n'),
    ...(example
      ? [
          [
            'A COMPLETE FILE',
            'This is a whole floor, with a note on the lines that matter. Copy its shape exactly - the same sections, the same punctuation, the same order. The `«...»` are blanks to replace, and the field names in the rules above are field names, never values: a capability is called what it does on your floor, not "name".',
            example
          ].join('\n\n')
        ]
      : []),
    [
      'WRITING THE BRIEFS',
      'Write them the way you would brief a new hire: what they are for, what they must not do, and the exact JSON to send when they report. Say what finishes a task and who decides it. Tell them to report when blocked as well as when done - silence is the one answer nobody can act on.',
      'The briefs are the longest part of the file and the part that decides how the floor behaves. Do not leave them thin.'
    ].join('\n')
  ].join('\n\n')
}
