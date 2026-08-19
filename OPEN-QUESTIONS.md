# Open questions

Assumptions made while building Phase 1, and what breaks if each is wrong.

## Verified against the real `claude` CLI

Run `npm run verify:hook` to re-check. It costs tokens, so it is not in
`npm test`. Re-run it after every Claude Code update — this is a contract with
an external tool, not with our own code.

Result on 2026-08-16, Claude Code with `--dangerously-skip-permissions`, agent
instructed to run `rm -rf ./doomed`:

**1. `PreToolUse` hooks still fire when permission prompts are suppressed.**
CONFIRMED. The hook intercepted the Bash call, the classifier flagged it as
`recursive/forced delete`, the deny reached the agent, and the decoy directory
survived. The agent reported the block and stopped rather than retrying.

**2. `matcher: "*"` matches every tool.** CONFIRMED. Both `"*"` and `"Bash"`
intercepted identically, so the wildcard is not silently matching nothing.

**3. `--settings <path>` is honoured and leaves the user config alone.**
CONFIRMED. The sha256 of `~/.claude/settings.json` was unchanged across both
rounds.

## Resolved — agents never started (workspace trust)

**FIXED** by auto-answering the prompt, narrowly. See `src/main/trust.ts` and
the SECURITY section of the README for the guards. Verified end to end: three
agents in three fresh directories all cleared the prompt and reached a live
Claude Code prompt, with one log line per acceptance naming the directory.

The decision was the user's, taken with the alternatives on the table. The
argument for it: the human designates the exact directory in the wizard's
Workspace step, under a warning, so the trust prompt asks the same question a
second time. The standing objection, worth re-reading before this is ever
widened: a harness that clicks through safety dialogs will click through the
next one too. The guards exist to keep this from generalising.

Original report follows.

