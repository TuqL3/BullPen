# Rules

Every floor is declared against this. Nothing outside it exists: a line the
rules do not name is refused rather than ignored, and a check the rules do not
list is not run.

Each entity below says what may be written about one of those things. A field
line reads `name · type · flags`, separated by `·`.

## types

- `text` — one line of anything
- `sentence` — one line, meant to be read out loud
- `prose` — as many lines as it takes
- `percent` — a whole number, 0 to 100
- `colour` — `#rgb` or `#rrggbb`
- `path` — a directory. `~` is your home
- `agent` — an id and a display name: `michael · Michael`
- `role` `capability` `column` — the name of one declared elsewhere here
- `address` — `you` and `hire`, under whatever this floor calls them
- `list of X` — several of X, comma separated
- `one of a, b, c` — exactly one of those words
- `X or Y` — either

## entity: capability

What the work is called on this floor. A name and a sentence, and nothing else:
what the app does with a role is read off the card rules and `talks to`.

- name · text · required · unique
- what · sentence

## entity: role

Somebody on the floor: what they are called, what they may do, who they may
write to, and what they are told the moment they start.

- id · text · required · unique · match ^[\w-]+$
- label · sentence · required
- does · sentence · required
- can · list of capability
- talks to · list of role or address · required
- agent · agent
- hireable · flag
- cli · text
- cwd · path
- never · list of text
- brief · prose · required
- «your own» · text · any other line becomes {{that name}} in this role's brief

## entity: column

One column of the board. The key is what a card is stored under; the purpose is
what the app reaches for when it moves a card without anybody sending a message.

- key · text · required · unique
- label · text · required
- colour · colour
- purpose · one of start, working, waiting, stuck, done

## entity: card rule

What happens to a card when one of these writes to one of those. The first rule
that matches is the one that runs, so the order matters.

- when · role or capability or anyone or staff · required
- writes to · role or capability or anyone or staff or address · required
- then · one of opens, closes · or column · required
- whose · one of sender, receiver · default sender
- when · sentence · why the rule is there, in your words. Shown on the line

## entity: floor

The floor itself: what it is called, where work arrives, what agents call you,
and how full an agent may be before it is left alone.

- name · text · required
- description · sentence
- dispatch · role · required
- entry · role · required
- human address · text · default you
- hire address · text · default hire
- reports to you · role
- hires · role
- hire above · percent · default 70 · at or over this much of its context window an agent is too full to take the next piece of work, and a new one is hired for that role. Below it anybody takes work - idle first, and one mid-turn joins their board and starts it when that turn ends
- «your own» · text · any other line becomes {{that name}} in every brief

## placeholders

What a brief may say and have filled in when the agent starts. Anything else in
braces is left standing, so a mistake is visible in the agent's own terminal
rather than quietly blank.

- `{{self.id}}` — the agent's own id
- `{{self.name}}` — its name on the roster
- `{{reportTo}}` — whoever the work comes back to
- `{{role.<name>.id}}` — another role's agent, by role name
- `{{role.<name>.name}}` — the same, as a name
- `{{hireAbovePct}}` — the hire threshold
- `{{your own}}` — anything declared on the role or the floor

Declare the floor's own under a `## words` section, one per line, and every
brief may then use it:

```
## words
- {{workdir}} — .claude/work/<slug>
- {{rules}} — rules/engineering.md
```

A brace nothing declares reaches the agent as the brace itself, which is what
`brief-placeholders` is for.

## law

Each line here is a check that runs against every floor. There are seven: a
floor is otherwise whatever you drew, and nothing else is refused for being
half-finished or for not looking like the one Bullpen ships.

- `dispatch-hands-off` — the role a task is typed at must be able to write to at least one other role. It decides who does the work; it is not the one who does it.
- `lines-have-rules` — on a floor that writes its own card rules, every line between two roles must be covered by one, or work handed along it moves nothing and the board says nobody is working.
- `brief-placeholders` — every `{{...}}` a brief writes must be one the app fills in or one this floor declares under `## words`, or the agent is handed the braces themselves in its own system prompt.
- `dispatch-reports` — on a floor that writes its own card rules, one of them must say what the dispatch role telling the human does to the board, or the card opened when a task is typed at the floor never closes.
- `closes-is-a-check` — only a role holding a capability marked `(checks)` may write `closes it`. Closing finishes the sender's card and the work being checked, so writing it anywhere else makes that role a checker without saying so.
- `cards-open-and-close` — on a floor that writes its own card rules, a rule may only move a card for somebody another rule opens one for, and every role given a card must have a rule that finishes it. A card that was never opened cannot move, and one nothing closes is left on the board after every task.
- `capabilities-have-kinds` — every role holds at least one capability that says in brackets which of the four it behaves like. The name is the floor's own; the bracket is what answers "who hands work out", "who does it", "who decides it passed" and "who answers the human", and a role with no bracket anywhere is classified by whatever is left over. A word named for one of the four says which it is by saying it, and an unbracketed one beside a bracketed one is a name for the card rules to match on.

Add another by writing its id and what it should say - the ids the app knows are
`names-exist`, `one-voice`, `voice-is-told`, `must-open`, `must-finish`,
`dispatch-has-agent`, `dispatch-hands-off`, `lines-have-rules`, `builds-exist`,
`can-hire`, `reachable`, `brief-obeys-talks-to`, `thresholds-ordered`,
`no-blanks`, `unique-keys`, `roles-are-complete`, `brief-placeholders`,
`dispatch-reports`, `closes-is-a-check`, `cards-open-and-close`,
`capabilities-have-kinds` and `addresses-are-not-roles`. An id nothing knows is
ignored. Take a line out and that check stops running.
