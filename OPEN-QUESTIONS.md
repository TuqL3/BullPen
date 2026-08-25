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
- **Still unverified:** the Windows package has never been *launched* on
  Windows, and nothing short of a Windows machine settles that. What was an
  assumption underneath it is now read rather than assumed: `loadNativeModule`
  (`node-pty/lib/utils.js`) tries `build/Release`, `build/Debug` and then
  `prebuilds/<platform>-<arch>`, each in a `try`/`catch`, so a binary for the
  wrong platform is a fall-through and not a failure. The Windows package
  carries `prebuilds/win32-x64` and `win32-arm64` complete — `conpty.node`,
  `pty.node`, `winpty.dll`, `winpty-agent.exe` — outside the asar.
- **Was wrong, not merely assumed:** "an Intel Mac falls back to the unpatched
  `prebuilds/darwin-x64`, so the descriptor leak returns there". macOS never
  takes the leaking path at all. `pty.cc` spawns through `pty_posix_spawn` under
  `#if defined(__APPLE__)` with `POSIX_SPAWN_CLOEXEC_DEFAULT`, and
  `scripts/patch-node-pty.mjs` guards its helper with `#if !defined(__APPLE__)`
  for that reason — the patch is a no-op on every Mac, of either architecture.
  It matters on Linux, which is built from source on the machine that runs it
  (`postinstall`), and never from a prebuild.
- macOS notarization needs Apple Developer, $99/yr, or Gatekeeper blocks the app.
- Windows code signing cert, ~$100-400/yr, or SmartScreen warns on every install.
- The icon is generated, not drawn: `scripts/make-icon.ts` writes `build/icon.png`
  from the same procedural bust the roster paints, and electron-builder derives
  the `.icns` and `.ico` from it. No bundled art, so no licence to honour.

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

**Since done, the way that line said:** positions live in `config.json` under
`ui.chart[<floor name>]`, written the moment a box is put down
(`OrgChart.tsx: remember`) and read back when the dialog opens. `mergeUi` folds
them in per floor, so saving one chart does not wipe another's, and the
workflow itself still carries no coordinates.

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
**Since done:** it asks. See §54.

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

## 54. Nobody is stood down mid-card without being asked

§28's own "fix if it bites", taken. `retire()` works out who the new floor has
no place for *before* it kills anything, and if any of them is holding an open
card it stops and asks - one dialog naming them, not one per agent. An idle
agent is nobody's question: there is nothing in its hands to lose.

The second answer keeps **the floor that is running**, not the agents. Keeping
them on a floor with no role for them is the half-applied state the rest of
`applyFloor` exists to avoid, and `retire()` is its first line, so refusing
costs nothing to undo - `wf` has not moved. Both doors (`workflow:set`,
`workflow:patch`) hand that back as an `error`, which is the one shape every
caller already renders. `defaultId` and `cancelId` are both the keep answer, so
escape and the window close are never the destructive one.

**Breaks if wrong:** a floor that cannot be switched to while anybody holds a
card - the answer is to finish or abandon the card, which is what the board is
for. And a headless main (`win` null) never asks and stands them down as before.

## 55. The Windows package carried macOS binaries

`build/Release` is whatever `npm install` compiled on the build machine - on a
Mac, a Mach-O `pty.node` and `spawn-helper` - and it rode into the Windows
package, where node-pty looks in `build/Release` first and falls through past
it. It worked, and it was also the one thing that made the Windows load path a
try/catch rather than a fact. Removed in `scripts/after-pack.mjs`.

**Not in `electron-builder.yml`.** A platform-level `files:` key was tried
first, and it drops the packer's own default excludes: the very next build put
`release/` inside the app, and produced a 3.8 GB `app.asar` and an NSIS step
that died on `failed creating mmap`. The `afterPack` hook touches the packed
output and nothing else, and the package is back to 193.8 MB with
`prebuilds/win32-x64` and `win32-arm64` intact.

**Breaks if wrong:** a Windows machine that builds for itself has a legitimate
`build/Release` and it would be deleted too. It is guarded on `existsSync` and
falls back to the prebuilds either way, which is what the packaged app has
always used.

## 56. The app can tell you it is out of date, and on Windows fix it

`electron-builder` publishes a `latest*.yml` feed to GitHub Releases with a
sha512 per artifact and embeds `app-update.yml` in the package;
`electron-updater` reads both, compares versions, downloads the one for this
platform and checks it against that hash. None of that is re-implemented here.
`src/main/update.ts` is the state the UI shows and the three verbs it offers -
check, download, install - and one thing the library does not answer.

