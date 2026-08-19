import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Reading and writing files inside one agent's workspace.
 *
 * Every path arrives from the renderer, so every path is untrusted: the panel
 * may only reach inside the sandbox that agent was hired for. `..`, absolute
 * paths and symlink escapes all resolve to the same check.
 */

/**
 * Directories nobody opens a code panel to read, and that make listing slow.
 *
 * Dotfiles themselves are listed: `.env`, `.gitignore` and `.claude/` are files
 * people edit, and the review panel shows changes to them, so a tree that hid
 * them could not open what the review was pointing at. Only the directories
 * below are dropped, and each is either machinery or generated output.
 */
const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  'target',
  '__pycache__',
  '.venv',
  '.cache',
  '.turbo'
])

/** Above this a file is not source, and shipping it to the renderer stalls it. */
export const MAX_BYTES = 1_000_000

export type Entry = { name: string; path: string; dir: boolean; size: number }

/** Resolve `rel` inside `root`, or throw. The only way paths become absolute. */
export function inside(root: string, rel: string): string {
  const base = resolve(root)
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(base, rel)
  const r = relative(base, abs)
  if (r.startsWith('..') || isAbsolute(r)) throw new Error(`${rel} is outside the workspace`)
  return abs
}

/** One directory level. Shallow on purpose: a deep walk of a large repo blocks. */
export function list(root: string, rel = ''): Entry[] {
  const dir = inside(root, rel)
  const out: Entry[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && SKIP.has(e.name)) continue
    let size = 0
    // A broken symlink or a file deleted mid-listing must not kill the listing.
    try {
      if (e.isFile()) size = statSync(join(dir, e.name)).size
    } catch {
      continue
    }
    out.push({
      name: e.name,
      path: relative(resolve(root), join(dir, e.name)).split(sep).join('/'),
      dir: e.isDirectory(),
      size
    })
  }
  return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
}

export type Hit = {
  path: string
  line: number
  text: string
  /** Where the query matched inside `text`, so the panel can highlight it. */
  ranges: [number, number][]
}
/** Every file that matched, with how many times - even past the row cap. */
export type FileHits = { path: string; count: number }

export type SearchResult = {
  /** The first `MAX_HITS` matches, for rendering. */
  hits: Hit[]
  /** Every matching file, so the list is complete even when the rows are not. */
  matched: FileHits[]
  /** Every match found, not just the ones returned. */
  total: number
  /** Files containing at least one match. */
  files: number
  scanned: number
  /** True when there are more matches than `hits` carries. */
  capped: boolean
  /** True when the walk hit its time budget and stopped early. */
  timedOut: boolean
  /** Set when the query itself was the problem - an unfinished regex. */
  error?: string
}

/** How many times the query occurs in one line. Counted, never capped. */
function countIn(text: string, needle: string, re: RegExp | null, caseSensitive?: boolean): number {
  if (re) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    let n = 0
    for (const m of text.matchAll(g)) {
      if (!m[0].length) break
      n++
    }
    return n
  }
  const hay = caseSensitive ? text : text.toLowerCase()
  let n = 0
  let at = hay.indexOf(needle)
  while (at !== -1) {
    n++
    at = hay.indexOf(needle, at + needle.length)
  }
  return n
}

/** At most this many highlights per line: a line of 200 hits is a minified one. */
const MAX_MARKS = 20

/**
 * Where the query sits inside one line.
 *
 * Computed here rather than in the panel: the matcher is here, and a second
 * implementation of "what counts as a match" in the renderer would drift from
 * this one the first time either changed.
 */
function marks(
  text: string,
  needle: string,
  re: RegExp | null,
  opts: { caseSensitive?: boolean }
): [number, number][] {
  const out: [number, number][] = []
  if (re) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    for (const m of text.matchAll(g)) {
      if (m.index === undefined) continue
      // A pattern that can match nothing would loop on the same index forever.
      if (m[0].length === 0) break
      out.push([m.index, m.index + m[0].length])
      if (out.length >= MAX_MARKS) break
    }
    return out
  }
  const hay = opts.caseSensitive ? text : text.toLowerCase()
  let at = hay.indexOf(needle)
  while (at !== -1 && out.length < MAX_MARKS) {
    out.push([at, at + needle.length])
    at = hay.indexOf(needle, at + needle.length)
  }
  return out
}

/**
 * How many matches are handed to the renderer.
 *
 * Counting does not stop here - the panel reports every match it found, the way
 * an editor does. Stopping the whole walk at the first few hundred made the
 * count wrong as well as the list short: "400 results" on a workspace with
 * fifteen thousand of them is not a truncated answer, it is a wrong one.
 */
const MAX_HITS = 1000

/**
 * A wall clock, not a file count, is the honest bound on a walk.
 *
 * A repo with 40k small files and one with 4k large ones cost nothing alike,
 * and a limit in files stops early on the first and late on the second.
 */
const TIME_BUDGET_MS = 4000
/** A matched line is shown, not read in full; a minified bundle is one line. */
const MAX_LINE = 300

/**
 * The largest file search will read.
 *
 * Far above MAX_BYTES, which is the editor's limit: opening a 6 MB lock file in
 * CodeMirror is a stall, but grepping one is a scan of 6 MB. Reusing the
 * editor's cap here quietly dropped every lock file and bundle from the
 * results - two thirds of the matches in a real workspace.
 */
const SEARCH_MAX_BYTES = 16 * 1024 * 1024

/**
 * Plain text search across one agent's workspace.
 *
 * Written here rather than shelling out to ripgrep or `git grep`: neither is
 * guaranteed present, `git grep` misses everything untracked - which is most of
 * what an agent has just written - and the walk is the same one the file tree
 * already does. Bounded on every axis, because the alternative to a cap is a
 * frozen window on the first search of a monorepo.
 */
