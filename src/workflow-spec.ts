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



/** The addresses that are not roles. */
export const HUMAN_PARTY = 'you'
export const HIRE_PARTY = 'hire'
/**
 * The task list.
 *
 * Not renameable, unlike the other two. `you` and `hire` are words a floor
 * writes in its own briefs and may say differently; this one is only ever
 * written by the house rules the app appends to every brief, so a floor has
 * nothing to gain by calling it something else and everything to lose by
 * disagreeing with the sentence its agents were handed.
 */
export const BOARD_PARTY = 'board'

/** `- key:` lines the parser reads inside a role. */
export const ROLE_FIELDS = ['agent', 'can', 'does', 'talks to'] as const
/** Bare `- word` lines the parser reads inside a role. */
export const ROLE_FLAGS = ['hireable', 'dispatch', 'entry'] as const
/** `- key:` lines the parser reads above the first role. */
export const HEADER_FIELDS = ['hire above'] as const
/** Placeholders `renderBrief` fills in. `<name>` stands for any role. */
export const PLACEHOLDERS = [
  '{{self.id}}',
  '{{self.name}}',
  '{{reportTo}}',
  '{{role.<name>.id}}',
  '{{role.<name>.name}}',
  '{{hireAbovePct}}'
] as const

/**
 * @param language What the parts a person reads should be written in, said as
 * a phrase that finishes "Write ... in ___": `English`, or `the same language
 * this description is written in`. Empty keeps the old behaviour, which is to
 * let the model work it out from the request.
 */