**The thing it does not answer: whether this copy can install anything.** macOS
hands the install to Squirrel, which refuses an application it cannot read a
code signature from - which is every build made without a Developer ID. Asking
`codesign -dv` *before* the download turns a button that always fails into one
that says what it can do, which is open the releases page. Windows needs none of
this: NSIS replaces an unsigned install happily.

**Nothing happens automatically twice.** `autoDownload` off, because a download
is a decision; `autoInstallOnAppQuit` off, because an app that changed while
nobody was looking is worse than one that asked. Installing quits the process
and every agent on the floor is a child of it, so the renderer confirms in the
words of what is lost rather than "are you sure".

**Three things the first draft had wrong**, all found by the tests:

- `stop()` cleared the interval and not the delayed first check, so a test
  process - and a quickly-quit app - was held open by a timer nobody could see.
- `electron-updater` was imported at the top of `index.ts`. It is CommonJS and
  loads Electron on import, which broke every one of the 49 tests that boot
  main. It is a dynamic import inside `whenReady` now, packaged-only, wrapped in
  a `try` - an app that cannot check for a newer version is still an app that
  runs.
- The harness's `app` stub had no `getVersion`. Adding one *beside* the existing
  `isPackaged: true` was the fix; adding a second `isPackaged: false` under it -
  which is what the first attempt did - silently flipped that flag for every
  test in the file, and they passed for the wrong reason.

**Breaks if wrong:** the feed is public GitHub - a private repo would need a
token, and a token cannot be shipped inside an app. There must be at least one
published release or there is nothing to compare against; `npm run release`
builds both platforms and uploads, and wants `GH_TOKEN`.

**Not verified:** an actual upgrade. That needs two published releases and a
signed macOS build, which is the $99 this has been deferring since §55. What is
verified is everything up to it: the feed is generated with per-artifact sha512,
`app-update.yml` is embedded in the package, `electron-updater` is inside the
asar, and the state machine around them is tested against a fake updater and a
real `codesign`.


## 57. A release is a tag, and the runners do the rest

§56 left the app able to *find* a newer version. What it did not leave was a way
to make one that did not involve one laptop having both toolchains, an unsigned
Windows package built from macOS sources, and a `GH_TOKEN` in somebody's shell
history. `.github/workflows/release.yml` is that: push `vX.Y.Z`, and macOS packs
on a macOS runner and Windows on a Windows runner.

**Why a matrix rather than one `--mac --win` run.** node-pty is native and its
postinstall patch (`scripts/patch-node-pty.mjs`) is *compiled in*, so the copy
that ships has to be built where it runs. §55 is the record of what a cross-built
package looks like: it works, by falling through a `try/catch` to prebuilds, and
carries the other platform's binaries as evidence.

**Why a separate job creates the draft.** Two builders publishing to a release
that does not exist yet both try to create it, and the loser's artifacts land
nowhere anybody looks. One `gh release create --draft` up front, and both
builders find it and upload into it. `fail-fast: false` for the same reason:
one platform failing must not cancel the other, because a draft with half a
release in it is still worth having.

**Why the tag is checked against `package.json`.** electron-builder publishes to
`v${version}` and does not read the tag at all. Tag `v1.2.0` with `0.1.0` still
in `package.json` and it opens `v0.1.0`, uploads there, and reports success -
the release you tagged stays empty and the one nobody tagged has the artifacts.
Six lines in the `draft` job, and it is the only failure here that would
otherwise be silent.

**Why the release stays a draft.** `electron-updater` cannot see a draft, so
nothing on anybody's machine moves until a human presses Publish. That is the
same decision as `autoDownload = false` in §56, one level up.

**Breaks if wrong:** CI has no Developer ID, so every macOS package it makes is
unsigned and takes the `manual` path §56 describes - the button opens the
releases page instead of installing. Signing is still the deferred $99. Windows
NSIS installs in place unsigned, so that half is whole.

*Superseded by §58 for the macOS half: Sparkle does not need the $99, so the
`manual` path is gone and the workflow grew a third job.*

**Not verified:** the workflow has never run - there are no tags on this repo
yet, and a workflow file cannot be executed locally. What is verified is
everything it calls: `npm test` (400 pass), `npm run build`, and
`electron-builder --mac`, which produced both DMGs, both zips, `latest-mac.yml`
with per-artifact sha512, and ran the `afterPack` chmod on 3 spawn-helpers.


## 58. macOS updates itself now, and it is not Squirrel that does it