Claude Code shows an interactive **workspace trust** prompt ("Quick safety
check: Is this a project you created or one you trust?") on first run in an
unknown directory. Every agent Bullpen spawns sits on it forever. Confirmed by
screenshot with three agents in three fresh directories.

`--dangerously-skip-permissions` does not skip it. Per `claude --help`, the
dialog is only skipped in non-interactive mode (`-p`, or when stdout is not a
TTY) — which is exactly why `npm run verify:hook` never hit it, and why this
went unnoticed until the UI showed real terminals.

Options, none chosen yet:

| Option | Cost | Objection |
|---|---|---|
| Watch the pty for the prompt and send Enter | small | Bullpen auto-confirms a security dialog on the human's behalf |
| Pre-seed Claude Code's trust store for the sandbox dir | small | writes to the user's `~/.claude.json`, which Bullpen has so far refused to touch |
| Leave it — the human presses Enter in the terminal | zero | one manual confirmation per agent, which defeats hiring a floor of them |

Argument for option 1: the human already designated that exact directory in the
wizard's Workspace step, under a warning about what the agent may do there. The
trust prompt asks the same question a second time. Argument against: a harness
that clicks through safety dialogs is a harness that will click through the next
one too. Needs a decision, not a default.

## Measured, then rejected: busy/idle by watching the terminal

Agent busy/idle status is the dependency under the queue, the roster badges and
any animated floor, so two approaches were measured before building either.

**Output activity — rejected.** Idle produced 0-2 pty chunks per 10s, but a
*working* agent went quiet for up to 4.9s mid-turn while the model thought. Any
"quiet means idle" threshold low enough to be useful reports false idles, and
thinking pauses grow with effort level.

**Scraping the TUI — rejected.** Neither `esc to interrupt` nor an empty prompt
line matched reliably across samples, and the on-screen working indicator is
Claude Code's own rendering, free to change in any release. Building status on
it means a silent break on some future update.

**Lifecycle hooks — adopted.** `UserPromptSubmit`/`PreToolUse` mean working,
`Stop`/`SessionEnd` mean idle. Structured, emitted by the CLI itself, and it
reuses the hook server already running for approvals. Verified end to end:
exactly `working -> idle` across a 30s turn, no events while merely thinking.

Those hooks are wired **fail-open** on purpose (`EVENT_SCRIPT` in
`approvals.ts`), the exact opposite of the approvals hook. If Bullpen is
unreachable, a missing status badge is the right outcome; blocking the agent
over a badge would not be.

## Known defects

**A. Agents survive a hard kill of the main process. — FIXED, with a caveat.**

`PtyManager.killAll()` runs on `before-quit` and `window-all-closed`, so a
graceful quit was already clean. `SIGKILL` or a crash skips every handler, and
agent `claude` processes were twice observed still running afterwards
(`ps -eo pid,cmd | grep .bullpen/agents`, and `ss -ltnp` showing an orphan still
holding an inherited socket). An orphan keeps shell access, keeps burning
tokens, and nothing in the UI knows it exists.

Fix in `src/main/reaper.ts`, wired into `src/main/index.ts`:
- a pidfile per agent on spawn, cleared on exit
- `reapOrphans()` at startup, before anything new spawns
- an identity check before every kill: the live command line must contain the
  agent's own settings path. A stale pidfile pointing at a recycled pid is
  classified `not-ours` and left alone.
- `SIGTERM`/`SIGINT`/`SIGHUP` handlers added, so every *catchable* exit is clean

Verified: 7 unit tests against real processes, including the pid-reuse case, and
an end-to-end run against the real app — orphan killed, unrelated process on a
recycled pid untouched, pidfiles cleared.

**Caveat — the natural orphan could not be reproduced on demand.** Two
deliberate attempts (1 agent, then 3 agents, SIGKILL of the app) had every agent
die with the app. The orphan is real but timing-dependent, probably tied to
whether `claude` has reached its stdin read loop when the pty master closes, and
likely entangled with defect B. So the reaper's kill path was proven with a
*manufactured* orphan, not a naturally occurring one. What is unproven is how
often the reaper will actually have work to do — not whether it works.

**C. Renderer messages crashed the main process after the window closed. — FIXED.**
`send()` guarded `win?.` only, which catches null but not a destroyed window.
Agents keep streaming pty output while they are being reaped, and anything sent
in that gap threw `TypeError: Object has been destroyed` into Electron's crash
dialog. Reported by the user with a stack trace. Fixed at the single funnel all
main -> renderer traffic passes through, plus dropping the reference on
`closed`. Verified by closing the window mid-stream with two live agents: exit
code 0, no crash lines, no orphans.

**B. Spawned agents inherit the main process's file descriptors. — FIXED.**

Measured directly from `/proc/<pid>/fd`, three agents spawned in order:

| agent | spawn order | `/dev/ptmx` held (before) | (after) |
|---|---|---|---|
| michael | 1st | 0 | 0 |
| dwight | 2nd | 1 | 0 |
| andy | 3rd | 2 | 0 |

Each agent inherited the pty **master** of every agent spawned before it, plus
Electron's own sockets, config handles and Chromium shared-memory segments —
68 to 73 descriptors past stdio, now 22 to 23. What remains is opened by the
CLI itself after `exec` (its own `/proc/self/statm`, `/dev/urandom`, node's
epoll, its API sockets); none of it comes from Electron.

Two consequences, both gone:

- the earlier agent never saw EOF when Bullpen died, so it could outlive the
  app still holding shell access — the non-deterministic half of defect A, and
  why the orphan could not be reproduced on demand
- holding another agent's pty master is a write channel into that agent's
  terminal, bypassing the hive mailbox and the approvals hook entirely

The listening sockets were **not** leaked. An earlier `ss -ltnp` reading that
suggested otherwise was misattributed; `listening on: none` for every agent.

**The fix.** node-pty's Unix path is `forkpty()` + `execvp()`, and `fork`
copies the parent's whole descriptor table. The child now closes everything
above stdio before `exec` — `close_range(2)` where the kernel has it, a bounded
`close()` walk otherwise, since a container can report an open-file limit in
the millions. Only async-signal-safe calls, because it runs between fork and
exec. Upstream's macOS path already does this via `POSIX_SPAWN_CLOEXEC_DEFAULT`,
so the patch is guarded exactly like the fork branch it serves.

Applied by `scripts/patch-node-pty.mjs` before `electron-rebuild`, which this
project already runs, so it is compiled in rather than reapplied at runtime.
Idempotent, and it exits non-zero if node-pty moves an anchor — a silent no-op
would look exactly like a fixed leak.

**Earlier attempt, reverted, kept because the failure is instructive.** Launch
each agent through `/bin/sh -c` that closes every descriptor above stdio and
then `exec`s the real command. It worked in isolation but every variant exited
127 inside the app, where the shell inherits ~70 descriptors instead of one:
closing that many also closes the ones `dash` keeps for its own redirection
bookkeeping, and it kills itself before reaching `exec`. A fourth bug found
along the way: an unmatched `/dev/fd/*` glob leaves the literal string, so
`exec *>&-` reads as "exec the file named `*`".

**What this costs.** A patched dependency has to be re-checked on every node-pty
upgrade. The script failing loudly is what makes that a build error rather than
a silent regression.

## Unverified — needs a real run

**4. Typing mail into an agent's stdin actually delivers it.**
`PtyManager.deliver()` types text and hits enter. If the agent is mid-turn the
text lands in the middle of its work. Upgrade path is already noted in the code:
agents poll their own `inbox/` instead of being typed at.

## Decisions taken without asking

**Claude Code only.** It is the sole CLI installed on this machine. Multi-provider
support is a config shape, not a rewrite — `AgentSpec.cmd` already takes any binary.

**Polling over `fs.watch`.** 500ms readdir per agent. Costs latency, saves the
dedup and rename handling `fs.watch` needs, and works on WSL2 `/mnt` where
`fs.watch` silently does not fire. Revisit past ~50 agents.

**No SQLite.** The hive is the store. Add one when cost tracking or history needs
queries that `ls` cannot answer.

**Agent setup is a 4-step wizard**, not a single field: identity, workspace,
engine, briefing. `window.prompt` does not exist in Electron — it throws — so
the directory comes from the native dialog or a typed path.

**Portraits are generated, not drawn.** `src/renderer/src/avatar.ts` derives a
12x12 bust from a hash of the chosen preset. Bundled character art is the one
part of an app like this that carries a licence, and the roster needs a face per
agent with no artist in the loop.

**The tab bar only carries tabs with data behind them** (terminal, approvals,
activity, commands). The reference UI has ten; nine empty ones read worse than
four full ones. `queue` in particular needs a busy/idle signal per agent, which
does not exist yet.

## The analyst chain — assumed, and where it can bite

Michael no longer assigns: he hands everything to Bea (`ba`), who analyses,
hires and runs the dev → test loop, and reports back to him. Verified live in a
throwaway `BULLPEN_HOME`: dispatch reached Michael, Michael mailed Bea, Bea
hired a dev, the dev reported, Bea put a tester on it, and the report came back
to the human through Michael. What that run did not settle:

- **Assumed:** an existing floor's `~/.bullpen/michael/CLAUDE.md` is the
  operator's file once written, so it is left alone. The new chain reaches an
  upgraded Michael only through `--append-system-prompt`, which says in words
  that it supersedes the file. If a hand-edited CLAUDE.md argues back hard
  enough, he could still try to hire. What breaks: work assigned twice, or
  assigned without anyone testing it. Fix if seen: delete that file and let it
  be rewritten.
- **Assumed:** Bea works in Michael's directory, so she can read the projects he
  can see. She is not sandboxed to any repo, and her writes outside it escalate
  to the human like anyone else's. What breaks if wrong: an analyst who cannot
  read the code she is analysing, and asks instead.
- **Ceiling:** a tester's pass closes every card in `wait_test` on the same
  project, not the one card it was testing. There is no link on a card back to
  the message it came from. Two features under test on one project at the same
  moment therefore close together. Upgrade path: carry a task id in the mail.
- **Known gap:** a card only leaves `wait_test` when a tester reports. If the
  tester is killed mid-loop, the card sits there until someone drags it.
- **Deliberate:** the router refuses mail that skips the chain (boss↔analyst,
  analyst↔dev, analyst↔tester, dev↔tester, and only the boss may write to the
  human). A refused message is kept in `dead/` and bounced back to the sender
  with the reason. Cost: a developer blocked on something only the human can
  decide now waits two hops - dev → analyst → boss → human. That is the trade
  the chain is for; if it hurts, the gate is one function in `index.ts`.
- **Deliberate:** the gate switches itself off when the analyst is not running.
  She is a process and can be killed, and rules that strand every task on a
  floor without her are worse than the shortcuts they prevent.
- **Assumed:** `role` in a hire message is `dev` unless it says `tester`.
  Anything else silently becomes a dev rather than a third kind of agent
  nobody briefed.

## Deferred, with a trigger

| Deferred | Add when |
|---|---|
| Office floor (Pixi) | Phase 1 proves the harness is worth using |
| Cost / token tracking | first surprise bill — parse `~/.claude/projects/*.jsonl` |
| Persist agents across restarts | restarting the app stops being rare |
| Circuit breaker (steer → constrain → stop) | an agent actually runs away |
| Semantic memory | agents visibly repeat work across sessions |

## Known, decided against fixing

- **Theme only reaches an agent at spawn.** Bullpen writes `theme` into each
  agent's settings file, and switching light/dark rewrites it for every agent
  already running - but the Claude Code CLI reads it once at startup, verified:
  an agent started 11:55 kept painting light after the file said `dark` at 13:36.
  A running agent therefore keeps the theme it was born with, so its prompt block
  can be a light band in a dark Bullpen. Restarting the CLI is the only thing
  that would change it, and losing a live session to recolour it is a bad trade -
  new agents match, that is enough. (Decided 2026-08-17.)

## Distribution — unresolved, costs money

- Packaging is wired up: `npm run build:mac` / `npm run build:win`, config in
  `electron-builder.yml`. Both cross-build from one macOS machine — `node-pty`
  1.1 is node-api and ships its own Windows prebuilds, so `npmRebuild: false`
  and no Windows toolchain is needed.
- **Assumed, not verified:** the Windows package was never launched on Windows.
  Only the macOS arm64 package was smoke-tested (`node-pty` spawns from inside
  the asar). If Windows is wrong, it fails at `loadNativeModule`.
- **Assumed:** the fd-leak patch (`scripts/patch-node-pty.mjs`) compiles only
  into `build/Release`, which is arm64. An Intel Mac falls back to the unpatched
  `prebuilds/darwin-x64`, so the descriptor leak returns there. Windows never
  needed the patch — it is guarded to the fork path.
- macOS notarization needs Apple Developer, $99/yr, or Gatekeeper blocks the app.
- Windows code signing cert, ~$100-400/yr, or SmartScreen warns on every install.
- No app icon yet; both builds use the default Electron icon.

None of this matters for personal use. All of it matters before selling.

## Art licensing

No art is bundled and none should be added carelessly. Munder Difflin's tileset
(LimeZu) is non-commercial. If Bullpen is ever sold, use CC0 assets (kenney.nl)
or buy a commercial license — and never let a restricted asset into git history,
since deleting it later does not remove it.

# Open questions — workflows

Assumptions made while making the floor's shape data instead of code.
breaks if the assumption is wrong.

## 1. Applying a workflow does not restart anybody — RESOLVED

A CLI is handed its brief once, as `--append-system-prompt` at spawn, so apply
alone leaves every running agent on the old shape.

**Fixed** by making the move something the operator asks for: the dialog's
footer names how many agents are still on the shape they started on and offers
`restart the standing ones`, which stops the dispatch agent and every other
fixed agent and brings them back on the running workflow. It confirms first -
the conversations do not survive it.

Hired agents are deliberately left alone: a developer's context is its work, and
this is not the place to decide that work is finished. They can be restarted one
at a time from the roster.

## 2. An agent whose role no longer exists becomes a builder

`workflow:set` drops role assignments naming roles the new workflow lacks, and
`roleOf` then falls back to the first role that builds.

**Breaks if wrong:** a tester hired under `analyst-chain` and left running
across a switch to `solo` is treated as a developer - its "pass" report moves a
card as if it were a "done".
**Fix if it bites:** refuse the switch while agents of a disappearing role are
still running, the way `stale` is already reported.

## 3. The dispatch agent's CLAUDE.md is written once and never revised

`writeBriefing` only writes when the file is absent, because after the first
launch it is the operator's file to edit.

**Breaks if wrong:** an existing floor that switches workflow keeps a CLAUDE.md
describing the old one. The appended system prompt is right, the file is not,
and the file is what a person reads.
**Fix if it bites:** detect that the file is still byte-identical to what
Bullpen generated and replace it in that case only.

## 4. Standing agents all share the dispatch agent's directory

`fixed:ensure` starts every standing agent in `currentGodCwd()`, because that is
where the analyst has always worked - she reads the projects the boss can see
rather than editing any of them.

**Breaks if wrong:** a workflow whose third standing agent is meant to work
somewhere else has no way to say so, and gets the boss's directory instead.
**Fix if it bites:** an optional `- cwd:` line per role, resolved against the
same workspace check the wizard uses.

## 5. `rtk` reports typechecks that did not happen

`npx tsc --noEmit -p <anything>` returns exit 1 while `rtk`'s filter prints
`TypeScript: No errors found`. It also printed that for `tsconfig.node.json` and
`tsconfig.web.json`, neither of which exists in this repo. Every typecheck in
this session was re-run as `rtk proxy npx tsc --noEmit -p tsconfig.json`, which
reports honestly.

**Breaks if wrong:** nothing here - but any earlier session that trusted the
filtered output was reading a green light that was not connected to anything.

## 6. The UI reads the workflow through module state, not a prop

`src/renderer/src/shape.ts` holds the running workflow in a module variable, set
once at startup and again when one is applied. Everything from a canvas frame to
a zustand action reads it without a prop threaded through.

**Breaks if wrong:** a second window, or a component rendered before the startup
effect resolves, sees an empty shape - no dispatch role, nothing core, no tags.
The startup effect awaits the workflow before it adopts anyone, so the window
that exists cannot hit it; a second one would.
**Fix if it bites:** a context provider around the tree, fed by the same call.

## 7. An agent left over from the previous workflow keeps its old role

Applying a workflow does not re-role anyone already running. `fixed:stop` now
takes down every id ever stood up this run, so "restart the standing ones"
clears them - but until that is pressed, a floor can show an agent whose role no
longer exists in the workflow.

**Breaks if wrong:** that agent has no tag, is not treated as core, and can be
fired - which is survivable, and is also how it gets cleaned up.
**Fix if it bites:** mark those rows as belonging to a shape that is gone.

## 8. Opening an old workflow rewrites it into the two-part shape

`parseMarkdown` reads both forms - `## roles` + `## briefs`, and the original
one-section `## role` - but `toMarkdown` only writes the new one. The editor
shows what `toMarkdown` returns, so opening an old file and saving it converts
it, and the `- does:` line it never had stays absent.

**Breaks if wrong:** somebody editing a workflow by hand outside Bullpen sees
their layout replaced the first time they save from the dialog. Nothing is lost
- every field survives the round trip, and there is a test for it.
**Fix if it bites:** remember which form a file was read in and write it back
the same way.

## 9. A replaced format document is not checked against the parser

`~/.bullpen/workflow-format.md` overrides the shipped reference in the help
panel and in the brief the workflow writer is given. Nothing lints it: the test
that every parser field is documented runs against the file in the repo.

**Breaks if wrong:** somebody writes their own reference, leaves out `- does:`
or invents a capability, and the generator writes workflows that do not lint -
one wasted model turn per attempt, with a rejection that reads as the model's
fault.
**Fix if it bites:** run the same documented-vocabulary check over the override
when it is read, and say so in the help panel rather than in a test.

## 10. Column kinds are five, and a card is in exactly one

Columns are now the workflow's - own keys, own names, own colours - but each one
may declare only one of five kinds (`start`, `working`, `waiting`, `stuck`,
`done`), and those are what the floor reaches for when nobody sent a message.

**Breaks if wrong:** a process with two kinds of waiting - waiting on legal and
waiting on a client, say - can name both columns but only one can be the column
work parks in to be checked. The other only moves by a card rule.
**Fix if it bites:** the automatic moves (turn started, agent exited, card
opened) become card rules with a sender of `bullpen`, and the kinds go away.

## 11. A workflow can take a tool away, never grant one

`- never: Bash` is refused by the approvals layer. There is deliberately no
`- may:` - nothing in a workflow can turn off the dangerous-shell checks, the
credential-path checks, or the sandbox boundary.

**Breaks if wrong:** somebody wanting a role that may write outside its sandbox
has no way to say so, and will look for one.
**Fix if it bites:** it stays this way. A file that can widen an agent's reach
is a file worth attacking, and the whole point of the approvals layer is that
the agent cannot edit its own leash.

## 12. Renaming the human does not rewrite the briefs

`- human address: boss` changes what the router answers to and what lint asks
for, but a brief that still says `"to": "you"` keeps saying it - lint catches
the floor's voice, not every other role's prose.

**Breaks if wrong:** an agent writes to `you` on a floor where the human is
`boss`, and the message lands in dead letters with a refusal it can act on.
**Fix if it bites:** lint every brief for the old address, or rewrite them on
rename - which would edit the operator's own words, so it is refused for now.

## 13. Two ways to reach one switch

The theme and the notification toggle used to be in the title bar and in
settings; the icons are gone now, and settings is the only way. Two are left:
the workspace is on the agent's own header as well, and the webhook is in the
triggers tab as well. Both routes write the same state.

**Breaks if wrong:** nothing functionally - but a switch in two places is two
places to keep in step if either grows an option the other does not show.
**Fix if it bites:** the header link and the triggers form become shortcuts that
open settings at that section, rather than editing in place.

## 14. The board form writes the whole workflow

`workflow:patch` merges into the running workflow, lints it whole, and saves the
markdown - so saving a colour rewrites the file, including any hand-formatting
in it. Comments survive (they are stripped at parse), spacing does not.

**Breaks if wrong:** somebody who laid their workflow out by hand finds it
reformatted after changing a column colour in the form.
**Fix if it bites:** patch the markdown text rather than the parsed workflow -
find the `## board` block and replace only those lines.

## 15. The chart does not save where the boxes are

Dragging a box moves it for as long as the dialog is open, and the next open
lays the floor out again from capability kinds. Nothing reads a position - the
router reads roles - so storing coordinates would mean a document describing an
organisation carrying one screen's idea of where the boxes sit.

**Breaks if wrong:** somebody arranges a large floor exactly how they think of
it, closes the dialog, and it springs back.
**Fix if it bites:** positions go in `config.json` under the workflow's name -
this machine's opinion about this floor - and never into the workflow itself.

## 16. What a role is for is inferred, not declared

Capabilities no longer carry a kind. Who talks to the human comes from `talks
to`; who hands work out is whoever a card rule says opens a card; who closes one
is whoever a rule says closes it; whoever is left builds. Two header lines -
`reports to you:` and `hires:` - settle the cases where more than one fits.

**Breaks if wrong:** a floor whose card rules do not yet open anything has no
assigner, so hiring and the report chain have nobody to route through until the
first rule is written.
**Fix if it bites:** lint already refuses a floor with no rule that opens a card,
so the window is only while somebody is mid-edit in the form.

## 17. The rules decide shape and which checks run - not behaviour

`src/rules.md` declares the entities, their fields and types, and the laws. The
linter asks it before every check: a law taken out of the file is a check that
stops running, and a test asserts the other direction - every law written down
is one the linter asks about.

What it does not decide is behaviour. `opens` means a card is opened because
`routeCard` says so; the rules choose whether a floor may write `opens`, and
what a failure is called, and never what opening means.

**Breaks if wrong:** somebody removes a law expecting the app to stop doing the
thing, rather than to stop checking it.
**Fix if it bites:** the laws list gets a column saying what each one guards, so
"stops checking" is on the page rather than in this file.

## 18. One document, and it is the rules

`workflow-format.md` is gone. There was a schema for the code and a description
for people, kept in step by a test - which is what having two always costs.
`rules.md` is both: the linter asks it which checks to run, the settings dialog
draws it as a form, and the model that writes floors is briefed with it.

**Breaks if wrong:** the rules are now a schema first and prose second, so they
read less like an explanation than the document they replaced. The generator
gets the shape of the file from a paragraph in `generatorBrief` rather than from
the rules themselves.
**Fix if it bites:** the file layout becomes an entity too - `## entity:
document` - and the paragraph goes.

## 19. Nothing is given to a floor it did not ask for

Capabilities, columns and card rules used to be filled in behind the operator's
back when a file left them out - four, five and eight of them. They are not any
more: a floor has exactly what its file declares, and an empty one is empty.

The laws are the same story. `rules.md` ships with none switched on, so nothing
is refused for being half-finished. The ids are listed there for anybody who
wants one back, and the settings dialog can tick them on.

**Breaks if wrong:** a floor with no column has nowhere for a card to go and no
card moves; a floor with no rule that opens one never puts work on the board.
Both are legal now, and neither says anything at the time - the only sign is a
board that stays empty.
**Fix if it bites:** the checks still exist and are one line each in `rules.md`.

## 20. A floor ships with no card rules at all

Every line drawn on a shipped floor used to arrive with a rule already on it -
what it does to the board, and when. Opening one showed a sentence nobody in
the room had written. They are gone: `analyst-chain` and the five other presets
ship with `cardRules: []`, and the starter template shows the syntax in a
comment instead of writing three rules for you.

**Breaks if wrong:** a fresh floor moves no cards. Work is dispatched, agents
talk, and the board stays empty until somebody clicks a line and writes
`opens a card` on it. Nothing says so at the time - the two lint lines that
would ("Nobody assigns", "No card rule opens a card") are behind laws that ship
switched off, per §19.
**Fix if it bites:** the eight rules that used to be built in are in
`test/floors.ts` as a fixture, and can be pasted into a floor's `## card rules`.

## 21. Both directions of a line share one handle — by design now

`ba → dev` and `dev → ba` are one line with one dot, and the panel it opens has
a box per direction. They were briefly two dots 16px apart, which was two
near-identical panels for one relationship.

## 22. The reading pane follows the drawing until it is typed in

`read it` opens the file beside the chart and re-renders it on every change, so
the markdown is a live view of what has been drawn. The moment somebody types in
that box it stops following: their text is theirs, and further edits to the
chart no longer appear there.

**Breaks if wrong:** somebody types one character in the pane, keeps drawing,
and saves the file - the drawing's later changes are not in it. **Fix if it
bites:** say so in the pane once it has been typed in, or drop the text on the
next chart change.

## 23. Dispatch puts a card on the board only if a rule says so

`you → boss: opens a card` is now a real rule: the operator's hand-over runs
through `routeCard` like any message, with their address matched on the rule's
`from`. The card the dispatch handler used to open unconditionally is gone.

**Breaks if wrong:** on a floor with no rule about the human - which is every
shipped floor, per §20 - dispatching leaves nothing on the board. The work still
happens; the board just does not mention it.
**Fix if it bites:** one line on the `you → …` arrow.

## 24. The chart pans and zooms, and nothing is clamped

The wheel zooms about the pointer (0.3×–2.5×) and the middle button drags. The
canvas has no edges, so a box can be dragged or panned out of sight; `fit` puts
everything back on screen. Boxes cannot go above or left of the origin.

Boxes drag anywhere, including left of and above the origin - the clamp that
used to stop them is gone, and the whole picture is shifted by its own leftmost
and topmost box so nothing falls outside the SVG's box and gets clipped away.
The view is shifted back by the same amount as it happens, so moving one box
does not move the others on screen. `fit` measures the whole occupied box, negatives
included, so everything comes back on screen whatever was done to it.

**Breaks if wrong:** somebody pans far away, sees an empty canvas, and thinks
the floor is gone. **Fix if it bites:** `fit`, which is in the toolbar.

## 25. The file and the drawing write to each other

The pane follows the drawing whenever it is not focused, and the drawing follows
the pane whenever it is - parsed 400ms after the last keystroke, and left alone
if it does not parse.

Text that does not parse is kept rather than overwritten on blur, and the reason
it did not parse is shown under the box - a half-typed file is what somebody
typing a file has.

**Breaks if wrong:** while the text does not parse the pane stops following the
drawing, so boxes moved in the meantime are not in it. It catches up as soon as
the text reads again.

## 26. Whatever is open is what `delete` deletes

Clicking a box or a line opens it and selects it; `delete` (or `backspace`)
takes that one off the floor, and `escape` closes the panel. The two buttons
that used to do it are gone, and so are `fit` (double-click the background) and
`undo`/`save` while there is nothing to undo or save.

On a line, `delete` takes both directions off - the dot is the line between two
of them, and one of them is not half a line.

**Breaks if wrong:** a key with no confirmation removes a role and everything
written in its brief. `undo` restores it - and now restores its box too, which
it did not before - but only until the floor is saved.

**Fix if it bites:** ask before deleting a role that has a brief in it.

## 27. Saving a floor no longer enforces the laws

`saveWorkflow` linted with every law switched on, which was harmless while the
laws were built in. Since no floor ships with card rules (§20), every one of
them failed `must-open` and could not be written to disk at all - switching to a
shipped floor threw where it should have worked. It now refuses only markdown it
cannot parse; what a floor must have is the caller's business, and the caller
asks the rulebook.

**Breaks if wrong:** a floor with nothing on it can be saved and switched to.
That is the intent, and the card at `floors` says `0 rules` on it.

## 28. Agents follow the floor, both ways

Applying a floor now stands down every running agent the new one has no role
for - `hasPlaceFor` decides, and `solo` over `analyst-chain` retires the analyst
- and the renderer brings up whoever the new floor names and nobody is doing
yet. "Still on the shape they started on" is measured against the floor each
agent was briefed on rather than "is running at all", so it names only the ones
a restart would actually change.

**Breaks if wrong:** a retired agent is killed mid-task, and whatever it was
doing is lost - there is no confirmation and no record beyond the activity line.
A hired agent survives as long as its role name does, which means a floor that
renames `dev` to `builder` retires every developer on it.
**Fix if it bites:** ask before retiring an agent that has an open card.

## 29. Handing work to a role, not to a person

A message addressed to a role name - `{"to": "dev"}` - is resolved by the app
rather than dying: whoever holds that role and is idle under `hireAbovePct`
takes it, emptiest window first; nobody free means hire one; and the card is
opened under whoever got it, rule or no rule. Whether the sender is allowed to
write to that role is checked *before* anybody is hired.

Reports move the card even on a floor with no rules: a subject starting `done:`
closes it, `fail:`/`blocked:`/`stuck:` parks it. Any rule the operator writes
runs first and this never sees it. A card in `stuck` or the waiting column is no
longer dragged back to `doing` by the agent's next turn - which was usually the
turn that wrote the message saying it was stuck.

**Breaks if wrong:** a floor that names a role nobody can be hired into (no
`hireable`) silently drops the message, as before. And the auto-hire puts the
new agent in the sender's project directory - if the sender has no project, that
is the floor's own name, and the directory may not be where the work is.
**Fix if it bites:** hire by hand, which still works and takes a `cwd`.

## 30. One agent stands at launch: the one you type at

Every shipped floor now names an agent for `dispatch` only - Iris, Quinn, Ed and
Rey are gone as standing agents and their roles are `hireable`. Opening the app
starts Michael and nobody else. Work handed to one of those roles hires somebody
into it (§29), so nothing is lost by not having them up.

The chart agrees: saving a drawing marks only `dispatch` as fixed. `entry` used
to be marked too, which is what kept putting the analyst back.

A brief that names a role with nobody in it now renders the role's own name -
`{{role.ba.id}}` is `"ba"`, an address the app resolves - instead of leaving the
braces in front of a model.

**Breaks if wrong:** the first hand-off on a cold floor costs a spawn, so the
first task is slower than it was. And a floor whose `entry` is hireable takes
inbound work through dispatch until somebody is hired into it.

## 31. `describe one` was writing floors with nothing in them

Three separate reasons, all fixed:

- The generated file was checked with the operator's rulebook, which ships with
  every law switched off - so a floor whose roles wrote to nobody and whose
  board never moved passed, and the repair round never ran. It is checked
  against every law now: a person may leave a floor half-drawn, a model asked
  for a whole floor may not.
- The prompt described the schema and never showed a file. It now carries the
  starter file whole, plus a list of what a floor must have; without it the
  model copied field names out of the schema and wrote a capability called
  `name` and two columns called `key`.
- The parser refused punctuation rather than content: `- dispatch: boss` in the
  header (every model writes it there), and `·` or `:` where the examples used
  `—` between a name and what it is for. Both are accepted. Card rules still
  take `:` only, because `·` already separates what happens from when.

Measured after: `problems: []`, `boss → dev, you, hire`, `dev → boss`, three
capabilities, four columns, four rules - drawn with its lines on the chart.

**Breaks if wrong:** a model that writes something none of this anticipates
still lands a floor with pieces missing; the problems are shown and the floor is
applied anyway, which is deliberate - a drawing with something missing is
faster to fix than a blank canvas.

## 32. A line is who may write to whom, in both directions

One curve per pair, one dot on it, and an arrowhead at each end that a direction
actually exists in: `boss ⇄ analyst` has two heads, `you → boss` has one. Drawn
with a single head, a two-way line read as a one-way street - which is the
opposite of what a line on this chart means.

**Breaks if wrong:** nothing on the drawing distinguishes "these two write to
each other" from "these two write to each other about different things" - that
is what the panel's two boxes are for.

## 33. A box is a role; the dots on it are the sessions in that role

Each running Claude in a role puts a dot on that role's tile - green idle, amber
working, red blocked - and the tile's tooltip names them with their context
percentage. An empty tile says nobody is there yet and that somebody is hired
when there is work for the role. Up to four dots are drawn; a fifth session is
in the tooltip only.

**Breaks if wrong:** the dots come from the renderer's roster, which is a
snapshot published after the fact - a session that has just been hired shows a
beat later than it exists. And the chart in Settings only re-reads it while it
is open.

## 34. Two sessions talking is two people talking, on the floor

A node on the chart is a role and the dots on it are the live sessions in it
(§33); on the office floor those sessions are the people, and a message between
them is one of them walking over. Three things were stopping that from being
visible:

- Mail to somebody with no chair yet was dropped. Work is handed to a role now
  and somebody is hired on the spot, so the first message to a new agent always
  arrived a beat before the roster knew about them - it is held for 8 seconds
  and started as soon as they sit down.
- Neighbours never talked. There is no path to where you are already standing,
  so two agents a tile apart exchanged a flying envelope and nothing else. Being
  within two tiles now counts as having arrived.
- The bubbles were under the name labels. The labels are hidden for the pair
  while they talk, the bubbles sit higher, the conversation lasts 4.2s instead
  of 2.6s, and the message's subject is drawn between them.

**Breaks if wrong:** the subject is drawn verbatim, clipped at 40 characters -
a message whose subject is a paragraph is a smear across the floor.

## 35. Removing a floor: deleted if it is yours, hidden if it ships

`remove` used to appear only on saved floors, so the six that ship with Bullpen
could not be taken off the list at all. It is on every floor now except the one
running. A saved floor's file is deleted; a shipped one has no file, so its name
goes in `ui.hidden` and the list stops offering it. The floor being run is never
hidden, whatever the list says - a list that cannot show what is running is one
somebody has to guess their way back from.

`show the ones I removed` at the foot of the panel empties that list.

**Breaks if wrong:** hiding is per-machine and not per-floor-file, so a floor
saved under a preset's name is hidden by the preset's entry too.

## 36. Switching floors reloads the window

Applying a floor changes what every screen is about - the board's columns, who
is on the roster, what the router allows - and the renderer kept whatever it had
read when it opened. Every path that swaps the floor (running one from `floors`,
`describe one`, `a new one`, `save the file`) now reloads the window 200ms after
main confirms.

Main owns the agents and the terminals, so nothing running is lost; what is lost
is which tab was open and anything typed and not saved elsewhere. Saving the
chart with `save the floor` does *not* reload - that is editing the floor you
are already on, and reloading mid-drawing would be worse than the staleness.

**Breaks if wrong:** an agent still briefed on the old floor is not restarted by
this - the reload is the window, not the floor. `stale` names them and
`restart the standing ones` is still the way.

## 37. Dead-code sweep: what came out, and the two things left standing

A pass over the whole tree for code nothing reaches. Removed: `src/brief.ts`
and its test (the structured role-brief builder, superseded by the plain brief
textarea in `OrgChart`), sixteen preload API functions with no renderer caller
and the main IPC handlers behind them, the per-agent `edits` map that only that
dead handler read, `board.toggleTask` (superseded by `setTaskStatus`) and
`board.assignTask`, `git.discardHunk` (the panel discards per block, not per
hunk), and a handful of unused locals the type checker names under
`--noUnusedLocals`.

One finding was left in place rather than deleted:

- `split.ts` and `layout.ts` carry two copies of the same grid algebra
  (`compact`, `moveTo`, `moveToNewColumn`, `resizeColumns`, `resizeRows`,
  `clamp`, `MIN_SHARE`) over different types. `layout.ts` could be built on
  `split.ts`, but the tests import both directly under `node --test`, which
  needs explicit `.ts` extensions the renderer does not otherwise use.

**Breaks if wrong:** the preload functions were judged dead by searching the
renderer for `bullpen.<name>`; a call built from a computed key would not have
been found. None exists today.

## 38. Four bugs the sweep turned up, and what each one cost

- **Fired agents leaked their terminal.** `disposeTerminal` was written and
  never called, and nothing else deleted from the `terms` map, so every agent
  ever fired kept its xterm instance and ten thousand lines of scrollback for
  the life of the window. Wired into the two places an id stops existing:
  `fire` on the roster, and closing a shell.

- **`MultiEdit` walked out of the sandbox unasked.** The write check listed its
  tools by hand - `Write`, `Edit`, `NotebookEdit` - beside a `WRITING_TOOLS` set
  that had four in it. A `MultiEdit` to any path outside the workspace was
  classified `allow` with nobody asked. It reads the set now, which is the only
  copy.

- **Halting a blocked agent left its request in the queue.** `agent:kill` threw
  away queued steers and nothing else, so a pending approval outlived the
  process it was about: the queue went on offering allow/deny, and the roster
  kept the agent marked blocked, for a pty that had already gone. Kill now
  denies what the agent was waiting on, which is what the renderer listens for.

- **The SIGKILL pass did not re-check the marker.** `reapOrphans` refuses to
  kill a pid whose command line does not carry the marker written at spawn, and
  then `forceKill` ran two seconds later on the pid alone. A process that exited
  in that window and had its number reused would have been killed by the half of
  the guard that was not looking. `forceKill` now runs the same check.

**Breaks if wrong:** the terminal disposal assumes no path re-mounts a
`TerminalHost` for an id after it leaves the roster. `TerminalDeck` is driven by
`agents.map(a => a.id)` and by one shell id, so nothing does today; a future
list that keeps fired agents visible would need the dispose moved.

## 39. Second sweep: six more, and where the sweep stopped

- **A hire could only ever be hired once on a long-named project.** `hireName`
  built `<project>-2` and slugged it afterwards, and `slug` caps at 32
  characters - so on a project whose slug was already 31 long the `-2` was cut
  off and every number from 2 to 99 produced the same id as the first. Past the
  roster of given names, the second hire onto such a project collided with the
  first and the spawn threw. The numbered names are slugs to begin with now, so
  the id the availability check was asked about is the id the agent is spawned
  under.

- **Two different slug functions decided agent ids.** The wizard used
  `names.slug`; main's hire path used a near-identical local one that folded no
  diacritics and had no length cap. Same name, two ids, depending on which way
  somebody joined the floor. Main's copy is gone.

- **An agent that died mid-turn stayed "working" forever.** The set is emptied
  by the Stop hook, which a killed or crashed pty never sends. `reportWhenQuiet`
  waits for that set to empty, so halting one busy agent silently ended every
  progress report for the rest of the session, and floor.json went on calling
  the dead agent busy. Cleared on exit, and the floor is re-checked there.

- **Applying a workflow did not re-state what a role never does.** Tool refusals
  are read once, at spawn. A floor that took `Bash` away from testers did not
  take it away from the tester already running - and one that handed it back
  left them still refused. Re-applied to everyone still running when a workflow
  is set.

- **An agent made in the wizard was briefed as the wrong role.** The renderer
  spawned first and called `setRole` afterwards, but the brief and the tool
  refusals are both read at spawn - so the agent was briefed as the floor's
  default role whatever the wizard's dropdown said, and `setRole` only ever
  fixed where its cards went. The role goes out with the spawn now, and
  `setRole` re-states the refusals for any caller that still arrives late.

- **Adding a role in the chart could overwrite one.** The new id was
  `role_<count+1>`, so adding two, deleting the earlier one and adding a third
  landed back on an id still in use - and the spread that writes it took that
  role's brief and its arrows with it, silently. `freeRoleId` in `chart.ts`
  takes the first number nobody has.

Also collapsed: `Approvals.onLifecycle` parsed the same hook body five times,
once per question it asked of it. That is the shape the `MultiEdit` gap in §38
came in - the same thing said in more than one place, and one copy left behind.

**Where this stopped.** `src/main/index.ts` has no test harness: it imports
`electron` at module scope, so nothing under `node --test` can load it. The four
findings in it were read out of the source and fixed there; the two in
`names.ts` and `chart.ts` have tests that fail without the fix. Not swept:
`Code.tsx`, `Settings.tsx`, `Floor.tsx` and the tab components, which are React
with no harness either.

## 40. Third sweep: the renderer and the inbound door

- **A malformed webhook URL took the whole app down.** `read` decodes the path
  to find who a task is addressed to, and `POST /task/%` makes
  `decodeURIComponent` throw. Thrown out of an http request handler that is an
  uncaught exception in the main process, so one bad URL from an authenticated
  sender ended the run. It answers 400 now, and the body-size cap grew a flag so
  a chunk queued behind `req.destroy()` cannot answer a second time either -
  `writeHead` throws once the headers are out, the same crash by another road.

- **Firing a running agent left a ghost row on the roster.** `kill` returns when
  the signal is sent; the exit event, and any status, tool, context or cost
  reading still in flight, arrive after that - by which time `removeAgent` has
  run. Every one of those handlers went through `upsertAgent`, which treats a
  partial for an unknown id as a new agent, so the row came straight back:
  nameless, no workspace, whatever the default role is. The seven handlers that
  are updates by nature now use `patchAgent`, which touches nobody it does not
  already have. Creating still goes through `upsertAgent`, where it belongs.

- **Switching agents mid-read could write one agent's rules into another's
  workspace.** The memory tab clears the draft when the agent changes, but not
  the document it was read from - and `memory()` is a round trip with `split`
  one click away the whole time it is in flight. Opening the editor in that
  window seeded the draft from the agent you had just left. The document is
  cleared with the draft now, and the mode switch is inert while a read is out.

**Not fixed, deliberately.** `code.ts` compiles the operator's own regex and
runs it against every file; its time budget is checked per file, so a
catastrophically backtracking pattern (`(a+)+$`) freezes the main process inside
a single `exec` and the window has to be killed. Node has no regex timeout and
the fix is a worker thread, which is more machinery than a box you typed into
yourself is worth. Worth revisiting only if search ever runs on somebody else's
input.

**How far the app was actually run.** Booted twice against a scratch
`BULLPEN_HOME`, which leaves it on the first-run setup screen and spawns no
agents - main comes up clean, and the only console output is WSL2's own GPU and
network-service complaints. The renderer's console is not readable from a
headless run, so the renderer findings above were read out of the source, not
watched happening.

## 41. Fourth sweep: two more, and one thing proved right

- **A shell could be handed to the wrong agent.** Shell ids are `shell:<agent>`
  and `shell:<agent>#2` upwards, matched with a plain `startsWith` on the base -
  so `morgan` asking for its shell was handed `morgan-2`'s: a live prompt in
  somebody else's workspace, labelled with morgan's name and morgan's directory.
  That is the one thing a per-agent shell panel exists to make impossible. The
  test is `isShellOf` in `names.ts` now, which is also where `SHELL_PREFIX` and
  `isShellId` moved - main and the renderer had a copy each, with a comment
  saying so.

  Firing an agent also left its shells running. The row goes off the roster and
  the panel is keyed on a selected agent, so they became processes nobody could
  reach and nothing would stop before quit - each with a shell in that
  workspace. `shell:closeFor` takes them down with the agent. Halting one still
  leaves them alone on purpose: the process stopped, the directory did not.

- **Changing the font size put every removed floor back on the list.** The prefs
  handler rebuilt `ui` from the four fields it knew about, and `ui.hidden` - how
  a shipped floor is removed, since it has no file to delete - was not one of
  them. Dragging one box on the chart did it too. The merge is `mergeUi` in
  `config.ts` now, spreading what it was given before naming anything, so the
  next field added does not repeat this.

**Proved right rather than fixed.** `blockPatch` and `discardBlock` - the only
destructive path the panel offers - were fuzzed against real git: 1250 random
edit/discard rounds across five seeds, each checked against an oracle that
computes the expected file independently of the patch builder. No mismatches, no
spurious refusals. That is the code this sweep most expected to find something
in.

**Still not swept.** `workflow.ts` (1392 lines, but the best-tested file here),
`presets.ts`, `Settings.tsx`, `OrgChart.tsx` beyond its draft and persistence
paths, and the office-floor renderer. Also unfixed and known: `testerReported`
closes every waiting card on the project, so two features under test at once are
both closed by one pass - the cards carry no link back to what was tested, and
adding one is a change to the board's shape rather than a fix.

## 42. Fifth sweep: the rest of the tree

Everything not yet read, read. Five more:

- **A `+` bullet was silently dropped.** Every regex in the workflow parser took
  `[-*]`; markdown's third bullet was not one of them, and `src/markdown.ts` -
  which does accept it - is what makes that an oversight rather than a rule. A
  line written `+ hireable` was not a bullet, so it vanished: the role stayed,
  nobody could be hired into it, and lint had nothing to say because what it
  describes was gone rather than wrong. Fuzzing the shipped floors found 128
  such lines - `+ builds → checks: ...` leaves a card rule that never moves a
  card, `+ todo: ...` leaves the board a column short. Fixed in `workflow.ts`,
  `rules.ts` and `chart.ts` together.

- **A file that did not exist yet could not be written.** `code.ts`'s `write`
  stat'd the path before writing, and stat throws on a path that is not there.
  The memory panel offers to give an agent a `CLAUDE.md` when it has none, which
  is exactly that case: the button answered ENOENT. Both guards it actually
  needs - not a directory, not outside the workspace - still stand.

- **A link in an agent's document could carry any scheme past the check.** The
  rendered anchor calls `ui:open`, which allows only http(s) - but it is a real
  `<a href>`, and a middle-click never fires its onClick. Chromium treats that
  as "open in a new window", which arrived at `setWindowOpenHandler` and was
  handed to `shell.openExternal` unchecked. An agent writing
  `[read this](file:///…)` into its own memory file had a link that, middle-
  clicked, told the desktop to open it. One `openable()` now guards both exits,
  and `will-navigate` is blocked outright - the window is a local page with the
  preload attached, and no link should ever replace it.

- **The rules pane lost edits between its tabs.** The form and the `as text` tab
  were independent drafts of one file: editing the form, switching to text and
  saving wrote the untouched original back. Switching now carries whichever side
  was changed.

- **Two agents could be drawn in one chair.** `assignDesks` wraps with `i %
  desks.length`, so an office smaller than the roster seats people on top of
  each other. Left as it is - the alternative is deciding what a full office
  should look like, which is a design question, not a fix. Flagged rather than
  guessed at.

**The one that changes how to read every other finding.** The shipped
`src/rules.md` declares no laws, and `lint` treats a rulebook with none as
"nothing to check" - so with the stock configuration `workflow:set` refuses
nothing and the chart's lint panel is always empty. That is deliberate and
rules.md says so in prose ("There are none: a floor is whatever you drew"), but
it means every parser-tolerance finding above lands unguarded rather than being
caught on the way in, and the code comment at `workflow:set` about refusing bad
floors describes a check that does not currently run. Related: every shipped
preset fails `must-open` and the assigns law with all laws switched on, because
floors now ship with no card rules - so turning those two on in Settings makes
all six presets unsaveable. Worth a decision, not a patch.

**Proved right rather than fixed.** No `dangerouslySetInnerHTML` anywhere in the
renderer - `parseMarkdown` produces data and `Markdown.tsx` draws it, so an
agent's memory file has no HTML path. `contextIsolation: true`,
`nodeIntegration: false`. The office layout was fuzzed 800 times across every
panel shape: no path crosses a wall, no seat lands outside the grid, no path
jumps a cell. `rules.md` round-trips through `readRules`/`writeRules`
unchanged and reads the same with all three bullets. Every shipped preset
round-trips through markdown. `src/markdown.ts` survives unclosed fences, CRLF,
tabs, seven hashes and a 200k-character line.

**Read, nothing found:** `cards.ts`, `dryrun.ts`, `god.ts`, `config.ts`,
`activity.ts`, `presets.ts`, `pty.ts`, `trust.ts`, `hive.ts`, `catalog.ts`,
`roster.ts`, `fleet.ts`, `keys.ts`, `theme.ts`, `main.tsx`, `Avatar.tsx`,
`Markdown.tsx`, `Commands.tsx`, `AddAgent.tsx`, `Graph.tsx`, `Workers.tsx`,
`Activity.tsx`, `sprite.ts`, `tiles.ts`, and the four build scripts.

## 43. Sixth sweep, and an honest map of what has actually been read

§42 claimed the tree had been read. It had not: `tiles.ts`, `catalog.ts`,
`Activity.tsx`, `Commands.tsx` and `fleet.ts` had been grepped, not read, and
`Floor.tsx` and the two build scripts had not been opened. Reading them found
one more, and it is not a small one:

- **The office floor stopped animating after 200 messages.** `Floor.tsx` walked
  an agent across the room for each new message and tracked how many it had seen
  as an index into `store.mail`. That list is a sliding window of the last 200 -
  so once it filled, its length stopped growing, the index sat on the end, and
  every message from the two-hundred-and-first on was skipped. No walking, no
  envelopes, no conversation bubbles, for the rest of the session. Each mail
  event carries a `seq` now, which only goes up, and the floor reads that.

Also: `npm run verify:hook` printed `FAILED` verdicts and still exited 0, so
nothing that checks a status could tell a working approvals layer from a
decorative one. It sets a non-zero exit now, the way `after-pack.mjs` throws.

**Two checks in `lint` ignore the rulebook.** `on(id)` gates almost everything,
but "the floor's voice may not write to the human" and "a column with no key"
run whatever the rules file says. Harmless - both are stricter, not looser - but
the design is "the rules file decides which of these run", and two of them do not
answer to it. Not changed: gating them would make an already-empty lint emptier.

**What has genuinely been read, and what has not.** Read end to end: everything
in `src/main` except `index.ts` and `workflow.ts`, everything in `src/` root,
`preload/index.ts` by its API surface, and in the renderer `store.ts`,
`chart.ts`, `shape.ts`, `split.ts`, `layout.ts`, `roster.ts`, `fleet.ts`,
`file.ts`, `prefs.ts`, `keys.ts`, `theme.ts`, `catalog.ts`, `Terminal.tsx`,
`Shell.tsx`, `Commands.tsx`, `Markdown.tsx`, `Avatar.tsx`, `main.tsx`, the four
`floor/` files, and every tab except the tail of `Monitor.tsx` and
`Triggers.tsx`. Plus all four build scripts.

Read in part, and this is where anything left is likely to be: `main/index.ts`
(~2400 lines, most of it), `main/workflow.ts` (~1400, the parser and lint but
not all of `toMarkdown` or `renderBrief`), `App.tsx` (~2000), `OrgChart.tsx`
(~1650, its draft/persist/save paths and the panels, not the drag and paint
code), `Code.tsx` (~1450, the git and discard paths, not the editor), and
`Settings.tsx` (~1000, the rules and webhook panes). Roughly 4,000 of the
tree's 16,500 lines have not been read line by line, almost all of it rendering
and layout in the six largest files.

## 44. The last four thousand lines

The six biggest files, read the rest of the way through. Five more, and one
correction to §42.

- **A column whose name had a `#` in it disappeared.** The board parser matched
  a label as "anything that is not a `#` or a bracket", so `- todo: C# work
  #7fc7e8 (start)` matched nothing - and a line that matches nothing is skipped,
  not refused. The board came back a column short, and the one it lost was
  whichever had just been renamed. The colour and the kind are taken off the end
  now and the label is whatever is left.

- **Deleting a floor you wrote asked nothing.** One click on `remove`, next to a
  card you click to switch floors, and `rmSync` took the file. A shipped floor
  is only hidden and `show the ones I removed` brings it back; one you wrote had
  no way back at all. It confirms now - and only for those, because hiding a
  preset is reversible and a confirm on it is noise.

- **Re-opening a file an agent had rewritten showed the old copy.** The editor
  is keyed on the path, so a second open of the same file changed nothing it
  would rebuild for: the panel went on showing what was read the first time, and
  Ctrl-S wrote that back over the agent's work. A buffer nobody has typed in
  now takes the newer text; one with unsaved edits in it is never touched.

- **Search kept the previous query's lines.** Expanding a file whose rows fell
  past the cap fetches them and caches by path - not by what was being searched
  for - so changing the query and expanding the same file again showed the old
  hits under the new search. The cache is dropped when the query changes.

- **A cleared threshold box emptied the floor.** Both context thresholds come
  from number inputs, and `Number('')` is `NaN`. Stored, every `ctxPct <
  hireAbovePct` was false, so nobody was ever free and every hand-off hired
  somebody new - and the brief handed a real agent "reuse one whose ctxPct is
  under NaN". `pctOr` guards them at `workflow:patch`, which is the one funnel
  both inputs go through. Every other numeric input already had this: the
  webhook port and the context rule both check before they store.

- **Closing settings threw the drawing away.** The dialog closes on a backdrop
  click, and the chart's draft lives inside it - so a click a few pixels outside
  was the cheapest way to lose a floor. It asks now, on the backdrop and on the
  ×, and only when there is something unsaved.

**Correction to §42.** The empty rulebook is not an oversight the code is
unaware of: `workflow:generate` calls `lint` with every law on and says why -
"a person drawing a floor is allowed to leave it half-finished; a model asked
for a whole floor is not". So the design is deliberate on both sides, and what
is left is only that `workflow:set`'s comment about refusing bad floors
describes something that, with the stock rules, never happens.

**Noticed, not changed.** A role label containing ` · ` is truncated at it -
that is the separator in `### role · label`, and the label is a display string.
`attrs` whose key is one of the role's own field names (`does`, `cli`, `never`)
is swallowed on the way back out; nothing in the UI can produce one. `fit()` on
the chart has no lower zoom bound where the wheel has one.

**Coverage.** Every file in `src/` and `scripts/` has now been read end to end.

## 45. The gaps §44 still had

§44 said every file had been read end to end. It had not - `index.ts`,
`workflow.ts`, `App.tsx`, `OrgChart.tsx`, `Code.tsx` and `Settings.tsx` still
had unread stretches, mostly imports, type blocks, JSX and style objects.
Reading them found one more:

- **"Use the ones Bullpen ships" deleted your rulebook without asking.** It
  writes an empty string, which `workflow:writeFormat` turns into `rmSync` on
  `~/.bullpen/rules.md`. The shipped document is a fallback, not a backup of the
  operator's - so a file somebody wrote by hand went on one click, the same way
  a saved floor did in §44. It confirms now.

**Noticed, not changed.** `workflowFile` slugs a workflow's name for its
filename with a third slug function - not `names.slug`, not the project one -
and two names that slug alike (`My Floor`, `my floor`) overwrite each other's
file. Refusing the second name or suffixing it are both product decisions rather
than fixes. The work tree re-lists every expanded directory on its five-second
tick, one IPC call each. `Delete` on an open role panel takes the role off the
drawing with no confirm, which is right: it is a draft, `undo` is beside it, and
nothing is written until `save the floor`.

**Coverage, this time checked rather than asserted.** Every line of every file
under `src/` and `scripts/` has now been displayed and read, including the type
declarations, the JSX and the style objects. What follows from here would be a
different kind of pass - running the app against real agents, or writing tests
for the parts of `index.ts` that no harness can currently load - not more
reading.

## 46. A harness for the file that had none

Reading was finished at §45. What was left was the other half: thirteen of the
fixes were in `src/main/index.ts`, and nothing could load it. It imports
`electron` and `node-pty`, and reads the rules document through Vite's `?raw`,
so no test had ever executed a line of it - which is why every bug found there
was found by reading, and why none of them could be shown to be fixed.

`test/main-harness.ts` boots it outside Electron. Three things stand in:
`electron` becomes a recorder - `ipcMain.handle` into a map the test calls,
`webContents.send` into a list it reads; `node-pty` becomes a pty that is a
script rather than a process, so a test can make an agent print, finish a turn
or die; and `test/raw-hooks.mjs` teaches node the one Vite-ism the source uses.
Nothing about main itself is stubbed. `npm test` carries two more flags for it.

What that buys, in `test/main.test.ts` - and each of these was checked by
putting the bug back:

- an agent killed mid-turn no longer jams `reportWhenQuiet` for the rest of the
  run (§38's fourth finding)
- what a role never does follows the role, both at spawn and when it is said
  afterwards (§39)
- halting an agent answers the request it was blocked on rather than leaving it
  in the queue (§38)
- a shell belongs to the agent it was opened for, and closing that agent's
  shells leaves the ones belonging to an id that merely starts the same way
  (§41)

The hook endpoints are the real ones: the test reads the settings file main
wrote for the agent and POSTs to the URL in it, so a lifecycle event and a
tool-use verdict travel the same socket an agent's own CLI would use.

**Still untested, and why.** The remaining fixes are React components -
`Terminal.tsx`, the memory tab, the rules pane, the two confirms, the editor
buffer, the search cache. Testing those needs a DOM and a renderer, which is a
dependency this repo has deliberately never taken; the store half of them is
tested already. `verify:hook` costs real model turns and is not in the suite by
design. Nothing else is blocked on anything but a decision.

## 47. What the harness found once it could look

§46 built it to prove four fixes. Used to hunt instead, it drove main through
the paths nothing had ever executed - the mail router end to end, the inbound
door, a floor switch, the context and cost readers, the compact rule. **No new
bugs.** Every one of those behaves as its comments say, and the five probes that
were worth keeping are tests now: a refused message is handed back with
somewhere else to send it, work addressed to a role lands on somebody and on the
board, a turn's cost and window come off the transcript the hook named, a full
window at an idle agent is compacted, and the webhook answers its own knock.

Two things the hunt turned up that are not bugs:

- **Nothing Bullpen ships stands up a second fixed agent.** Every preset,
  `analyst-chain` included, names exactly one - dispatch. So `assistRoles()` is
  always empty, `assistId()` always null, `fixed:ensure` always returns nothing,
  `relayRules()` always falls back to `assignRules()`, and the `target !==
  godId` branch of the report prompt cannot run. On the shipped floors the
  analyst is hired, not stood up. None of that is dead code - a floor that names
  a second fixed agent uses all of it - but it is unreachable with anything in
  the box, which is how a path rots without anyone noticing. Worth either a
  preset that exercises it or a note that says it is for custom floors.

- **`Hive.drainInbox` has no production caller.** Only the tests read it, and
  they read it a lot: it is how eight assertions check what was routed. Deleting
  it would delete that coverage, so it stays.

**The gap this closed in §37.** That sweep looked for unreferenced files and
unused *exports*; it never looked at class methods, so a method nobody calls
would have survived it. Checked now, across every class in `src/`: `drainInbox`
is the only one, and it is above.

## 48. `the rules` is off the settings dialog

The floor is drawn now, and the chart says everything a floor is - who is on it,
who writes to whom, what a message does to a card. `the rules` was a second,
more abstract place to say the same things: a schema editor for the document the
floor is declared against. Two places to describe one thing is one place too
many, and it was the one nobody opened.

Gone: `FormatPane` and its nav entry, the `workflow:format` and
`workflow:writeFormat` channels with the two preload functions in front of them,
and - once nothing could write the document any more - `writeRules`, `sayType`,
`entityOf`, `fieldsOf`, `isOpen` and `lawSays` in `rules.ts`. The last four had
no caller outside the tests before this change either; §47's method sweep looked
at class methods and would not have caught a plain exported const.

**What stays, and why this is not the rules going away.** `src/rules.md` still
does both of the jobs that matter. `rulebook()` parses it for which laws run, so
`lint` still gates on it - and `generatorBrief` is handed the whole document, so
it is still what a model writing a floor is told the format is. Both read
`formatDoc`, which still prefers `~/.bullpen/rules.md` over the shipped copy.

**What the operator loses.** There is no longer anywhere in the app to read the
rules or to replace them. Dropping a `rules.md` into `~/.bullpen` still takes
over - it is a file for somebody who wants one, not a screen everybody has to
walk past. Worth a line in the README if that is meant to be discoverable.

The renderer bundle is 16 kB smaller. 312 tests pass; the two that went with it
tested writing a document nothing writes any more.

## 49. The drawing can now say the whole company

The floor is meant to be whatever the operator's work is - a teacher's, a
youtuber's, a marketing agency's - and the engine already was: role names,
capability names, board columns, briefs and both addresses are all the floor's
own words, and who assigns or checks is derived from the card rules rather than
read off a label. What could not be *drawn* was half of it. Four things closed
that gap.

**Saving the drawing no longer takes away who stands.** `staffed()` forced
`fixed: undefined, hireable: true` on every role but dispatch, so a floor that
named a second agent to stand from launch had that stripped the moment somebody
opened the chart and pressed save - and no way to say it again that survived.
It fills in what is missing now and overwrites nothing. This is also why no
shipped preset had a second standing agent (§47): not a choice, a consequence.
`staffed` moved to `chart.ts` so it could be tested at all.

**A new box does the work.** `addRole` gave it `capabilities[0]`, which on
`analyst-chain` is `speaksToHuman` - so a role drawn on the canvas answered to
the rules written about the boss, and reporting in opened a new card instead of
moving its own. It takes the word held by whoever already builds here, via
`buildsCapabilityIn` in `shape.ts` - which is `rolesWith` asked of the drawing
rather than of the floor that is running, so the canvas and the router cannot
disagree.

**A role can be told what kind of work it does, and whether it stands.** Two
controls on the role panel. The capabilities are the floor's own words, so the
panel lists what this floor named rather than four fixed ones.

**A new panel, `the company`.** What the drawing could never show: what this
floor calls you, what hiring is called, the kinds of work, and the stages a
card moves through. A teacher's floor and a youtuber's floor differ here more
than they differ in boxes and arrows.

**And the last four English words are the floor's now.** `opens a card`,
`closes it`, `their card` and `when` were matched in English, so a rule written
`mở thẻ` was refused - a floor could be written in Vietnamese right up to the
card rules and then not finished. A floor may name all four in the header; a
floor that names none still reads exactly as before, which every preset checks.

Drawn from `a new one` and saved, a floor now comes out as:

    - dieu-phoi → viet-kich-ban: mở thẻ · khi giao ý tưởng
    - viet-kich-ban → dung-phim: chờ dựng · khi kịch bản xong
    - dung-phim → dieu-phoi: đóng thẻ · khi video xong

**Left as it is.** The role panel does not offer `cli`, `cwd`, `never` or a
role's own placeholder words; those stay in the file, where somebody who wants
them will be. 316 tests pass, and the two fixes above each fail their test when
put back.

## 50. The floor came out of settings

`the company` panel lost its first block. Six controls asked everybody to rename
what this floor calls you, hiring, and the four words a card rule reserves - and
renaming any of them changes nothing anybody can see. A card rule never reaches
an agent; only the router reads it, and the router reads the parsed value, not
the words. Renaming the human address is worse than useless: every brief already
written to the old one is stranded, and the report never arrives. The file can
still say all five, and the parser still reads them - that part is tested and
costs nothing. What is gone is the panel asking about them.

What is left in `the company` is the half of a floor a drawing genuinely cannot
show: the kinds of work, and the stages a card moves through.

**And the floor is not a setting.** It was the first page of a dialog behind a
gear icon, reached through a column of groups and a row of tabs under it - two
levels of navigation for three destinations, one of which is the thing this app
is for. It has a button of its own on the title bar now and takes the window
when it is open. The line about agents still running the shape they started on
moved with it: that is about the floor, and it was in the footer of a dialog
that is now about this machine.

**Settings is one page.** With the floor gone there are seven small blocks left
- theme, terminal size, the office floor's colours, notifications, the
workspace, the two context thresholds, the inbound door - and a page you scroll
is cheaper to read than a place you have to navigate to. The groups, the tabs
and the seven styles that drew them are gone; the file is 258 lines shorter than
it was two changes ago.

**Why now, rather than with the rest of it.** The floor is what somebody sets up
before anything else, and the intent is for a fresh install to open on it. That
is a screen, not a page inside preferences - so making it one now is what turns
that later step into rendering the same component from `FirstRun`.

## 51. Settings is five blocks about this machine

Three things, all from looking at the screen rather than the source.

**The chosen option did not read as chosen.** Theme and the office floor's
colours are picked from a row of buttons, and "chosen" was a border one shade
off the unchosen ones. Next to a button the pointer had just left focused, the
ring around it read as the choice and the choice read as nothing. Chosen is
filled now, and the click blurs on its way out - the same `blur()` the old nav
buttons did, which the pickers never had.

**`inbound` was a worse copy of something already there.** The triggers tab has
the whole door: on, off, the port, the token, a curl line, a test, and the log
of who called. Settings had on, off and the port. Gone.

**`context` was in the wrong screen, and badly named.** The two thresholds
decide who takes work handed to a role: `pickForRole` compares an idle agent's
window against `hireAbovePct`, and past it somebody new is hired instead. They
read as a duplicate of the triggers tab's context row, which is a different
thing entirely - one agent's rule for typing `/compact` when its own window
fills - and they read that way because both were called "context" and neither
said what it decided.

They are on the floor's screen now, in `the company`, under **who takes the
next task**, with the two numbers labelled `give it to one under 50%` and
`hire past 70%`. Preferences is about this machine; how the company staffs
itself is not, and it is saved into the workflow either way.

What is left in settings: theme, terminal size, the office floor's colours,
notifications, and the workspace. Five blocks, one page, no navigation.

`Settings.tsx` is 292 lines, from 1014 three changes ago. Thirty-seven of its
forty-nine styles had outlived the panes that used them.

## 52. The floor is configuration, and the shell tab is gone

**The floor went back into settings.** §50 gave it a button on the title bar,
which put an icon nobody had learned next to four they had - and it is
configuration: set up once, come back to when the way the company works changes.
That is the same shelf as everything else in this dialog. Settings has two
sections in one row now - `the floor` and `this app` - which is one click, not
the group-then-tab it was before §50, and each section is one page with nothing
to navigate inside it. The stale-agents line and the unsaved-drawing guard came
back with it.

**The shell tab is gone, and the shell with it.** It was a second kind of
terminal beside the agent's own: `Shell.tsx` and the grid module `split.ts`
under it, `shell:open` in main, `openShell` and `closeShellsFor` in the preload,
and the `isShell` filters that kept those ptys out of the roster, the staffing
list and the stale check. With no way to open one, a `shell:` id cannot exist,
so all of it went - along with `SHELL_PREFIX`, `isShellId` and `isShellOf` in
`names.ts` and the two tests about them.

**What that costs.** There is no longer a terminal in an agent's workspace that
is not that agent's own CLI - `git log`, a test run, a look at what it wrote now
go through the agent, or through a terminal outside Bullpen. §41's finding about
shells outliving a fired agent is moot: there are none.

Nine tests went with the feature; 307 pass. The renderer bundle is 13 kB smaller
than before §50, and 465 lines of source went with the shell.

## 53. A floor moves cards without anybody writing a rule

**The board was dead out of the box.** Every shipped floor has an empty
`cardRules` - §44's `test/floors.ts` says so in as many words, and that is what
"an arrow is drawn by the operator and what it does to the board is theirs to
write" cost. Running `analyst-chain` as it ships, every message between every
pair of roles did nothing at all. Somebody drawing a floor had to write a line
on every arrow before the app showed anything.

**The knot.** The rules cannot be derived from the rules. `rolesWith(w,
'assigns')` is *whoever a rule with status `open` names*, and `checks` is
*whoever closes one* - so a floor with no rules cannot be asked either question,
and both are what deriving needs.

The way out was already in the format and already parsed: `- drafts (builds) —
writes the first version`. The bracket was read and thrown away, on the grounds
that the card rules say the same thing better. They do - and they are also the
one thing a floor drawn from scratch has none of. So the bracket is read again,
and consulted **only when the floor has written no rules at all**. The two can
never contradict each other because only one of them is ever asked.

`defaultCardRules(w)` is the eight branches `cards.ts` used to have, derived
from who does what and what the board's stages are for, named by role rather
than by capability - the capability is whatever this floor called it and the
role is not. Explicit rules win outright. Every shipped floor now moves cards in
its own words:

    content-floor:  chief → editor      opens a card
                    writer → editor     in_review
                    proofreader → writer  drafting (their card)
                    proofreader → editor  closes it
                    editor → chief      published

`solo`, with nobody to check, sends the builder's report straight to `done` -
the override that was already there for a floor with no checker.

The chart's capability rows have a `what it behaves like` dropdown, and a new
box takes the word declared as the doing of the work rather than whichever
capability was listed first.

**And the panels are a column.** They were 330x460 boxes floating on the canvas:
every one of them scrolled inside a box smaller than the thing it described, and
they covered the drawing they were about. They are the column beside it now,
full height, one at a time - the same slot `read it` uses, because you are
either reading the file or editing one thing in it. The title stays put and only
the body scrolls.
