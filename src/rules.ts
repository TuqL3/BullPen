/**
 * The rules, read as rules rather than as a description of them.
 *
 * `workflow-format.md` was a document: prose that told a person - and the model
 * that writes workflows - what the format allows. It was accurate because a
 * test kept it accurate, which is a way of saying the real rules were somewhere
 * else, in a parser and a linter, and the document was a copy that had to be
 * chased.
 *
 * `rules.md` is the rules. What entities exist, what may be written about each
 * one, what type each field is, and which checks run. Everything else reads it:
 * the parser to know what a line means, the linter to know what to enforce, and
 * the settings dialog to know what boxes to draw.
 *
 * The boundary, stated once so nothing pretends otherwise: this file decides
 * *shape and constraint*. It does not decide *behaviour*. `opens` means a card
 * is opened because the router says so; the rules can choose whether a floor
 * may say `opens`, and what to call it, and never what opening means.
 */

/** What a field may hold, parsed out of the `type` column. */
export type FieldType =
  | { kind: 'text' | 'sentence' | 'prose' | 'percent' | 'colour' | 'path' | 'agent' | 'flag' }
  /** A name declared elsewhere in the rules: `role`, `capability`, `column`. */
  | { kind: 'ref'; to: string[] }
  /** Exactly one of these words. */
  | { kind: 'oneOf'; of: string[] }
  /** Several of the inner type, comma separated. */
  | { kind: 'list'; of: FieldType }

export type Field = {
  name: string
  type: FieldType
  required: boolean
  unique: boolean
  /** A pattern the value must match, as written in the rules. */
  match?: string
  /** What it is when the floor does not say. */
  fallback?: string
  /** Set on the `«your own»` line: anything not named above lands here. */
  open?: boolean
  /** The words after the type, for whoever is reading rather than checking. */
  what: string
}

export type Entity = { name: string; what: string; fields: Field[] }
export type Law = { id: string; says: string }
export type Rules = { entities: Entity[]; laws: Law[]; text: string }

const REF_KINDS = ['role', 'capability', 'column', 'address', 'agent']

/**
 * `list of role or address`, `one of start, working`, `text`.
 *
 * Written the way somebody would say it out loud, because the rules are read by
 * people at least as often as by this function.
 */
export function readType(said: string): FieldType {
  const s = said.trim().toLowerCase()
  const list = /^list of (.+)$/.exec(s)
  if (list) return { kind: 'list', of: readType(list[1]) }

  // `or` is read before `one of`, because `one of opens, closes or column` is a
  // list of two words *or* the name of a column - and splitting on the comma
  // first swallowed the `or` into the last word.
  const parts = s.split(/\s+or\s+/).map((x) => x.trim())
  if (parts.length === 1) {
    const oneOf = /^one of (.+)$/.exec(s)
    if (oneOf) {
      return { kind: 'oneOf', of: oneOf[1].split(',').map((x) => x.trim()).filter(Boolean) }
    }
  }
  if (parts.length > 1) {
    // `then · one of opens, closes · or column` reads as either.
    const words = parts.filter((p) => !REF_KINDS.includes(p) && !p.startsWith('one of'))
    const refs = parts.filter((p) => REF_KINDS.includes(p))
    const nested = parts.find((p) => p.startsWith('one of'))
    const from = nested ? (readType(nested) as { of: string[] }).of : []
    if (refs.length && !words.length && !from.length) return { kind: 'ref', to: refs }
    return { kind: 'oneOf', of: [...from, ...words, ...refs] }
  }
  if (REF_KINDS.includes(s) && s !== 'agent') return { kind: 'ref', to: [s] }
  if (s === 'flag') return { kind: 'flag' }
  if (['text', 'sentence', 'prose', 'percent', 'colour', 'path', 'agent'].includes(s)) {
    return { kind: s as 'text' }
  }
  // Anything the rules invent and this does not know is text: a rule nobody can
  // write is worse than a rule checked loosely.
  return { kind: 'text' }
}

const BLANK = /^«[^»]*»$/

/**
 * Read the rules. Never throws: a rules file that will not parse is a floor
 * nobody can open, and the caller gets an empty set to say so.
 */
export function readRules(text: string): Rules {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const entities: Entity[] = []
  const laws: Law[] = []

  let entity: Entity | null = null
  let inLaw = false

  for (const line of lines) {
    const head = /^##\s+(.+)$/.exec(line)
    if (head) {
      const title = head[1].trim()
      const named = /^entity:\s*(.+)$/i.exec(title)
      inLaw = /^law\b/i.test(title)
      entity = null
      if (named) {
        entity = { name: named[1].trim(), what: '', fields: [] }
        entities.push(entity)
      }
      continue
    }

    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (!bullet) {
      // The paragraph under a heading is what that entity is for - all of it.
      // Taking only the first line cut every sentence off at the width somebody
      // happened to wrap the file at.
      if (entity && line.trim()) entity.what = entity.what ? `${entity.what} ${line.trim()}` : line.trim()
      continue
    }

    if (inLaw) {
      const law = /^`([\w-]+)`\s*[—–-]\s*(.+)$/.exec(bullet[1])
      if (law) laws.push({ id: law[1], says: law[2].trim() })
      continue
    }
    if (!entity) continue

    // `name · type · flags…`
    const cells = bullet[1].split('·').map((c) => c.trim())
    if (cells.length < 2) continue
    const [name, said, ...flags] = cells
    const rest = flags.join(' · ')
    const fallback = /default\s+(.+?)(?:\s*·|$)/i.exec(rest)?.[1]
    const match = /match\s+(\S+)/i.exec(rest)?.[1]

    entity.fields.push({
      name: name.replace(/^`|`$/g, ''),
      type: readType(said),
      required: /\brequired\b/i.test(rest),
      unique: /\bunique\b/i.test(rest),
      ...(match ? { match } : {}),
      ...(fallback ? { fallback: fallback.trim() } : {}),
      ...(BLANK.test(name) ? { open: true } : {}),
      // Whatever is left after the flags this understands. `match` and
      // `default` come out too: they are read into fields of their own, and
      // leaving them here as well wrote them twice on the way back out.
      what: flags
        .filter((f) => !/^(required|unique)$/i.test(f))
        .filter((f) => !/^match\s/i.test(f) && !/^default\s/i.test(f))
        .join(' · ')
    })
  }
  return { entities, laws, text }
}

/** Whether a law is switched on. Removing its line from the rules turns it off. */
export const lawOn = (rules: Rules, id: string): boolean => rules.laws.some((l) => l.id === id)