export function search(
  root: string,
  query: string,
  opts: { caseSensitive?: boolean; regex?: boolean; only?: string[] } = {}
): SearchResult {
  let re: RegExp | null = null
  if (opts.regex) {
    try {
      re = new RegExp(query, opts.caseSensitive ? '' : 'i')
    } catch (err) {
      // A half-typed pattern is the normal state of a regex box; saying so beats
      // an empty result that looks like "nothing matches".
      return {
        hits: [],
        matched: [],
        total: 0,
        files: 0,
        scanned: 0,
        capped: false,
        timedOut: false,
        error: String(err)
      }
    }
  }
  const needle = opts.caseSensitive ? query : query.toLowerCase()
  const hits: Hit[] = []
  const seen = new Map<string, number>()
  let scanned = 0
  let total = 0
  let timedOut = false
  const until = Date.now() + TIME_BUDGET_MS
  if (!needle.trim()) {
    return { hits, matched: [], total: 0, files: 0, scanned: 0, capped: false, timedOut: false }
  }

  const base = resolve(root)

  /**
   * The files git would list: tracked, plus untracked that are not ignored.
   *
   * Without this the walk searched build output, vendored code and editor
   * caches - everything `.gitignore` exists to keep out of a search. It found
   * matches in four thousand files where an editor finds them in eight hundred,
   * which reads as a broken search rather than a wider one.
   */
  const tracked = (): string[] | null => {
    try {
      const out = execFileSync(
        'git',
        ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        { cwd: base, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
      )
      const list = out.split('\0').filter(Boolean)
      return list.length ? list : null
    } catch {
      return null
    }
  }

  const scan = (abs: string, rel: string): void => {
    if (timedOut) return
    // Checked per file rather than per line: Date.now() on every line of a
    // large repo is itself a cost.
    if (Date.now() > until) {
      timedOut = true
      return
    }
    scanned++
    let buf: Buffer
    try {
      if (statSync(abs).size > SEARCH_MAX_BYTES) return
      buf = readFileSync(abs)
    } catch {
      return
    }
    // The same NUL test the reader uses: searching a PNG finds nothing and
    // costs the whole file.
    if (buf.subarray(0, 8000).includes(0)) return
    const text = buf.toString('utf8')
    const hay = opts.caseSensitive ? text : text.toLowerCase()
    // Cheap whole-file reject first: most files match nothing, and scanning
    // them line by line to find that out is the slow way round.
    if (re ? !re.test(text) : !hay.includes(needle)) return

    const lines = text.split('\n')
    const hayLines = opts.caseSensitive ? lines : lines.map((l) => l.toLowerCase())
    for (let i = 0; i < lines.length; i++) {
      if (re ? !re.test(lines[i]) : !hayLines[i].includes(needle)) continue
      const n = countIn(lines[i], needle, re, opts.caseSensitive)
      seen.set(rel, (seen.get(rel) ?? 0) + n)
      total += n
      // Past the cap the walk carries on counting; only the rows stop.
      if (hits.length < MAX_HITS) {
        const shown = lines[i].slice(0, MAX_LINE)
        hits.push({ path: rel, line: i + 1, text: shown, ranges: marks(shown, needle, re, opts) })
      }
    }
  }

  const walk = (dir: string): void => {
    if (timedOut) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (timedOut) return
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(abs)
        continue
      }
      if (!e.isFile()) continue
      scan(abs, relative(base, abs).split(sep).join('/'))
    }
  }
  // `only` is one file's worth of rows, fetched when a file past the row cap is
  // opened: the same matcher, so the lines cannot disagree with the count.
  const list = opts.only ?? tracked()
  if (list) {
    for (const rel of list) {
      if (timedOut) break
      if (rel.split('/').some((part) => SKIP.has(part))) continue
      scan(join(base, rel), rel)
    }
  } else {
    walk(base)
  }
  return {
    hits,
    // Every file, in the order they were found: the rows stop at the cap, the
    // list of files does not. A search that shows 40 of 814 files while saying
    // "814 files" is asking to be misread.
    matched: [...seen].map(([path, count]) => ({ path, count })),
    total,
    files: seen.size,
    scanned,
    capped: total > hits.length,
    timedOut
  }
}

export type FileRead = { path: string; text: string; truncated: boolean; binary: boolean }

export function read(root: string, rel: string): FileRead {
  const abs = inside(root, rel)
  const size = statSync(abs).size
  const buf = readFileSync(abs).subarray(0, MAX_BYTES)
  // A NUL byte in the first block is the cheap, reliable binary test; rendering
  // a PNG as text locks the editor up for a second and shows nothing useful.
  const binary = buf.subarray(0, 8000).includes(0)
  return {
    path: rel,
    text: binary ? '' : buf.toString('utf8'),
    truncated: size > MAX_BYTES,
    binary
  }
}

/**
 * Writing is what makes the panel an editor rather than a viewer, and it is the
 * one operation here that can lose work - so it refuses the cases where it
 * would be writing something other than what was opened.
 */
export function write(root: string, rel: string, text: string): void {
  const abs = inside(root, rel)
  // Only when there is something there. `statSync` on a path that does not
  // exist throws, so writing refused to create a file at all - and the memory
  // panel's own "give this agent one" button answered ENOENT, because an agent
  // with no CLAUDE.md is exactly the case that button exists for.
  if (existsSync(abs) && statSync(abs).isDirectory()) throw new Error(`${rel} is a directory`)
  writeFileSync(abs, text, 'utf8')
}
