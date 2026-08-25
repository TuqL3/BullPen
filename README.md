# Bullpen

A local multi-agent harness for Claude Code. Hire a floor of agents, each a real
`claude` process in a real pseudo-terminal, let them mail each other, and keep a
human in the loop on anything destructive.

Everything runs on your machine. No server, no account, no telemetry.

## Status

Phase 1 — working core, plain UI. The office-floor simulation is Phase 2 and
reads the same state, so it needs no changes to the main process.

## Run it

```bash
npm install     # rebuilds node-pty against Electron via postinstall
npm run dev
npm test        # router + approvals, no build step, no GUI needed
```

`npm run verify:hook` checks the safety layer end to end against the real
`claude` CLI — it makes an agent attempt `rm -rf` on a decoy in a temp dir and
asserts the hook intercepts it. Costs tokens, so it is separate from `npm test`.
Re-run it after every Claude Code update.

Requires Node 20+ and the `claude` CLI on your PATH.

If `npm run start` reports `Error: Electron uninstall`, npm skipped Electron's
binary download (there is no `node_modules/electron/dist`). Fetch it by hand:

```bash
(cd node_modules/electron && node install.js)
```

**WSL:** run npm from inside WSL, not from Windows. Pointing Windows npm at
`\\wsl.localhost\...` fails twice over — CMD cannot cd into a UNC path, so
`node_modules/.bin` drops off PATH, and the installed `node-pty` and Electron
binaries are Linux ELF that Windows cannot execute anyway. WSLg renders the
window on the Windows desktop, so there is no reason to cross over.

A native Windows or macOS build needs its own clone and its own `npm install`
on that OS. `node_modules` is never shareable across platforms once a native
module is in it.

## How it works

Two planes, one renderer.

**Terminal plane** — `src/main/pty.ts` spawns each agent with `node-pty` and
streams its output to the renderer over per-id IPC. Nothing is simulated: an
agent is the same `claude` you would run by hand.

**Hive plane** — `src/main/hive.ts` is a mailbox on disk.

```
~/.bullpen/hive/agents/<id>/outbox/*.json    agent writes here
~/.bullpen/hive/agents/<id>/inbox/*.json     router delivers here
~/.bullpen/hive/dead/*.json                  unroutable
```

An agent sends mail by writing a JSON file — no new tool, no protocol. The
router polls every 500ms, moves messages, and types the delivery into the
recipient's prompt. `to: "*"` broadcasts to everyone but the sender.

The renderer holds one Zustand store (`src/renderer/src/store.ts`). Agent
status, approvals and mail events all land there; the UI is a pure function of
it.

## SECURITY — read before running unattended

Agents in this harness run with permission prompts suppressed. That is the only
way a floor of them works unattended, and it means **every agent has your shell**.

Bullpen's mitigation is a `PreToolUse` hook, not a sandbox:

- `src/main/approvals.ts` runs a loopback-only HTTP server with a per-run token.
- Every tool call is classified: `allow` silently, `ask` a human, or `deny` outright.
- `deny` is reserved for an agent touching Bullpen's own hook or settings — an
  agent disarming its own leash is never a question worth asking at 3am.
- Destructive shell (`rm -rf`, force push, `sudo`, `curl | sh`, publish), credential
  paths (`.ssh`, `.aws`, `.env`, `id_rsa`), and writes outside the agent's working
  directory all escalate to the approvals panel.

**The hook fails closed.** Claude Code treats a timed-out or erroring hook as
non-blocking, so an unreachable Bullpen would otherwise mean "allow everything".
The generated `hook.mjs` denies on every failure path instead — no server, no
network, bad response, crash: all deny with exit code 2.

**Bullpen auto-answers one dialog.** Claude Code asks an interactive "do you
trust this folder?" question the first time it runs in an unknown directory, and
an agent will sit on it forever. Bullpen answers it, because the human already
designated that exact directory as the sandbox in the add-agent wizard. The
guards in `src/main/trust.ts` keep that narrow:

- only the workspace-trust prompt, matched by its own wording
- only when the prompt names **this agent's own sandbox** — a prompt for any
  other directory is left unanswered
- once per agent, and only within 120s of spawn
- logged to stdout and to the Activity tab, never silent

Nothing else is auto-confirmed. Approvals still stop at a human.

What this does **not** protect against:

- A determined agent finding a destructive command none of the patterns match.
  Pattern matching is a speed bump, not containment.
- Anything an allowed command does after it starts running.
- Prompt injection from web pages or repo content the agent reads.

Give agents a scratch directory, not `$HOME`. For real isolation, run the whole
app in a VM or container.

## Updating

A packaged app checks GitHub Releases 8 seconds after launch and every six hours
after that. A newer version shows up as a button in the title bar: press it to
download, press it again to restart into it. Nothing downloads or installs
without being asked.

macOS needs the app to be signed with a Developer ID before it can replace
itself - Squirrel refuses a build it cannot read a signature from - so an
unsigned build offers the releases page instead. Windows updates in place,
signed or not.

Publishing a version is a tag. `npm version` writes `package.json` and the
matching tag together, and pushing the tag is the whole release:

```bash
npm version patch        # or minor / major
git push --follow-tags
```

`.github/workflows/release.yml` then packs macOS on a macOS runner and Windows
on a Windows runner - node-pty is native, so neither cross-builds - and both
upload into one **draft** release. Look at it, then press Publish: a draft is
invisible to `electron-updater`, so nothing updates until you say so.

The workflow refuses a tag that does not match `package.json`. electron-builder
publishes to `v${version}` regardless of which tag started the run, so without
that check the artifacts land on a release nobody tagged.

CI builds are unsigned - there is no Developer ID in the runner - which is the
`manual` update path above. To build and upload from this machine instead:

```bash
GH_TOKEN=... npm run release   # builds mac + win, uploads to GitHub Releases
```

## Layout

```
src/main/hive.ts        file mailbox + router  (pure Node, tested)
src/main/approvals.ts   hook server + classifier (pure Node, tested)
src/main/pty.ts         node-pty per agent
src/main/index.ts       Electron entry, IPC wiring
src/preload/index.ts    the renderer's entire capability surface
src/renderer/src/       store, terminal, panels
test/                   node --test, no framework
```

`hive.ts` and `approvals.ts` import nothing from Electron, which is why the
tests run with `node --experimental-strip-types` and no build.

## Deliberately not built yet

Office floor, semantic memory, knowledge graph, Monaco IDE, kanban, Slack,
multi-provider support, cost tracking. See `OPEN-QUESTIONS.md`.

## License

MIT. No third-party art is bundled — if you add a tileset, check its license
before shipping anything commercial.
