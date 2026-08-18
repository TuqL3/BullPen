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
