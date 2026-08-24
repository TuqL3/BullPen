/**
 * The CLIs an agent can run, and what Bullpen can and cannot do to each.
 *
 * A floor was never meant to be one CLI - `RoleDef.cli` has said so since it
 * was written, and its own example is `codex`. What pinned it to one was this:
 * `--append-system-prompt` and `--settings` were appended to every spawn, both
 * of them `claude`'s own flags, so anything else was handed two arguments it
 * did not know and refused to start.
 *
 * The fix is not a flag and not an environment variable - a briefing nobody can
 * see is a briefing nobody can fix. Every CLI already reads a file out of the
 * directory it is started in, so that is where the brief goes: a real file, in
 * the agent's own workspace, under the name that CLI already looks for.
 */
import { CLAUDE_MODELS, CODEX_MODELS, MODEL_FLAG, modelOf, withModel, type Model } from './models.ts'

export type Engine = {
  /** The command, as typed. */
  cmd: string
  label: string
  /**
   * The file this CLI reads out of its working directory on its own.
   *
   * Written there at spawn when it is absent, and never overwritten: once it is
   * on disk it is the operator's, and rewriting an edited brief on every
   * restart is Bullpen quietly undoing somebody's work.
   */
  briefFile: string
  /**
   * Whether Bullpen's approvals layer reaches it.
   *
   * `claude` takes a `--settings` file naming a `PreToolUse` hook, which is the
   * whole of how a tool call is held open for a human. No other CLI here has an
   * equivalent, so their tool calls are not checked by anything - which is a
   * thing to say on screen, not a footnote.
   */
  supervised: boolean
  /** One line on what is given up, or empty when nothing is. */
  caveat: string
  /**
   * The models this CLI can be started on, and the flag that names one.
   *
   * Per engine, because a list of Claude models under a `codex` agent is a list
   * of things that agent cannot run - it was one list for everything, and
   * picking `opus` on a codex agent wrote an argument that only ever produced
   * an error at startup.
   *
   * Empty means Bullpen ships no list for this one. The flag still works and
   * the model can still be typed; what is not shipped is a guess at which
   * names are valid, which is worse than nothing when it is wrong.
   */
  models: Model[]
  modelFlag: string
  /**
   * Shown on the chip, for one Bullpen does not stand behind yet.
   *
   * Not the same claim as `supervised`: that says which of Bullpen's own
   * machinery reaches the CLI, and this says how much of it has been run in
   * anger. The caveat is a sentence you read once the chip is pressed; the
   * badge is what is legible before pressing it.
   */
  beta?: boolean
}

export const ENGINES: Engine[] = [
  {
    cmd: 'claude',
    label: 'Claude Code',
    briefFile: 'CLAUDE.md',
    supervised: true,
    caveat: '',
    models: CLAUDE_MODELS,
    modelFlag: MODEL_FLAG
  },
  {
    cmd: 'codex',
    label: 'Codex',
    briefFile: 'AGENTS.md',
    supervised: false,
    beta: true,
    caveat:
      'No approval hook: its tool calls run without being held for you. No context meter, no cost, and Bullpen cannot clean it up if the app crashes.',
    models: CODEX_MODELS,
    modelFlag: MODEL_FLAG
  }
]

/** `AGENTS.md` is what a CLI with no entry here is most likely to read. */
const UNKNOWN: Omit<Engine, 'cmd' | 'label'> = {
  briefFile: 'AGENTS.md',
  supervised: false,
  caveat:
    'Bullpen knows nothing about this one. The brief is written to AGENTS.md in its workspace and may not be read at all; nothing checks its tool calls.',
  models: [],
  modelFlag: MODEL_FLAG
}

/**
 * What Bullpen knows about the CLI in this command line.
 *
 * Takes the whole `cli` string a role may carry - `claude --model sonnet` - and
 * matches on the command alone, because the flags after it are the operator's
 * business and not an identity.
 */
export function engineFor(cli: string | undefined): Engine {
  const cmd = (cli ?? '').trim().split(/\s+/)[0] ?? ''
  // The path a CLI was installed at is not its name: `/opt/homebrew/bin/codex`
  // is codex, and matching the whole string called it unknown.
  const base = cmd.split(/[\\/]/).pop() ?? cmd
  const known = ENGINES.find((e) => e.cmd === base)
  if (known) return known
  return { ...UNKNOWN, cmd: base || 'claude', label: base || 'claude' }
}

/**
 * The arguments Bullpen adds to a spawn, on top of whatever was asked for.
 *
 * Only `claude` gets them. Everything else gets none: the two flags below are
 * `claude`'s, and handing them to another CLI is how a floor that says it can
 * run `codex` starts nothing at all.
 */
export function engineArgs(engine: Engine, brief: string, settingsPath: string): string[] {
  if (!engine.supervised) return []
  return ['--append-system-prompt', brief, '--settings', settingsPath]
}

/**
 * The same arguments, moved from one engine to another.
 *
 * A model belongs to the engine that has it. Switching used to leave
 * `--model claude-opus-5` on a codex agent: an argument that only ever produces
 * an error at startup, sitting under a chip row offering nothing like it and a
 * chip saying nothing is selected. Kept when the new engine has that model too,
 * dropped when it does not - and everything else on the line is the operator's
 * and is not touched either way.
 */
export function retune(args: string, from: Engine, to: Engine): string {
  const want = modelOf(args, to.modelFlag)
  if (want && to.models.some((m) => m.id === want)) return args
  return withModel(args, null, from.modelFlag)
}
