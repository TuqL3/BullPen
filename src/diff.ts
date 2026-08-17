/**
 * A unified diff, turned into something a review panel can draw.
 *
 * `git diff` output is a stream of text with three different kinds of line in
 * it - plumbing headers, hunk markers, and content - and the plumbing is noise
 * to a person reading a change. Parsing it here means the panel renders rows
 * with line numbers instead of printing the raw text and colouring by prefix.
 */

export type DiffLine = {
  kind: 'add' | 'del' | 'ctx'
  /** Line number in the file before the change; absent on added lines. */
  old?: number
  /** Line number after the change; absent on deleted lines. */
  new?: number
  text: string
}

export type Hunk = {
  /**
   * The `@@ -a,b +c,d @@` line verbatim.
   *
   * Sent back when discarding this hunk alone: main re-reads the diff and
   * refuses if the hunk at that index no longer starts with the same marker,
   * which is what stops a stale panel from reverting the wrong part of a file.
   */
  marker: string
  /** What git prints after the `@@`s - usually the enclosing function. */
  context: string
  /** How many unchanged lines were skipped to get here, if it is known. */
  skipped: number
  lines: DiffLine[]
}

export type ParsedDiff = {
  hunks: Hunk[]
  adds: number
  dels: number
}

/** Plumbing git prints around the actual change. None of it is worth a row. */
const NOISE =
  /^(diff --git |index |--- |\+\+\+ |old mode |new mode |new file mode |deleted file mode |similarity index |rename |copy |Binary files |GIT binary patch)/

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

export function parseDiff(text: string): ParsedDiff {
  const hunks: Hunk[] = []
  let adds = 0
  let dels = 0
  let hunk: Hunk | null = null
  let oldNo = 0
  let newNo = 0
  /** Where the previous hunk stopped, so the gap between them can be counted. */
  let prevEnd = 1

  for (const raw of text.split('\n')) {
    const m = HUNK.exec(raw)
    if (m) {
      oldNo = Number(m[1])
      newNo = Number(m[3])
      hunk = {
        marker: raw.slice(0, raw.indexOf('@@', 2) + 2),
        context: m[5].trim(),
        skipped: Math.max(0, oldNo - prevEnd),
        lines: []
      }
      hunks.push(hunk)
      prevEnd = oldNo + Number(m[2] ?? 1)
      continue
    }
    if (!hunk || NOISE.test(raw)) continue
    // "\ No newline at end of file" annotates the line above; it is not one.
    if (raw.startsWith('\\')) continue

    if (raw.startsWith('+')) {
      hunk.lines.push({ kind: 'add', new: newNo++, text: raw.slice(1) })
      adds++
    } else if (raw.startsWith('-')) {
      hunk.lines.push({ kind: 'del', old: oldNo++, text: raw.slice(1) })
      dels++
    } else {
      // A context line starts with a space; git also emits a bare empty line
      // for an empty context line, which is the same thing with the space eaten.
      hunk.lines.push({ kind: 'ctx', old: oldNo++, new: newNo++, text: raw.replace(/^ /, '') })
    }
  }

  // A trailing empty context line is the split on the final newline, not a line.
  const last = hunks.at(-1)
  const tail = last?.lines.at(-1)
  if (last && tail && tail.kind === 'ctx' && tail.text === '') last.lines.pop()

  return { hunks, adds, dels }
}

/**
 * One run of changed lines with no unchanged line in between.
 *
 * Git groups changes into hunks by proximity - anything less than six lines
 * apart shares a hunk - so "revert this hunk" often means "revert most of the
 * file". A block is what a person points at: the lines that touch each other.
 */
export type Block = { hunk: number; start: number; end: number; lines: number }

export function blocks(diff: ParsedDiff): Block[] {
  const out: Block[] = []
  diff.hunks.forEach((h, hi) => {
    let start = -1
    h.lines.forEach((l, i) => {
      if (l.kind === 'ctx') {
        if (start !== -1) out.push({ hunk: hi, start, end: i - 1, lines: i - start })
        start = -1
      } else if (start === -1) {
        start = i
      }
    })
    if (start !== -1) {
      out.push({ hunk: hi, start, end: h.lines.length - 1, lines: h.lines.length - start })
    }
  })
  return out
}

/** How many lines of unchanged context a rebuilt patch carries either side. */
const PAD = 3

/**
 * A patch that undoes one block, and nothing else.
 *
 * Built against the file as it is now and applied forwards, rather than
 * reversing git's own patch: reversing needs every other change in the hunk to
 * be described too, and getting that wrong reverts work nobody asked about.
 * Here the block's added lines become deletions, its deleted lines become
 * additions, and every other line in range - including changes belonging to
 * other blocks - is context, because that is what the file already contains.
 *
 * Returns null when the block cannot be addressed: nothing to do beats a patch
 * built on a guess.
 */
export function blockPatch(diff: ParsedDiff, block: Block, path: string): string | null {
  const hunk = diff.hunks[block.hunk]
  if (!hunk) return null

  const from = Math.max(0, block.start - PAD)
  const to = Math.min(hunk.lines.length - 1, block.end + PAD)

  const body: string[] = []
  let first = 0
  let oldCount = 0
  let newCount = 0

  for (let i = from; i <= to; i++) {
    const l = hunk.lines[i]
    const inBlock = i >= block.start && i <= block.end

    if (!inBlock) {
      // A deleted line outside the block is not in the file, so it cannot be
      // context; an added one is, and counts on both sides.
      if (l.kind === 'del') continue
      if (!first && l.new) first = l.new
      body.push(` ${l.text}`)
      oldCount++
      newCount++
      continue
    }

    if (l.kind === 'add') {
      if (!first && l.new) first = l.new
      body.push(`-${l.text}`)
      oldCount++
    } else {
      body.push(`+${l.text}`)
      newCount++
    }
  }

  if (!body.some((l) => l[0] !== ' ')) return null
  // Every line in range was an addition with no context before it: the block
  // starts at the first line the hunk touches.
  if (!first) first = hunk.lines[from]?.new ?? 1

  return (
    `--- a/${path}\n+++ b/${path}\n` +
    `@@ -${first},${oldCount} +${first},${newCount} @@\n` +
    body.join('\n') +
    '\n'
  )
}