§56 and §57 both end at the same wall: Squirrel.Mac will not replace an
application it cannot read a Developer ID signature from, so every macOS release
this project has ever made offered a button that opened a download page. Sparkle
validates an update by the EdDSA signature on the *archive* rather than by the
app's own code signature, so an ad-hoc signed build updates itself for real. The
`manual` state, `canInstallInPlace`, and the `codesign -dv` call that fed them
are deleted - that is the whole point of the change, not a side effect of it.

**Windows was not moved, deliberately.** The obvious symmetry is WinSparkle, and
it is not available: `winsparkle-node@0.6.0` is the only binding on npm, it calls
`v8::String::Utf8Value(args[0])` - the one-argument constructor V8 removed in 6.9
- so it does not compile against Electron 43 (`v8-primitive.h:629` has only the
two-argument form); it ships no arm64 DLL; its `binding.gyp` has no platform
condition, so `npm install` runs Windows sources on the macOS dev machine; and it
bundles WinSparkle 0.6, which predates Ed25519 and can only do DSA. The upstream
`electron-sparkle-updater` README recommends the same split independently.
electron-updater stays on Windows, where NSIS was never the problem.

**Four things the first pass had wrong**, each found by actually packaging:

- `electron-builder.mjs` was never read. electron-builder 26 does not discover a
  `.mjs` config, and the run reported nothing - it fell back to defaults and
  produced a lowercase `bullpen` in `dist/` with no afterPack, which reads as a
  successful build. The scripts pass `--config` explicitly now.
- `sparkleBuilderConfig()` returns a root `zip` key that electron-builder 26
  rejects outright. Only `dmg` is taken from it.
- Ad-hoc signing ran on each per-arch staging copy, which rewrote
  `Electron Framework.../CodeResources` differently per arch and made
  @electron/universal refuse the merge. It runs on the merged bundle only, which
  electron-builder gives afterPack a second pass for.
- `singleArchFiles` is only forwarded to the ASAR merge; node-pty's binaries live
  in `app.asar.unpacked`, which is walked separately and reads `x64ArchFiles`.

**Why the mac package is universal now.** `generate_appcast` refuses a directory
holding two archives with the same bundle version - "Duplicate updates are not
supported" - and an arm64 zip and an x64 zip of one release are exactly that. An
appcast item carries no architecture, so a per-arch pair cannot share a feed. The
cost is that every update is both slices, roughly twice the download. The
alternative, a feed per architecture chosen at runtime, puts the architecture in
three places at once and fails by having an Intel Mac update itself to a build
that will not launch. Delta updates are the upgrade path if the size bites.

**Breaks if wrong:** `generate_appcast` accepts a wrongly-shaped private key,
writes an appcast with no `sparkle:edSignature` in it, and exits 0 with no
warning. An app carrying `SUPublicEDKey` then rejects every update it is offered,
and the release looks complete. The workflow greps for the signature and fails
rather than publishing that, but the key itself has to be the file
`generate_keys -x` writes.

**Why an appcast comes out unsigned, settled by experiment.** `generate_appcast`
signs only when the public key in the packaged app's `Info.plist` matches the
public half carried inside the private key it was handed. Mismatched, it writes
the item, omits `sparkle:edSignature`, prints nothing and exits 0. Three runs
pinned it down: the same key file that `sign_update` signs the same zip with
produced no signature through `generate_appcast` while the plist held the
packaging placeholder; rebuilding with a plist key drawn from the same pair made
the signature appear; and with the plist pinned, a private blob carrying that
key at bytes 32..64 was refused while one carrying it at bytes 64..96 was
signed. So the comparison is against the **last 32 bytes** of the private blob,
and that is what `scripts/check-sparkle-keypair.mjs` compares - in a second,
before a build, instead of after one.

The first guess was wrong and is worth recording as wrong: the binary's own help
text calls the private key "the private EdDSA string (128 characters)", and a
128-character key was already in hand and still did not sign. Key *shape* was
never the problem.

Ed25519 as Sparkle does it is not interchangeable with the standard: it uses
orlp/ed25519, whose 64 bytes are an expanded key rather than seed + public, so a
signature made with a hand-built key does not verify against a public key derived
the ordinary way. That is why the keypair check compares stored bytes and does
not try to verify a signature.

