/**
 * The models an agent can be started on, and how that reaches the CLI.
 *
 * There is no model field on an agent: the CLI takes a `--model` flag and
 * Bullpen passes the extra arguments through verbatim, so the arguments *are*
 * the model. Picking one rewrites that one flag and leaves anything else
 * somebody typed alone - which is why these are string operations rather than
 * a second place the model is stored and kept in step.
 *
 * Which models exist is the engine's answer, not this file's - see
 * `engines.ts`. A list of Claude models under a `codex` agent is a list of
 * things that agent cannot run.
 */

export type Model = {
  /** What goes after the flag. */
  id: string
  label: string
  /** The one line under the name. Context window, what it is for. */
  note: string
  /**
   * What this model calls itself in the CLI's startup box, when that is not
   * the label.
   *
   * Only needed where the two disagree: Bullpen writes `Opus 5 · 1M` because a
   * menu has one line to say it in, and the CLI writes `Opus 5 (1M context)`.
   * Without this the banner read matches the shorter `Opus 5` and ticks the
   * wrong row - the same model, but not the same context window, and not the
   * same bill.
   */
  banner?: string
  /**
   * Shown without asking. Everything else is behind `more`.
   *
   * Nine chips is not a choice, it is a table - and the answer almost always
   * wanted is one of three words. The rest are for pinning a version, which is
   * a thing somebody goes looking for rather than picks in passing.
   */
  common?: boolean
}

/**
 * Claude Code's models.
 *
 * Versions only. The bare aliases - `opus`, `sonnet`, `haiku` - were here too
 * and were taken out: an alias moves when the CLI moves, so two runs a month
 * apart on "opus" are two different models and nothing on screen says so. They
 * still work if typed; they are just not offered.
 */
export const CLAUDE_MODELS: Model[] = [
  { id: 'claude-opus-5', label: 'Opus 5', note: 'the default here', common: true },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'cheaper than Opus, 1M context', common: true },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: '200K context - cheapest, fastest', common: true },
  {
    id: 'claude-opus-5[1m]',
    label: 'Opus 5 · 1M',
    note: 'Opus 5 with the 1M context window',
    banner: 'Opus 5 (1M context)'
  },
  { id: 'claude-fable-5', label: 'Fable 5', note: 'most capable, and priced above Opus' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', note: 'the one before Opus 5' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', note: '' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', note: '' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', note: '' }
]

/**
 * Codex's models, from OpenAI's own list.
 *
 * Versions only, same as above. `gpt-5.4` and `gpt-5.4-mini` are on that list
 * and are deliberately not here: they retire from Codex on 2026-08-31, and a
 * chip that stops starting an agent next week is a chip that fails at spawn -
 * which is the thing an empty list was preferred over in the first place.
 */
/**
 * The nicest name we have for a model id read back off a transcript.
 *
 * What the CLI reports is the id it actually ran, dated build and all -
 * `claude-opus-5-20260114` - and none of the ids here carry that suffix. So an
 * exact match first, then the longest id this one starts with, and the raw
 * string when it is a model Bullpen ships no name for. Never a guess dressed
 * up as a name: an unknown id shown as itself is readable, an id mapped to the
 * wrong label is a lie about what somebody is paying for.
 */
export const matchModel = (id: string, list: Model[]): Model | undefined =>
  list.find((m) => m.id === id) ??
  list.filter((m) => id.startsWith(m.id)).sort((x, y) => y.id.length - x.id.length)[0]

/** The same match, as something to print: the shipped name, else the id itself. */
export const labelForModel = (id: string, list: Model[]): string =>
  matchModel(id, list)?.label ?? id

export const CODEX_MODELS: Model[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 sol', note: 'the flagship, and what Codex uses by default', common: true },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 terra', note: 'the balanced everyday one', common: true },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 luna', note: 'fast and cheap', common: true },
  { id: 'gpt-5.5', label: 'GPT-5.5', note: 'the previous frontier model' },
  {
    id: 'gpt-5.3-codex-spark',
    label: 'Codex Spark',
    note: 'near-instant iteration, text only - a research preview'
  }
]

/** The flag every CLI here spells the same way. Kept a field so one need not. */
export const MODEL_FLAG = '--model'

/**
 * Which model a line of extra arguments asks for, if it asks for one.
 *
 * Both spellings, because both are what people type and the CLI takes either.
 * Anything not on any list still comes back - a model released after this file
 * was written is a model somebody can type, and showing it as "none" would be
 * Bullpen claiming an argument it can see is not there.
 */
export function modelOf(args: string, flag = MODEL_FLAG): string | null {
  const re = new RegExp(`(?:^|\\s)${escape(flag)}[\\s=]+("[^"]+"|'[^']+'|\\S+)`)
  const found = re.exec(args)
  if (!found) return null
  return found[1].replace(/^["']|["']$/g, '') || null
}

/**
 * The same line with the flag set to this model, or taken out for `null`.
 *
 * Rewritten in place rather than appended: picking three models in a row used
 * to leave three `--model` flags on the line, and the CLI takes the last one -
 * so what ran was right and what was written was nonsense.
 */
export function withModel(args: string, id: string | null, flag = MODEL_FLAG): string {
  const re = new RegExp(`(?:^|\\s)${escape(flag)}[\\s=]+(?:"[^"]+"|'[^']+'|\\S+)`, 'g')
  const without = args.replace(re, ' ').replace(/\s+/g, ' ').trim()
  if (!id) return without
  // The flag first: it is the part anybody reads, and burying it behind three
  // other arguments is how it stops being read.
  return without ? `${flag} ${id} ${without}` : `${flag} ${id}`
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
