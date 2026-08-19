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