**Not verified:** the signature. Making a Sparkle key means writing one into the
operator's login Keychain, which is theirs to do, not this session's - so the end
of the chain was exercised with a synthesized ed25519 key instead, and that is
exactly the case that produced the silent unsigned appcast above. What is
verified: the bridge compiles against Electron 43 and loads inside the packaged
app, exporting `init, checkForUpdates, installUpdateNow, setAutomaticChecks`, and
resolving `@rpath/Sparkle.framework` (2.9.4) out of `Contents/Frameworks`; the
universal package carries `x86_64 arm64` for the app, the bridge and the
framework; `codesign --verify --deep --strict` passes, which is Sparkle's own
gate; `SUFeedURL`, `SUScheduledCheckInterval` and 35 localizations land in the
plist, and `SPARKLE_ED_PUBLIC_KEY` reaches `SUPublicEDKey` when set and leaves the
placeholder when not; `generate_appcast` runs over the real zip and writes an
item with the right version, minimum system version and enclosure URL; and the
signature guard fires on the unsigned appcast that run produced. 402 tests pass.

**No "Check for Updates" anywhere in the UI, on purpose.** The bridge is four
functions and none of them is a callback, so main cannot be told an update was
found - which is the whole reason the title-bar chip stays empty on macOS.
Sparkle's own scheduler, armed once with `setAutomaticChecks(true)` and paced by
`SUScheduledCheckInterval`, is what looks; its own window is what reports. A
button wired to `checkForUpdates()` would open that same window on demand, and
it is the one thing worth adding here if anybody ever asks for it.

**What the first two runs proved.** `v0.1.1` reached the remote and the workflow
ran. It stopped where it was built to stop: the secrets had been added as
*environment* secrets, which are a separate store and never reach a job that
does not declare `environment:`, so `SPARKLE_ED_PUBLIC_KEY` arrived empty and the
guard refused to build. Moved to repository secrets, the second run built the
whole macOS package and stopped at the appcast: the two secrets were not two
halves of one key, so nothing was signed. Both stops are the guards working
rather than the pipeline failing - no release has been published with an updater
that could not update. `gh release upload` has still never executed.

**Why `rebuild:sparkle` names its compiler.** node-gyp's generated Makefile
takes the compiler from `CC ?= cc`, and `cc` has been a name for the system C
compiler for as long as there have been C compilers. It is also the name of this
team's `claude`/`codex` wrapper, which is on `PATH` ahead of `/usr/bin`. node-gyp
hands it `-o` and it answers `error: unknown option '-o'` - a build failure that
says nothing about what it really hit. Only the C target breaks: node-pty is C++
only and `c++` is not shadowed, which is why `npm install` has always worked and
only this one script did not.

Pinned to `/usr/bin/clang` and `/usr/bin/clang++` rather than to what `xcrun -f
clang` prints. Those two are the Xcode shims: they respect `xcode-select` and
they inject `-isysroot`. The path `xcrun -f` resolves to is the raw binary, which
does not - so it gets past the C target and then fails compiling the Objective-C
bridge with `'Foundation/Foundation.h' file not found`, having looked in
`/System/Library/Frameworks`, where the headers have not lived since the SDK
moved. Both failures were reproduced; the pinned form builds with the wrapper
first on `PATH` and no environment set.

The script only ever runs on macOS - Sparkle is a macOS framework and
`fetch-sparkle.sh` is bash - so a hard macOS path costs nothing elsewhere.


## 59. A packaged mac app cannot find `claude`, and says nothing about it

The first time this app was installed rather than run from a terminal, its
terminal tab was blank. Nothing errored. The pty was real, node-pty was fine,
the window drew - and every agent exited immediately having printed nothing.