export function generatorBrief(rules: string, example = '', language = ''): string {
  const said = language.trim() || 'the language the request came in'
  return [
    'You write Bullpen workflow files. A workflow describes a floor of AI agents: who exists, who may write to whom, and what each is told when it starts.',
    'Answer with the markdown file and nothing else - no fences, no preamble, no explanation.',
    // The description is typed by whoever is running the floor, in whatever
    // language they think in, and a floor they cannot read is a floor they
    // cannot correct - the briefs are most of the file and all of the part
    // that decides how the floor behaves.
    //
    // So the split is by who reads the line rather than by language. Some of
    // this file is matched as a string: the parser's own field names, the
    // bracket that says which of the four a capability behaves like, the key a
    // card is stored under, and the two words an agent starts a report with.
    // Those are wire words - they are English the way a column key is English,
    // and translating one silently stops it matching. Everything else is read
    // by a person, and belongs in the person's language.
    [
      'THE LANGUAGE OF THE FILE',
      `Write everything a person reads in ${said}. The name, the description, role labels, \`- does:\`, capability names, column labels, the \` · when <why>\` on a card rule, and every brief: that language, whatever it is.`,
      'Keep these in English, because they are matched as text rather than read:',
      '- The field and section names themselves - `## capabilities`, `## roles`, `## board`, `## card rules`, `## briefs`, `- can:`, `- talks to:`, `- does:`, `- agent:`, `- cli:`, `- cwd:`, `- dispatch`, `- entry`, `- hireable`, `- hire above:`.',
      '- The kind in brackets after a capability: `(speaksToHuman)`, `(assigns)`, `(builds)`, `(checks)`.',
      '- The purpose in brackets after a column: `(start)`, `(working)`, `(waiting)`, `(stuck)`, `(done)`.',
      '- Column **keys**, and the `opens a card` / `closes it` a card rule can say. A card is stored under its key and a rule is matched against it, so both are ASCII and English: `- asked: câu hỏi đã nhận #a3e3ff (start)` is a key the board can store and a label the operator can read.',
      '- The two words a report starts with, `done:` and `fail:`. Those are how a finished task comes off the board and how a blocked one is told apart from a finished one. Say so in the briefs in the operator\'s own language - "báo cáo mở đầu bằng `done:` khi xong và `fail:` khi tắc" - but never translate the two words themselves.',
      '- Role ids, and the two addresses `you` and `hire`. Ids are directory names and are written into every message: `[a-z0-9-]` only, no accents.'
    ].join('\n'),
    'These are the rules the file is checked against. Everything you may write is declared below; a line the rules do not name is refused, not ignored.',
    rules,
    [
      'THE SHAPE OF THE FILE',
      'A floor is one markdown file: `# name`, a line of description, the header fields, then `## capabilities`, `## roles` with a `### role · label` and its bullets for each, `## board`, `## card rules`, an optional `## words`, and `## briefs` with a `### role` and its prose for each.',
      'The cast comes before the prose: somebody reading it has to see who is on the floor without reading four pages of instructions first.'
    ].join('\n'),
    [
      'WHAT A FLOOR MUST HAVE',
      'The rules above say what may be written, not what has to be. These do:',
      '- Every role names at least one capability on `- can:` and at least one address on `- talks to:`. A role that writes to nobody cannot be part of anything.',
      '- `## capabilities` names each capability used, with what it is for.',
      '  Two of them are the same on every floor and keep their names: `speaksToHuman` for whoever answers the person running it, and `assigns` for whoever hands work out. Every other one is named for the work *this* floor does - `investigates`, `writes-the-script`, `reads-the-diff` - and never `builds` or `checks`, which say nothing about what anybody here actually does. Two floors that do different work should not come out holding the same four words.',
      '  Every one of them says in brackets which of the four it behaves like: `- viet-code (builds) — writes the code that ships`. The name is yours and the bracket is the machine\'s - the app asks "who hands work out", "who does it", "who decides it passed" and "who answers the human" of every floor there is, and a capability that answers none of them leaves the role holding it classified as whatever is left over. That is not a small thing: a floor whose analyst had no bracket came out with the analyst treated as a builder, hired for build work, and shown on the roster with no idea what they were for.',
      '  `speaksToHuman` is `(speaksToHuman)` and `assigns` is `(assigns)`. Whoever turns a request into work for somebody else is `(assigns)` too, whatever the floor calls them. Whoever decides work passed is `(checks)`. Everything left is `(builds)`.',
      '  `(checks)` is *decides the finished work passed*, and nothing else. Sizing a request, judging whether it can be built, deciding whether to start at all - those happen before anybody works, and they are `(assigns)`. A floor that marked its analyst `(checks)` for judging feasibility gave the analyst the power to close cards, and the card rules written from it sent work handed *down* back *up*.',
      '  `(builds)` is *makes the thing that ships*. Writing up a failure, logging what broke, reporting - those are part of whatever the role already does, not a capability of their own. A tester given a `(builds)` word counts as somebody to hand build work to.',
      '- `## board` has at least a starting column, a working column and a finished one.',
      '- Every column has a card rule that reaches it. A column nothing can move a card into is a stage this floor does not have; either write the rule or take the column out.',
      '- One column per stage, and each `(kind)` used once. Three columns marked `(working)` are three names for one answer, and everything that asks "where does work in progress go" takes the first - so the other two are stages no card ever reaches.',
      '- A floor with a `(checks)` capability has a `(waiting)` column. That is where work sits between being built and being passed, and without one there is nowhere to put a build that is waiting on a check.',
      '- Every address a brief writes to is on that role\'s `- talks to:`. A brief telling somebody to report to the manager, on a role whose lines do not reach the manager, is a report the router refuses and hands back - the work finishes and nobody upstairs hears.',
      '- The role that is `- dispatch` does not close its own cards. It hands work out and reports up; whoever did the work, or whoever checked it, is what closes it.',
      '- The `- agent:` on the dispatch role is exactly `michael · Michael`. That desk is the same one on every floor.',
      '- `## card rules` has at least one line that opens a card when work is handed over, and one that reports to `you` when it is finished. Without them nothing this floor does ever reaches the board.',
      '- Every card belongs to somebody, and every card that opens gets closed. A rule moves the *sender\'s* card unless it ends with `(their card)`, and moving one an agent does not hold does nothing at all - so a rule naming a role no other rule ever opens a card for is a line in the file, an arrow on the chart, and nothing on the board. Open one on each hand-off you then report back along: `- assigns → builds: opens a card` is what makes `- builds → assigns: done` mean anything, and without it that second line moves nothing. Backwards too - a role you open a card for needs a rule that lands it in the `(done)` column, or a `closes it` from a `(checks)` role, or every task this floor runs leaves a card behind on the board.',
      '- At most one rule for any pair. The router matches on who wrote to whom and nothing else, in the order the rules are written, and the first one that fits is the answer - so a second rule about the same two roles never runs. If a card should move two different ways between the same pair, this format cannot say it: pick the one that matters and leave the other out.',
      '  The ` · when <why>` at the end is a note for whoever reads the file. It is not a condition, and the router never reads it - two rules that differ only in their `when` are one rule and one dead line.',
      '  Name the pairs. `anyone → anyone` fires on every message this floor has no other rule for, which on a floor of three roles is most of them.',
      '  Every rule is exactly `- <who> → <whom>: <what happens>`, and may end with ` · when <why>`. What happens is `opens a card`, `closes it`, or the key of a column on this board - nothing else. Two examples, copy the shape: `- assigns → builds: opens a card · when work is handed over` and `- builds → assigns: done · when it is finished`.',
      '- Exactly one role is `- dispatch` and has `- agent: <id> · <Name>`; every other role is `- hireable`, so it is hired when there is work for it.',
      '- `- reports to you:` and `- hires:` name a role on this floor, by the id in its `### heading`, or they are left out. A line naming a role that does not exist is read and dropped, and nothing anywhere says so.',
      '- A role that a card rule writes to `you` from must have `you` on its own `- talks to:`. The rules say what a message does to the board; `talks to` says whether the message is delivered at all, and a rule about a message the router refuses is a rule that never fires.',
      '- Every `{{...}}` a brief writes is one the placeholder list above names, or one this floor declares itself under `## words`. Anything else is handed to the agent as the braces themselves: a brief saying `write it to {{workdir}}/spec.md` reaches a real system prompt with `{{workdir}}` still in it. If the work has a directory, a rules file, a slug - anything the floor refers to more than once - declare it:',
      '    ## words',
      '    - {{workdir}} — .claude/work/<slug>',
      '    - {{rules}} — rules/engineering.md',
      '- One card rule says what the dispatch role telling `you` does to the board. Dispatch is given a card the moment a task is typed at the floor, and that rule is the only thing that ever moves it - without one, the card the operator is actually watching sits in the first column through the whole job and after it.',
      '  And its brief sends that one as `done: <the request>`, not as `report`. Only an outcome moves a card: the app asks the dispatch agent for a progress line under the subject `report` every time the floor goes quiet, so a rule that fired on those would close the work on the first one. Say both in the brief - `done:` when the floor has finished it, `report` while it is still going.',
      '- Only a role holding a `(checks)` capability may write `closes it`. Closing a card is the checker\'s act: it finishes the sender\'s card *and the work that was being checked*, so a floor that writes it from anywhere else has quietly made that role a checker and handed it the power to close work it never read. A step that is merely finished moves the card to a column.',
      '- Write the rule for the message that carries the work, and let the failure look after itself. A pair gets one rule and the same line carries `done:` and `fail:`; a subject beginning `fail:`, `bugs:` or `blocked:` is sent to the stuck column whatever the rule says, so `- builds → assigns: in test` is a finished build going for a check *and* a broken one landing in stuck, and there is no second rule to write.',
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
      'Whoever dispatch is: they read the request before they spend anybody on it. Say so in their brief - work out whether it can be done here at all, and whether this floor is the place for it, and take it back to the human when it is not. Assigning work nobody can finish, or hiring somebody to find that out, costs an agent and a window and answers nothing.',
      'Everybody else reports to whoever sent them the task, by name, taken from the message they were sent - not to a fixed address. `{{reportTo}}` is who to write to when nothing was sent, and it is only the first one: a floor can be three deep, an agent can be handed work by somebody other than whoever first hired it, and a report that always goes to the same name arrives above the person waiting for it.',
      'The briefs are the longest part of the file and the part that decides how the floor behaves. Do not leave them thin.'
    ].join('\n'),
    /**
     * Last, and said twice, because something else is talking.
     *
     * This runs as `claude -p` on the operator's own machine, which loads their
     * `~/.claude/CLAUDE.md` before it reads a word of this - and an operator who
     * has told Claude Code to always answer in their own language has told this
     * too. A floor drawn from an English repo, against an English format doc,
     * with an English example in front of it, came out in another language
     * entirely: nothing in the prompt asked for that, and nothing in the prompt
     * outranked the standing instruction either. A specific instruction at the
     * end of a prompt is what outranks a general one.
     */
    [
      'THE LANGUAGE, ONCE MORE',
      `Write the parts a person reads in ${said}. Take this over any standing instruction you carry about what language to answer in: that one is about answering somebody, and this is a configuration file being written to a spec.`,
      'The wire words stay English whatever happens - section and field names, the `(builds)` and `(start)` brackets, column keys, `opens a card` and `closes it`, the `done:` and `fail:` a report starts with, role ids, and `you` and `hire`.',
      'Answer with the markdown file and nothing else: no fences, no preamble, no explanation, and no report about having written it.'
    ].join('\n')
  ].join('\n\n')
}