`launchd` hands a GUI process `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else.
It does not read a login shell, so nothing a shell rc file puts on `PATH` is
there. `claude` on this machine lives in `~/.local/bin`, which is on `PATH` in
every terminal and on none of launchd's four directories. Run from a terminal
the app inherits a working `PATH` and everything is fine, which is why this
survived every test until somebody double-clicked it.

**Why it is invisible rather than loud.** node-pty's `spawn` does not fail: a
pty is allocated, a child is forked, and it is the *child* that cannot exec.
The parent sees a normal pty that closes. Measured, with `PATH` cut down to
launchd's:

    EXIT code=1 signal=0 output=""

An empty string is exactly what a terminal renders as a blank pane. There is no
error anywhere to surface, because from the app's side nothing failed.

**The fix** is the one every Mac developer tool arrives at: ask the login shell
what `PATH` is, once, at startup, before anything is spawned. `-i` so it reads
the rc file where `PATH` is actually set, `-l` so it reads the profile.
`loginShellPath` in `src/main/ctx.ts`; taken as a union with the `PATH` already
there rather than a replacement, because Electron and the launcher put things on
it too. Bounded by a timeout, packaged builds only, non-Windows only.

The answer is read from between two markers rather than from the last line of
output: an interactive shell prints whatever the rc file feels like printing -
a version notice, a greeting, half a prompt - and any of it lands on stdout
beside the answer.

**Not a Sparkle regression**, though it was found immediately after one. It has
been true of every macOS package this project has ever produced; nobody had
installed one before.

**Two false leads, recorded because both looked conclusive.** `node-pty` was
first reproduced failing with `posix_spawnp failed` inside the packaged app -
which was an artifact of the test: requiring node-pty by a path that already
said `app.asar.unpacked` makes its own `.replace('app.asar', 'app.asar.unpacked')`
produce `app.asar.unpacked.unpacked`, and no helper is there. Loaded the way the
app loads it, through the asar path, it spawns fine. Then the first end-to-end
attempt showed no agent starting at all, which was a fresh `BULLPEN_HOME`: with
no `godCwd` chosen the window stops at the setup screen and spawns nobody.
Seeded with one, the packaged app under launchd's `PATH` starts Michael and the
`claude` process is alive.

**Breaks if wrong:** a shell whose rc file is slow past the timeout, or which
does not take `-ilc`, leaves the old `PATH` and the old blank tab - logged, not
guessed at. A user whose `claude` is only a shell *alias* is not helped by this
and cannot be: an alias is not a file, and `execvp` cannot see one.

## 60. A first run ends on the floor, not on an empty window

Choosing a directory for Michael was the whole of first-run setup, and it is not
the interesting half. Who is on the floor and how work moves between them is,
and that lived behind a gear icon nobody had been given a reason to press yet.
`chooseGodHome` now opens Settings on its way out.

Two thirds of what this needed already worked and it is worth writing down which,
because it looked like three changes and was one:

- Settings opens on `the floor` already - that is its initial section, not a
  default that has to be chosen.
- The floor it draws is already the one named `default`: `wf` in main starts as
  `DEFAULT_WORKFLOW`, so a machine with no `workflow` in its config is running
  that shape before anybody opens anything.

`PRESETS` holds exactly one floor today, so nothing here offers a choice between
floors - it shows the one there is. If a second preset ever lands, "the default
one is selected" stops being a tautology and this is where to look.

**Assumed:** that "the default floor" meant the workflow named `default` in
`presets.ts` and not `ui.floor`, which is the colour the office floor is painted
and also defaults to a word (`green`). The two are unrelated settings that share
a noun. If the colour was meant, this is the wrong dialog section entirely.

**Not verified:** the click. The change is one `setSettings(true)` in the path
that already unmounts the first-run screen, typechecked, and the dialog is known
to have a floor to draw by then - `setWf` runs before `godSetup` is even asked.
What has not been done is a first run with a hand on the mouse. To try it
without disturbing a real setup:

    BULLPEN_HOME=/tmp/bp-firstrun npm run dev


## 61. One secret, because two of them could not be kept in step

Three release attempts died at the same place, and none of them died at a bug:
`SPARKLE_ED_PUBLIC_KEY` and `SPARKLE_ED_PRIVATE_KEY` were two values a person
had to copy separately and keep matched, and they were not matched. The guards
built in §58 and after it caught it faster each time - a full build, then ten
seconds - but catching it faster is not the same as it not happening.

The public key is the last 32 bytes of the private key. There was never a reason
for a human to hold both. `--print-public` derives it, the release workflow puts
it in the packaging step's environment, and `SPARKLE_ED_PUBLIC_KEY` is gone as a
secret. A pair that is computed cannot drift.

**Why derivation is safe to trust here.** It is the same comparison Sparkle
makes: §58 established by experiment that `generate_appcast` matches the plist
key against the *last* 32 bytes of the private blob, and that holds for both
lengths Sparkle accepts - 64 bytes is seed then public, 96 is the same with the
public half repeated. A key of any other length is refused outright rather than
half-read, because a plausible-looking public key derived from the wrong bytes
ships inside the app and rejects every update it is offered.

**What is still checked, and why it is not redundant.** The derived key is what
goes into the packaging step; the packaged `Info.plist` is what
`generate_appcast` actually reads. Those are the same value unless a step failed
to receive its environment or `release/` was stale, which is exactly the kind of
thing that produces a green build and a dead updater. The post-build `--plist`
comparison and the `sparkle:edSignature` grep both stay.

**The private key never enters the packaging step now.** Only the derived public
key does, through a step output - it is not secret, it ships inside every build.

**Breaks if wrong:** a Sparkle release that ever changes the private key layout
so the public half is not last. The `--plist` check would catch it before an
unsigned appcast could be published, so the failure is loud, but the fix would
be here.

**Not verified:** an actual export. `generate_keys -x` writes to the operator's
Keychain and is theirs to run, so what has been exercised is synthesized keys of
both accepted lengths, the `--print-public` path through `$GITHUB_OUTPUT`
(44 characters, padding intact, one line), and the post-build comparison
agreeing with what the derivation produced. One earlier real export measured 102
characters, which is neither length Sparkle accepts - that is now refused with
the expected length named rather than silently half-read.

## 62. "Open With → BullPen" on a folder

A folder is the one thing every agent must be given, so Finder should be able to
hand one over. `fileAssociations` cannot say it - that key is a list of
extensions and a directory has none - so `electron-builder.config.mjs` writes the
raw `CFBundleDocumentTypes` entry claiming the `public.folder` UTI.

**`LSHandlerRank: Alternate`**, not Owner or Default. Owner would make BullPen
the handler for every folder on the machine, which is what happens instead of
double-clicking into them.

**The clobber that was avoided:** `extendInfo` is merged over Sparkle's, not
written beside it. A plain `extendInfo` key there replaces the whole dictionary,
taking `SUFeedURL` and `SUPublicEDKey` with it - and an app with no feed does not
report that it has no feed, it silently never updates again. Checked on the
built plist: both Sparkle keys survive alongside the new document type.

**The renderer pulls, the main process only nudges.** `open-file` queues the
path and emits `open:waiting` with no payload; the renderer answers with
`open:pending`, which drains the queue. Pushing the path instead means a window
reload re-reads a queue that was already handled and reopens the wizard on a
folder the user dealt with ten minutes ago.

A folder that an agent is already working in selects that agent rather than
opening the wizard, matched on `cwd` exactly - a parent or a child of an agent's
directory is treated as a new one.

**Verified:** `lsregister -f` on the built bundle, then `lsregister -dump`, shows
`claimed UTIs: public.folder` under BullPen's entry. The registration was undone
with `lsregister -u` afterwards so a path under `release/` is not left in the
LaunchServices database.

**Not verified:** the click itself. Actually choosing BullPen from Finder's
Open With menu and watching the wizard fill in is not something that can be
driven headlessly, so the chain from LaunchServices to `open-file` to the queue
is verified at both ends and assumed in the middle.

**macOS only.** Windows would need argv parsing plus the single-instance lock,
and Linux a `.desktop` entry with `inode/directory`. Neither is written; the
`open-file` event does not fire on either platform, so nothing there breaks - it
simply does nothing.

## 63. A green step that produced nothing, and the build that trusted it

`v0.1.3` packaged the placeholder public key and only said so after the mac
build had finished. The derivation step before it was green.

```bash
echo "public=$(node scripts/check-sparkle-keypair.mjs --print-public)" >> "$GITHUB_OUTPUT"
```

Under `set -e` that line reports the exit status of `echo`, not of the command
substitution inside it. The node script threw, printed its `::error::` to
stderr, and the step wrote `public=` and exited 0. An empty value then reaches
`electron-builder.config.mjs`, where `process.env.SPARKLE_ED_PUBLIC_KEY?.trim()
|| undefined` falls back to undefined and `electron-sparkle-updater` writes its
placeholder - which is what the post-build `--plist` check found ten minutes
later.

Measured rather than assumed:

```
--- inlined into echo ---     --- assigned on its own line ---
boom                          boom
public=                       exit=1
REACHED-END
exit=0
```

Both workflows now assign on their own line. The release job additionally
refuses an empty derived key by name, and the packaging step refuses to start
if the variable did not reach it - the two ends of the same wire, so a future
failure names which end broke instead of costing a build to find out.

**Lengths are printed, values are not.** The derived public key is not secret -
it ships inside every build - and is printed in full; the signing key appears
only as a character count.

**What this does not fix:** the signing key itself. It ran on `v0.1.4` and
failed in ten seconds with the byte count in the log, which is what it is for.
The count was 32 - and the guard was wrong to refuse it. See §64.

## 64. The guard refused the only format Sparkle still exports

`v0.1.4` and `v0.1.5` both died in ten seconds on the same line:

```
Error: SPARKLE_ED_PRIVATE_KEY decodes to 32 bytes; Sparkle accepts 64 or 96.
```

The key was correct. The check was not. `generate_keys -h` says so plainly, and
reading it was worth more than three tags:

> if the private key is generated in the new format (i.e. the key file after
> base64 decoding is **32 bytes**), then the exported key file is the base64
> encoding of the **private seed**

32 bytes is the current format. `PRIVATE_KEY_BYTES = [64, 96]` came from a
Sparkle *import* error - "Imported key must be 64 bytes or 96 bytes (for the
older format)" - which describes what `-f` accepts, not what `-x` writes. Two
lengths that were never the whole list, taken as the whole list.

**A seed is not a public half, so the derivation had to change.** 64- and
96-byte keys carry the public key in their last 32 bytes and it can be sliced
off. A 32-byte seed carries nothing: the public key is computed from it, by
standard EdDSA key generation.

That is not obvious in this codebase, because §58 established that Sparkle
signs with orlp/ed25519 and node cannot verify its signatures - from which
"node cannot derive its keys either" is an easy and wrong inference. Key
generation is RFC 8032 and node does it. Pinned by the RFC 8032 §7.1 vectors in
`test/sparkle-keypair.test.ts`, so the inference cannot be made again quietly.

**What can no longer be told apart.** A 32-byte seed and a 32-byte public key
are the same shape, so length cannot catch a public key pasted into the private
secret - the mistake §64 previously accused the operator of. Only one case is
still detectable: the same value in both, which is now reported as itself.

**Wrong twice, recorded once.** The 102 characters guessed in §63 and the
"public key pasted by mistake" of the first §64 were both invented to explain a
failure whose cause was in a help text nobody had opened. Both are struck; this
is what happened.

**Not verified:** that this repo's actual key derives to the public key its
Keychain holds. `generate_keys -p` prints that value and would settle it in a
second, but it reads the operator's Keychain and is theirs to run. What is
verified is the derivation itself, against RFC 8032.

## 65. Node decodes base64 that Sparkle refuses

`v0.1.6` got further than any release before it - key derived, app packaged,
plist check passed - and then:

```
Error: Private key not decoded from the argument because it isn't base64
encoded. Please provide a valid key and confirm the contents of the key are
correct.
```

`Buffer.from(x, 'base64')` does not fail on bad input. It **ignores every
character outside the alphabet** and decodes what is left. Measured:

```
plain seed              -> 32 bytes | canonical: yes
wrapped in quotes       -> 32 bytes | canonical: NO
with internal newline   -> 32 bytes | canonical: NO
key: <seed>             -> 34 bytes | canonical: NO
```

A key carrying quotes or broken across two lines decodes to exactly 32 bytes,
which is the length the check was looking for. Sparkle's decoder is strict, so
the same value is refused - but only by `generate_appcast`, after the build that
produced the archives it was going to sign.

Both keys are now required to be canonical base64: decode, re-encode, and
compare. Anything node had to drop to make it fit no longer passes.

**Whitespace is not the problem, and was checked rather than assumed.** With a
throwaway key, `generate_appcast --ed-key-file` accepted the file with no
trailing newline, with LF, with CRLF, and with a leading space - all four
reached "No usable archives", meaning all four keys were read. Sparkle's own
help documents `echo "$KEY" | generate_appcast --ed-key-file -`, and `echo`
appends a newline, so this had to be true.

**Padding is added, not demanded.** An unpadded key is still a key, and none of
the three lengths Sparkle accepts can produce the three-`=` case that would make
that ambiguous.

**What this cost, and the pattern behind it.** Every failure in §63, §64 and
this one shared a shape: a guard that answered a question node could answer
cheaply instead of the question Sparkle actually asks. Length instead of
validity, `[64, 96]` instead of what `-x` writes, `echo "x=$(cmd)"` instead of
an exit status. The three checks now in front of a release are worth what they
cost only because each one is the same comparison `generate_appcast` makes.

**Not verified:** what the secret actually contains. It is a secret; the guard
reports its character count and how many of those characters base64 has no
meaning for, which is enough to say what to fix without printing any of it.

## 66. Forty-five characters, and the terminal put the extra one there

The guard added in §65 answered on `v0.1.7`, in ten seconds:

```
45 characters, 1 of them outside the base64 alphabet
```

A 44-character key with one character too many, and not at either end - the
count is taken after trimming. That leaves a terminal artefact: `key.txt` has no
trailing newline, so `cat` leaves zsh's reverse-video `%` at the end of the
line, and selecting the line copies the `%` with it.

The message now says **where** the stray character is, because that is what
turns "something is wrong" into "I know what I did". At the end: a terminal
artefact, named along with the `%`. In the middle: a line break from a wrapped
paste. A position is not key material - "character 45 is not base64" says
nothing about the other 44 - so this can be said out loud in a public log.

It also says what to run instead:

```bash
tr -d '\n' < key.txt | pbcopy
```

which never renders the key in a terminal at all.

**Not verified:** that the `%` is what this particular secret carried. One stray
character at the end is consistent with it and with nothing else that has come
up, but the value is a secret and the guard is deliberately unable to name it.
If the next run still refuses the key, the count and the position will have
changed and this explanation is wrong.

## 67. The same 45 characters, twice

`v0.1.8` ran the §66 code and reported exactly what `v0.1.7` had: 45 characters,
one stray, at the very end. The secret had not changed between the two runs -
the operator's local check on `key.txt` passed, so the file was clean and
something between the file and the secret box was not.

The guard now names the character by code point. It is not part of the key -
it is the contamination - so `U+0025` can be printed in a public log while the
44 characters around it cannot. Guessing at it from a description has now cost
two runs: `U+0025` is zsh's `%`, `U+200B` a zero-width space that survives
`trim()` and is invisible in every editor, `U+0022` a quote.

**The check that closes the loop is local, and does not involve GitHub.**

```bash
SPARKLE_ED_PRIVATE_KEY="$(pbpaste)" node scripts/check-sparkle-keypair.mjs --print-public
```

That runs the same guard against exactly what is about to be pasted. A public
key printed means the clipboard is clean, and if the secret still reports 45
characters afterwards then the paste did not take - which is a different problem
from a mangled key and had until now been indistinguishable from one.

**Not verified, and now unlikely to matter:** which of the two it is. The code
point in the next run settles the first; the local clipboard check settles the
second; neither needs a tag.

## 68. Windows: two installers, two filenames, one of them unspawnable — RESOLVED

The first-run dialog on Windows refused every directory with `File not found:`
and nothing after the colon. Three faults behind one message.

**1. The name.** `pty.ts` defaulted to `claude.cmd` on `win32`, and all four
`spawnAgent` call sites in `index.ts` passed `cmd: 'claude'` over the top of it.
node-pty walks `Path` testing the exact filename with no `PATHEXT` expansion
(`path_util.cc:54`), so a bare `claude` was never going to match anything an
installer writes.

**2. The file.** Fixing 1 alone would have moved the failure rather than
removed it, and this was tagged unverified in the first pass. It is verified
now, by reading rather than by running: node-pty calls

```c
CreateProcessW(nullptr, mutableCommandline.get(), ...)   // conpty.cc:413
```

with `lpApplicationName` NULL, and `CreateProcessW` loads images. A `.cmd` is
not one. So `claude.cmd` passes node-pty's own `file_exists` check in
`startProcess` and then dies inside `connect()` with `Cannot create process` -
and `connect()` is called synchronously from the `WindowsPtyAgent` constructor
(`windowsPtyAgent.ts:117`), so the throw does reach the `try` around `spawn`.

The two installers do not write the same file: the native installer writes
`claude.exe`, a global npm install writes `claude.cmd` and `claude.ps1` and no
`.exe` at all. `resolveCli()` picks whichever is on PATH, `.exe` first, and
wraps a `.cmd` in `cmd.exe /d /c`, which is the only way a batch file runs.

**Why null and not a fallback.** With nothing installed, `cmd.exe /d /c
claude.cmd` spawns perfectly well - cmd.exe is always there - and paints
`'claude.cmd' is not recognized` inside an agent pane. The pty came up, so
nothing above it knows to say anything. `resolveCli` returns null instead and
`spawn` throws `missingCli()`.

**3. The message, and where it appeared.** It named neither the directory nor
the fix, and sat under the box the operator had just typed a path into.
`missingCli()` says the CLI is missing and that the directory is fine.

**Verified:** `test/pty.test.ts` covers `resolveCli` across both installers,
both installed at once, neither installed, an empty PATH, an explicit command,
an explicit script, and Unix; and `spawnFailure` across both wordings node-pty
produces plus an unrelated failure it must hand back untouched.

**Not verified:** that a real agent comes up in a real ConPTY on a real Windows
machine. Everything above is read off node-pty's source and the `CreateProcessW`
contract. No Windows machine was available. What is left to be wrong is the
behaviour of the pair, not the choice of filename.

**Two holes that made this permanent, both closed.** `god:move` wrote `godCwd`
into the config before spawning, so a failed first run still recorded the
directory as chosen and the dialog never appeared again - it is written after
the spawn succeeds now. And the renderer's boot path put the reason into
`console.error` and nothing else, so a machine that lost the CLI after setup
opened to an empty window with no explanation; it now reopens the first-run
dialog carrying the reason.

