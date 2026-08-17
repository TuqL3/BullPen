import { Fragment, useEffect, useRef, useState } from 'react'
import { EditorState, Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { LABEL, MONO } from './theme'
import { blocks, parseDiff, type Block, type ParsedDiff } from '../../diff.ts'
import type { Agent } from './store'
import type { CodeEntry, GitChanges, Hit, SearchResult } from '../../preload/index'

export type OpenFile = {
  agentId: string
  root: string
  path: string
  /** Line to jump to, when the file was opened from a search hit. */
  line?: number
  text: string
  truncated: boolean
  binary: boolean
  /** Unified diff against HEAD, when the workspace is a git repository. */
  diff?: string
}

/**
 * Ask main for a file, in the form the editor panel wants it.
 *
 * Lives here rather than in either panel because the tree opens files and the
 * editor displays them, and they are separate panels the operator can put in
 * different columns.
 */
export async function openFile(
  agent: Agent,
  path: string,
  line?: number
): Promise<OpenFile | string> {
  // Both at once: the panel offers file and diff side by side, and fetching the
  // diff only when that tab is clicked makes the first click feel broken.
  const [res, d] = await Promise.all([
    window.bullpen.codeRead(agent.cwd, path),
    window.bullpen.gitDiff(agent.cwd, path)
  ])
  if (res.error) return res.error
  return {
    agentId: agent.id,
    root: agent.cwd,
    path,
    line,
    text: res.text ?? '',
    truncated: !!res.truncated,
    binary: !!res.binary,
    diff: d.error ? undefined : d.text
  }
}

/**
 * What the agent has written lately, and the directory it works in.
 *
 * Two lists because they answer different questions. "Recently touched" comes
 * from the PostToolUse hook, so it is what the agent actually wrote, not what
 * happens to be newest on disk. The tree is for the file you already know.
 */
export function WorkTree({
  agent,
  openPath,
  onOpen
}: {
  agent: Agent | null
  openPath: string | null
  onOpen: (path: string, line?: number) => void
}) {
  // Bumped on every refresh so the tree re-lists: a file an agent just created
  // did not appear until the panel happened to remount.
  const [version, setVersion] = useState(0)
  const [mode, setMode] = useState<'files' | 'search'>('files')
  const bump = (): void => setVersion((v) => v + 1)

  // What changed and what was touched lately both moved to the review panel,
  // where the diff is. Two lists of filenames above a third were three answers
  // to the same question, and the tree is the one that answers "where is it".
  useEffect(bump, [agent?.id, agent?.cwd])
  useEffect(() => {
    return window.bullpen.onEdited((id) => {
      if (id === agent?.id) bump()
    })
  }, [agent?.id])

  // A Bash command, a rebase or an editor outside Bullpen changes files without
  // any hook firing, so the list also refreshes on a slow clock.
  useEffect(() => {
    const t = setInterval(bump, 5000)
    return () => clearInterval(t)
  }, [])

  if (!agent) return <div style={S.empty}>Pick an agent to see what it is working on.</div>

  return (
    <div style={S.tree}>
      {/* Two modes, one panel: the files, or a search across them. An input
          bolted permanently above the tree cost a row of height for a thing
          used a few times an hour. */}
      <div style={S.modes}>
        <button
          style={{ ...S.mode, ...(mode === 'files' ? S.modeOn : null) }}
          title="files"
          aria-label="show files"
          onClick={() => setMode('files')}
        >
          <PanelIcon name="files" />
        </button>
        <button
          style={{ ...S.mode, ...(mode === 'search' ? S.modeOn : null) }}
          title="search this workspace"
          aria-label="show search"
          onClick={() => setMode('search')}
        >
          <PanelIcon name="search" />
        </button>
      </div>
      {/* Both stay mounted, one hidden: switching to the files and back used to
          throw away the query, its results and how far you had scrolled - and
          the search that rebuilt them is a walk of the whole workspace. */}
      <div style={{ ...S.side, display: mode === 'files' ? 'block' : 'none' }}>
        <Tree
          key={agent.id}
          root={agent.cwd}
          version={version}
          onOpen={onOpen}
          openPath={openPath}
        />
      </div>
      <div style={{ ...S.search, display: mode === 'search' ? 'flex' : 'none' }}>
        <Search agent={agent} onOpen={onOpen} openPath={openPath} />
      </div>
    </div>
  )
}

/**
 * A matched line with the query picked out.
 *
 * Ranges come from main, where the matching happened - working out again here
 * what counts as a match is how a highlight ends up on the wrong characters.
 */
function Marked({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (!ranges?.length) return <>{text.trim()}</>
  // Leading whitespace is trimmed for display, so every range shifts with it.
  const cut = text.length - text.trimStart().length
  const out: React.ReactNode[] = []
  let at = 0
  ranges.forEach(([from, to], i) => {
    const a = Math.max(0, from - cut)
    const b = Math.max(0, to - cut)
    const line = text.trim()
    if (a > at) out.push(line.slice(at, a))
    out.push(
      <mark key={i} style={S.mark}>
        {line.slice(a, b)}
      </mark>
    )
    at = b
  })
  out.push(text.trim().slice(at))
  return <>{out}</>
}

/** The two things this panel can be. Drawn, for the reason the title bar is. */
function PanelIcon({ name }: { name: 'files' | 'search' }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  if (name === 'search') {
    return (
      <svg {...common} aria-hidden>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L14 14" />
      </svg>
    )
  }
  return (
    <svg {...common} aria-hidden>
      <path d="M4.5 1.5h5l3 3v10h-8z" />
      <path d="M9.5 1.5v3h3" />
    </svg>
  )
}

/**
 * Text search across the whole workspace, grouped by file.
 *
 * In the tree panel rather than a tab of its own: "where is this" is asked
 * while looking at the files, and the answer is a file to open.
 */
function Search({
  agent,
  onOpen,
  openPath
}: {
  agent: Agent
  onOpen: (path: string, line?: number) => void
  openPath: string | null
}) {
  const [query, setQuery] = useState('')
  const [aa, setAa] = useState(false)
  const [re, setRe] = useState(false)
  const [res, setRes] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [shut, setShut] = useState<string[]>([])

  /**
   * Search while typing, once the typing pauses.
   *
   * A walk of the workspace per keystroke is how a panel starts to stutter, and
   * hitting Enter for every attempt is a keystroke to remember. `seq` is what
   * keeps them honest: a slow search started three characters ago must not
   * overwrite the results of the one just finished.
   */
  const seq = useRef(0)
  useEffect(() => {
    const text = query.trim()
    if (text.length < MIN_QUERY) {
      setRes(null)
      setBusy(false)
      return
    }
    const mine = ++seq.current
    setBusy(true)
    const t = setTimeout(async () => {
      const out = await window.bullpen.codeSearch(agent.cwd, query, aa, re)
      if (mine !== seq.current) return
      setRes(out)
      setBusy(false)
    }, DEBOUNCE)
    return () => clearTimeout(t)
  }, [query, aa, re, agent.cwd])

  const byFile: Record<string, Hit[]> = {}
  for (const h of res?.hits ?? []) (byFile[h.path] ??= []).push(h)

  /**
   * Lines for a file whose rows fell past the cap.
   *
   * The file list is complete; the rows are not. Rather than hold fifteen
   * thousand rows in the DOM for a list nobody scrolls to the end of, a file
   * with no rows loaded searches itself when it is opened.
   */
  const [extra, setExtra] = useState<Record<string, Hit[]>>({})
  const loadFile = async (path: string): Promise<void> => {
    if (byFile[path] || extra[path]) return
    const one = await window.bullpen.codeSearch(agent.cwd, query, aa, re, [path])
    setExtra((m) => ({ ...m, [path]: one.hits.map((h) => ({ ...h, path })) }))
  }

  return (
    <div style={S.searchInner}>
      <div style={S.searchBar}>
        <input
          style={S.searchInput}
          value={query}
          placeholder="search this workspace"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('')
          }}
        />
        <button
          style={{ ...S.aa, ...(aa ? S.aaOn : null) }}
          title="match case"
          onClick={() => setAa(!aa)}
        >
          Aa
        </button>
        <button
          style={{ ...S.aa, ...(re ? S.aaOn : null) }}
          title="regular expression"
          onClick={() => setRe(!re)}
        >
          .*
        </button>
      </div>

      {busy && <div style={S.hint}>Searching…</div>}
      {res?.error && !busy && <div style={S.error}>{res.error}</div>}
      {res && !res.error && !busy && (
        <div style={S.results}>
          <div style={S.hint}>
            {res.total} result{res.total === 1 ? '' : 's'} in {res.files} file
            {res.files === 1 ? '' : 's'}
            {/* Never a silent truncation: a list that shows a slice of the
                matches while reading like all of them is a wrong answer. */}
            {res.capped && ` — showing the first ${res.hits.length}`}
            {res.timedOut && ' — stopped after 4s, narrow the search'}
          </div>
          {(res.matched ?? []).map(({ path, count }) => {
            const loaded = byFile[path] ?? extra[path]
            const hits = loaded ?? []
            // A file whose rows fell past the cap starts closed: opening it is
            // what loads them, and there is nothing to show until it does.
            const open = !shut.includes(path) && loaded !== undefined
            return (
            <div key={path}>
              <button
                style={S.row}
                onClick={() => {
                  if (open) return setShut((x) => [...x, path])
                  setShut((x) => x.filter((p) => p !== path))
                  loadFile(path)
                }}
              >
                <span style={S.rowName}>
                  <span style={S.caret}>{open ? '▾' : '▸'}</span>
                  <FileIcon dir={false} name={path} />
                  {path}
                </span>
                <span style={S.rowMeta}>{count}</span>
              </button>
              {open &&
                hits.map((h) => (
                  <button
                    key={`${h.line}`}
                    style={{ ...S.hit, ...(openPath === path ? S.rowActive : null) }}
                    title={`${path}:${h.line}`}
                    onClick={() => onOpen(path, h.line)}
                  >
                    <span style={S.hitLine}>{h.line}</span>
                    <span style={S.rowName}>
                      <Marked text={h.text} ranges={h.ranges} />
                    </span>
                  </button>
                ))}
            </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** The editor, and nothing else - the file list is its own panel. */
export function FilePanel({
  file,
  onSave,
  note,
  onClose
}: {
  file: OpenFile | null
  onSave: (text: string) => void
  note: string
  /** Closing gives the width back to the command centre it sits beside. */
  onClose?: () => void
}) {
  const [dirty, setDirty] = useState(false)

  useEffect(() => setDirty(false), [file?.agentId, file?.path])

  // The bar carries the name and the way out, and nothing else: the diff moved
  // to the review panel, where every changed file is in one place, and "vim ·
  // :w saves" was a legend for a keystroke that works whether it is written or
  // not. A narrow half is exactly where a row of labels costs the most.
  return (
    <div style={S.main}>
      <div style={S.bar}>
        <span style={{ ...LABEL, color: 'var(--ink)' }} title={file?.path}>
          {file ? base(file.path) : 'no file open'}
        </span>
        {dirty && <span style={{ ...LABEL, color: 'var(--warn)' }}>unsaved</span>}
        <span style={{ flex: 1 }} />
        {onClose && (
          <button style={S.close} title="close the file" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      {note && <div style={S.note}>{note}</div>}
      {!file && <div style={S.empty}>Open a file from the work tree.</div>}
      {file?.binary && <div style={S.empty}>{file.path} is binary.</div>}
      {file && !file.binary && (
        <Editor
          key={`${file.agentId}:${file.path}`}
          path={file.path}
          text={file.text}
          line={file.line}
          onChange={() => setDirty(true)}
          onSave={(text) => {
            onSave(text)
            setDirty(false)
          }}
        />
      )}
    </div>
  )
}

/**
 * Every uncommitted change, file by file, with its diff under it.
 *
 * The work tree lists the same files; this is for reading what actually changed
 * without opening them one at a time. Diffs are fetched when a file is expanded
 * rather than up front: a hundred changed files is a hundred `git diff` calls.
 */
export function Review({
  agent,
  onOpen,
  onClose,
  shut,
  setShut,
  reload
}: {
  agent: Agent | null
  onOpen: (path: string) => void
  onClose: () => void
  /** Bumped by the caller when it saves a file, to re-read without waiting. */
  reload: number
  /**
   * Files collapsed by hand, held by the caller.
   *
   * Kept outside this component on purpose: closing the panel unmounts it, and
   * state here would forget which files you had already dealt with every time
   * you looked away.
   */
  shut: string[]
  setShut: (next: string[]) => void
}) {
  const [git, setGit] = useState<GitChanges | null>(null)
  const [diffs, setDiffs] = useState<Record<string, ParsedDiff>>({})
  /** Which file's discard button is armed. One at a time, cleared on blur. */
  const [arming, setArming] = useState<string | null>(null)
  /**
   * What is on its way out: a path, or `path#hunk:block`.
   *
   * Discarding used to be instant and invisible - the row was simply not there
   * on the next render, and on a long list it was not obvious which one went.
   * The fade is short enough not to be a wait and long enough to be seen.
   */
  const [going, setGoing] = useState<string | null>(null)
  const [err, setErr] = useState('')

  /** Per-file `adds-dels` from the last poll: what says a diff went stale. */
  const seen = useRef<Record<string, string>>({})

  /**
   * Re-read the workspace, and drop the cached diff of anything that moved.
   *
   * The panel used to refresh only when an agent's PostToolUse hook fired, so a
   * file edited in Bullpen's own editor, or by a shell command, or by anything
   * outside the app, sat there showing the diff it had on open. Closing and
   * reopening the panel was the only way to see the truth.
   */
  const refresh = async (): Promise<void> => {
    if (!agent) return setGit(null)
    const [next, stats] = await Promise.all([
      window.bullpen.gitChanges(agent.cwd),
      window.bullpen.gitStats(agent.cwd)
    ])
    setGit(next)
    setDiffs((cached) => {
      const kept: Record<string, ParsedDiff> = {}
      for (const [path, d] of Object.entries(cached)) {
        const before = seen.current[path]
        const now = stats[path]
        // No numstat means untracked - its counts cannot be compared, so it is
        // always re-read. There are rarely many, and they change the most.
        if (now !== undefined && before === now) kept[path] = d
      }
      return kept
    })
    seen.current = stats
  }

  useEffect(() => {
    seen.current = {}
    setDiffs({})
    refresh()
  }, [agent?.id, agent?.cwd])

  useEffect(() => {
    return window.bullpen.onEdited((id) => {
      if (id === agent?.id) refresh()
    })
  }, [agent?.id])

  // No timer: a poll on a repo this size is a git call every few seconds for a
  // panel that is often just open, and closing and reopening it re-reads
  // everything anyway. What is left refreshes on the events that are free.
  // The app's own editor writes through main without an agent event; the caller
  // bumps `reload` after a save so this sees it immediately rather than in 4s.
  useEffect(() => {
    if (reload) refresh()
  }, [reload])

  // Open by default, like every review tool: the point of the panel is reading
  // the change, and a list of filenames that all need a click is a file tree.
  // Fetched per file as it appears rather than all at once - a hundred changed
  // files is a hundred `git diff` calls before anything is on screen.
  useEffect(() => {
    let live = true
    const load = async (): Promise<void> => {
      if (!agent || !git?.changes) return
      for (const c of git.changes) {
        if (!live) return
        if (diffs[c.path] !== undefined) continue
        const d = await window.bullpen.gitDiff(agent.cwd, c.path)
        if (!live) return
        setDiffs((m) => ({ ...m, [c.path]: parseDiff(d.error ? '' : d.text) }))
      }
    }
    load()
    return () => {
      live = false
    }
  }, [agent?.id, git])

  const discard = async (path: string): Promise<void> => {
    if (!agent) return
    setGoing(path)
    await new Promise((r) => setTimeout(r, FADE))
    const res = await window.bullpen.gitDiscard(agent.cwd, path)
    setGoing(null)
    setErr(res.error ?? '')
    // The diff is gone with the change; drop it so a re-listed file is re-read.
    setDiffs((m) => {
      const next = { ...m }
      delete next[path]
      return next
    })
    refresh()
  }

  const discardBlock = async (
    path: string,
    hunk: number,
    block: number,
    marker: string
  ): Promise<void> => {
    if (!agent) return
    setGoing(`${path}#${hunk}:${block}`)
    await new Promise((r) => setTimeout(r, FADE))
    const res = await window.bullpen.gitDiscardBlock(agent.cwd, path, hunk, block, marker)
    setGoing(null)
    setErr(res.error ?? '')
    setDiffs((m) => {
      const next = { ...m }
      delete next[path]
      return next
    })
    refresh()
  }

  const changes = git?.changes ?? []
  const adds = changes.reduce((n, c) => n + (diffs[c.path]?.adds ?? 0), 0)
  const dels = changes.reduce((n, c) => n + (diffs[c.path]?.dels ?? 0), 0)

  return (
    <div style={S.main}>
      <div style={S.bar}>
        <span style={{ ...LABEL, color: 'var(--ink)' }}>
          uncommitted{git?.branch ? ` · ${git.branch}` : ''}
        </span>
        {changes.length > 0 && (
          <>
            <span style={{ ...LABEL, color: 'var(--faint)' }}>{changes.length} files</span>
            <span style={{ ...LABEL, color: 'var(--ok)' }}>+{adds}</span>
            <span style={{ ...LABEL, color: 'var(--danger)' }}>−{dels}</span>
          </>
        )}
        <span style={{ flex: 1 }} />
        <button style={S.close} title="close review" onClick={onClose}>
          ×
        </button>
      </div>
      {err && <div style={S.error}>{err}</div>}
      <div style={S.reviewBody}>
        {!agent ? (
          <div style={S.empty}>Pick an agent to review its workspace.</div>
        ) : !git ? (
          <div style={S.hint}>Reading…</div>
        ) : !git.repo ? (
          <div style={S.hint}>Not a git repository — no baseline to compare against.</div>
        ) : changes.length === 0 ? (
          <div style={S.hint}>Working tree clean.</div>
        ) : (
          changes.map((c) => {
            const d = diffs[c.path]
            const open = !shut.includes(c.path)
            return (
              <div
                key={c.path}
                style={{ ...S.card, ...(going === c.path ? S.going : null) }}
              >
                <div style={S.cardHead}>
                  <button
                    style={S.cardName}
                    onClick={() =>
                      setShut(
                        shut.includes(c.path) ? shut.filter((p) => p !== c.path) : [...shut, c.path]
                      )
                    }
                  >
                    <span style={{ color: 'var(--faint)' }}>{open ? '▾' : '▸'}</span>
                    <span style={{ ...S.code, color: STATUS_COLOUR(c.code) }}>
                      {c.code.trim() || 'M'}
                    </span>
                    <span style={S.rowName}>{c.path}</span>
                  </button>
                  {d && (d.adds > 0 || d.dels > 0) && (
                    <span style={S.counts}>
                      <span style={{ color: 'var(--ok)' }}>+{d.adds}</span>{' '}
                      <span style={{ color: 'var(--danger)' }}>−{d.dels}</span>
                    </span>
                  )}
                  <button style={S.reviewOpen} title="open in the editor" onClick={() => onOpen(c.path)}>
                    edit
                  </button>
                  {/* Two clicks, and the second one says what it will do: this
                      cannot be undone, and for an untracked file it deletes it. */}
                  <button
                    style={{ ...S.reviewOpen, ...(arming === c.path ? S.discardArmed : null) }}
                    title={
                      c.untracked
                        ? 'delete this file - it has never been committed'
                        : 'throw away every change to this file since HEAD'
                    }
                    onClick={() => {
                      if (arming !== c.path) return setArming(c.path)
                      setArming(null)
                      discard(c.path)
                    }}
                    onBlur={() => setArming((a) => (a === c.path ? null : a))}
                  >
                    {arming === c.path ? (c.untracked ? 'delete?' : 'discard?') : 'discard'}
                  </button>
                </div>
                {open &&
                  (d === undefined ? (
                    <div style={S.hint}>Reading the diff…</div>
                  ) : (
                    <Diff
                      diff={d}
                      untracked={c.untracked}
                      going={going?.startsWith(`${c.path}#`) ? going.split('#')[1] : null}
                      onDiscardBlock={
                        c.untracked
                          ? undefined
                          : (hunk, block, marker) => discardBlock(c.path, hunk, block, marker)
                      }
                    />
                  ))}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/**
 * A parsed diff, drawn as rows: two line-number gutters and the line itself,
 * tinted across the whole row.
 *
 * Plain markup rather than a second CodeMirror: a diff is read, not edited, and
 * a diff language mode would be another dependency to colour by prefix.
 */
function Diff({
  diff,
  untracked,
  going,
  onDiscardBlock
}: {
  diff: ParsedDiff
  untracked?: boolean
  /** `hunk:block` currently fading out, if any. */
  going?: string | null
  /** Absent for an untracked file: there is no HEAD to revert a block to. */
  onDiscardBlock?: (hunk: number, block: number, marker: string, lines: number) => void
}) {
  const [arm, setArm] = useState<string | null>(null)
  /** `hunk:line` of the row under the pointer, so the revert appears on it. */
  const [hover, setHover] = useState<string | null>(null)
  // Which run of touching lines each row belongs to: that is what a person
  // points at, and git's hunks are wider than that.
  const runs = blocks(diff)
  const runOf = (hunk: number, line: number): { at: number; block: Block } | null => {
    const inHunk = runs.filter((b) => b.hunk === hunk)
    const at = inHunk.findIndex((b) => line >= b.start && line <= b.end)
    return at === -1 ? null : { at, block: inHunk[at] }
  }
  if (!diff.hunks.length) {
    return (
      <div style={S.hint}>
        {untracked ? 'New file — nothing to compare it against yet.' : 'No changes against HEAD.'}
      </div>
    )
  }
  return (
    <div style={S.diff}>
      {/* Sized to the widest line, so every row below can be 100% of THAT and
          not 100% of the visible panel - a short row otherwise ran out of tint
          the moment the panel was scrolled sideways. */}
      <div style={S.diffInner}>
      {diff.hunks.map((h, i) => (
        <Fragment key={i}>
          <div style={S.hunkBar}>
            <span style={{ flex: 1, minWidth: 0 }}>
              {h.skipped > 0 ? `${h.skipped} unmodified line${h.skipped === 1 ? '' : 's'}` : ''}
              {h.context ? `  ${h.context}` : ''}
            </span>

          </div>
          {h.lines.map((l, j) => {
            const changed = l.kind !== 'ctx'
            const key = `${i}:${j}`
            const run = changed ? runOf(i, j) : null
            const fading = run !== null && going === `${i}:${run.at}`
            return (
              <div
                key={j}
                style={{
                  ...S.diffRow,
                  ...(l.kind === 'add' ? S.diffAdd : l.kind === 'del' ? S.diffDel : null),
                  ...(changed ? S.rowHover : null),
                  ...(fading ? S.going : null)
                }}
                onMouseEnter={() => changed && setHover(key)}
                onMouseLeave={() => setHover((h) => (h === key ? null : h))}
              >
                {/* On the change, not in a bar above it: the line you want gone
                    is the thing you are pointing at. Reverting still takes the
                    whole hunk - a single line has no patch of its own. */}
                {onDiscardBlock &&
                  changed &&
                  hover === key &&
                  (() => {
                    if (!run) return null
                    const armed = arm === key
                    return (
                      <>
                        <button
                          style={{ ...S.revert, ...(armed ? S.discardArmed : null) }}
                          title={
                            (armed ? 'click again to revert ' : 'revert ') +
                            `these ${run.block.lines} line${run.block.lines === 1 ? '' : 's'}`
                          }
                          onClick={() => {
                            if (!armed) return setArm(key)
                            setArm(null)
                            onDiscardBlock(i, run.at, h.marker, run.block.lines)
                          }}
                        >
                          {armed ? '↺?' : '↺'}
                        </button>
                        <span style={S.hunkOf}>{run.block.lines}L</span>
                      </>
                    )
                  })()}
                <span style={S.gutter}>{l.old ?? ''}</span>
                <span style={S.gutter}>{l.new ?? ''}</span>
                <span style={S.sign}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                <span style={S.diffText}>{l.text || ' '}</span>
              </div>
            )
          })}
        </Fragment>
      ))}
      </div>
    </div>
  )
}

/**
 * What kind of thing a row is.
 *
 * A folder is a drawn shape; a file is a two-character badge of its extension.
 * Tried and rejected: a drawn icon per file type. At 12px they were four
 * near-identical grey rectangles, and every format needs its own glyph - the
 * extension is what tells `.ts` from `.json` anyway, and it never renders as
 * tofu the way an icon font does.
 */
const BADGE: Record<string, { label: string; color: string }> = {
  ts: { label: 'TS', color: '#3178c6' },
  tsx: { label: 'TS', color: '#3178c6' },
  js: { label: 'JS', color: '#e0a800' },
  jsx: { label: 'JS', color: '#e0a800' },
  mjs: { label: 'JS', color: '#e0a800' },
  cjs: { label: 'JS', color: '#e0a800' },
  json: { label: '{}', color: '#c9843e' },
  md: { label: 'MD', color: '#6fb8f0' },
  css: { label: 'CS', color: '#8a7ac9' },
  html: { label: '<>', color: '#d4685f' },
  yml: { label: 'YM', color: '#5fc9bd' },
  yaml: { label: 'YM', color: '#5fc9bd' },
  sh: { label: '$_', color: '#5f9e63' },
  bash: { label: '$_', color: '#5f9e63' },
  py: { label: 'PY', color: '#4b8bbe' },
  go: { label: 'GO', color: '#5fc9bd' },
  rs: { label: 'RS', color: '#c9843e' },
  png: { label: 'IM', color: '#8a7ac9' },
  jpg: { label: 'IM', color: '#8a7ac9' },
  svg: { label: 'IM', color: '#8a7ac9' },
  lock: { label: '::', color: '#8c8b80' },
  env: { label: '::', color: '#8c8b80' }
}

function FileIcon({ dir, open, name = '' }: { dir: boolean; open?: boolean; name?: string }) {
  if (dir) {
    return (
      <svg
        width={12}
        height={12}
        viewBox="0 0 16 16"
        aria-hidden
        style={{ flex: '0 0 auto', marginRight: 5, color: 'var(--muted)' }}
      >
        {/* Filled, not stroked: a 12px outline of a folder is four grey lines. */}
        <path
          fill="currentColor"
          d={
            open
              ? 'M1 13V4h4.6l1.4 1.8H15V13z'
              : 'M1 13V3h5.2l1.4 1.8H14V13z'
          }
        />
      </svg>
    )
  }
  // A dotfile with no extension - `.env`, `.gitignore` - is named by its tail.
  const ext = (name.includes('.') ? name.split('.').pop() : '')?.toLowerCase() ?? ''
  const badge = BADGE[ext]
  return (
    <span style={{ ...S.badge, color: badge?.color ?? 'var(--faint)' }}>
      {badge?.label ?? '··'}
    </span>
  )
}

function Tree({
  root,
  version,
  onOpen,
  openPath,
  rel = '',
  depth = 0
}: {
  root: string
  /** Changes when the listing may be stale; every level re-reads on it. */
  version: number
  onOpen: (path: string) => void
  openPath: string | null
  rel?: string
  depth?: number
}) {
  const [entries, setEntries] = useState<CodeEntry[] | null>(null)
  const [expanded, setExpanded] = useState<string[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!root) return
    window.bullpen.codeList(root, rel).then((res) => {
      setError(res.error ?? '')
      setEntries(res.entries ?? [])
    })
  }, [root, rel, version])

  if (error) return <div style={S.hint}>{error}</div>
  if (!entries) return <div style={S.hint}>Reading…</div>
  if (entries.length === 0) return <div style={S.hint}>empty</div>

  return (
    <>
      {entries.map((e) => (
        <div key={e.path}>
          <button
            style={{
              ...S.row,
              paddingLeft: 8 + depth * 12,
              ...(openPath === e.path ? S.rowActive : null)
            }}
            onClick={() =>
              e.dir
                ? setExpanded((x) =>
                    x.includes(e.path) ? x.filter((p) => p !== e.path) : [...x, e.path]
                  )
                : onOpen(e.path)
            }
          >
            <span style={S.rowName}>
              <span style={S.caret}>{e.dir ? (expanded.includes(e.path) ? '▾' : '▸') : ''}</span>
              <FileIcon dir={e.dir} open={e.dir && expanded.includes(e.path)} name={e.name} />
              {e.name}
            </span>
            {!e.dir && <span style={S.rowMeta}>{size(e.size)}</span>}
          </button>
          {e.dir && expanded.includes(e.path) && (
            <Tree
              root={root}
              version={version}
              onOpen={onOpen}
              openPath={openPath}
              rel={e.path}
              depth={depth + 1}
            />
          )}
        </div>
      ))}
    </>
  )
}

/** Language support by extension; anything unrecognised is edited as plain text. */
function langFor(path: string): Extension[] {
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) {
    return [javascript({ typescript: /\.tsx?$/.test(path), jsx: /x$/.test(path) })]
  }
  if (/\.json$/.test(path)) return [json()]
  if (/\.(md|markdown)$/.test(path)) return [markdown()]
  if (/\.py$/.test(path)) return [python()]
  return []
}

/**
 * CodeMirror with vim keybindings.
 *
 * `vim()` comes first: it installs its own keymap and expects to win over the
 * defaults it shadows.
 */
function Editor({
  path,
  text,
  line,
  onChange,
  onSave
}: {
  path: string
  text: string
  /** 1-based, from a search hit. Re-applied when it changes on the same file. */
  line?: number
  onChange: () => void
  onSave: (text: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  // Kept in a ref so `:w` writes the current buffer rather than the text this
  // effect closed over when the file was opened.
  const view = useRef<EditorView | null>(null)

  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          vim(),
          basicSetup,
          ...langFor(path),
          // basicSetup installs its own highlight style; earlier extensions win
          // in CodeMirror, so ours has to outrank it explicitly.
          Prec.high(syntaxHighlighting(HIGHLIGHT)),
          // CodeMirror's stock theme is light and reads none of the app's
          // variables, so in dark mode the gutter, the active line and the vim
          // command bar all stayed pale. Written as var() rather than two
          // themes: the values follow the mode without remounting the editor.
          EditorView.theme({
            '&': { height: '100%', flex: 1, minWidth: 0, fontSize: '12px', backgroundColor: 'var(--panel)', color: 'var(--ink)' },
            // The scroller is what actually scrolls; without an explicit height
            // it grew to fit the document and the panel had nothing to scroll.
            '.cm-scroller': { fontFamily: MONO, lineHeight: '1.55', overflow: 'auto' },
            '.cm-gutters': {
              backgroundColor: 'var(--sunk)',
              color: 'var(--faint)',
              border: 'none',
              borderRight: '1px solid var(--line)'
            },
            '.cm-activeLineGutter': { backgroundColor: 'var(--line)', color: 'var(--ink)' },
            '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--line) 45%, transparent)' },
            '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
              backgroundColor: 'color-mix(in srgb, var(--accent) 32%, transparent)'
            },
            '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
            // The `:` line and the search box, which are panels, not content.
            '.cm-panels, .cm-panel': { backgroundColor: 'var(--sunk)', color: 'var(--ink)' },
            '.cm-foldPlaceholder': {
              backgroundColor: 'var(--line)',
              color: 'var(--muted)',
              border: 'none'
            }
          }),
          // Ctrl-S as well as :w - muscle memory splits by editor, not by file.
          keymap.of([
            {
              key: 'Mod-s',
              run: (target) => {
                onSave(target.state.doc.toString())
                return true
              }
            }
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChange()
          })
        ]
      })
    })
    view.current = v
    return () => v.destroy()
  }, [path])

  /**
   * Put the cursor on the line that was clicked, and scroll it into view.
   *
   * In its own effect, keyed on the line: opening a second hit in a file that
   * is already open changes nothing the editor would rebuild for, so doing this
   * at construction only worked for the first click.
   */
  useEffect(() => {
    const v = view.current
    if (!v || !line) return
    const at = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines))
    v.dispatch({
      selection: { anchor: at.from },
      effects: EditorView.scrollIntoView(at.from, { y: 'center' })
    })
    v.focus()
  }, [path, line])

  // The vim `:w` command is global to CodeMirror, so it is defined once and
  // routed through a ref to whichever editor is currently mounted.
  useEffect(() => {
    saveCurrent = () => {
      const v = view.current
      if (v) onSave(v.state.doc.toString())
    }
    return () => {
      saveCurrent = null
    }
  }, [onSave])

  return <div ref={host} style={S.editor} />
}

/**
 * Syntax colours, drawn from the same variables as everything else.
 *
 * CodeMirror's default highlight style is a fixed light palette - readable on
 * paper, muddy on the dark background. var() rather than a style per mode: the
 * colours follow the theme without rebuilding the editor.
 */
const HIGHLIGHT = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--code-key)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--code-str)' },
  { tag: [t.number, t.bool, t.atom, t.null], color: 'var(--code-num)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--code-fn)' },
  { tag: [t.typeName, t.className, t.namespace, t.self, t.standard(t.variableName)], color: 'var(--code-type)' },
  { tag: [t.propertyName, t.attributeName, t.tagName], color: 'var(--code-prop)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator, t.meta], color: 'var(--code-punct)' },
  { tag: [t.heading, t.strong], color: 'var(--code-heading)', fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--code-fn)', textDecoration: 'underline' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.invalid, color: 'var(--danger)' }
])

/** Set by the mounted editor; called by the `:w` command defined below. */
let saveCurrent: (() => void) | null = null

// Defined once at module load: defining a vim ex command per mount would stack
// handlers and save the same file several times.
Vim.defineEx('write', 'w', () => saveCurrent?.())
Vim.defineEx('wq', 'wq', () => saveCurrent?.())
// Referenced so the bundler keeps the vim addon's CodeMirror shim, which the
// ex commands above are registered against.
void getCM

/** Added, deleted and modified must not all read the same at a glance. */
const STATUS_COLOUR = (code: string): string => {
  const c = code.trim()
  if (c === '??' || c.includes('A')) return 'var(--ok)'
  if (c.includes('D')) return 'var(--danger)'
  if (c.includes('R') || c.includes('C')) return 'var(--accent-ink)'
  return 'var(--warn)'
}

const base = (p: string): string => p.split('/').pop() ?? p

/** Hook payloads carry absolute paths; the panels work in workspace-relative ones. */
const rel = (root: string, p: string): string =>
  p.startsWith(root) ? p.slice(root.length).replace(/^\//, '') : p

const ago = (ts: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

const size = (n: number): string => (n < 1024 ? `${n}b` : `${Math.round(n / 1024)}k`)

/** Long enough to be seen, short enough not to be a wait. */
const FADE = 180

/** A pause in typing, not a delay: shorter and every keystroke walks the tree. */
const DEBOUNCE = 300

/** One character matches most of a codebase; the walk is not worth it. */
const MIN_QUERY = 2

const S: Record<string, React.CSSProperties> = {
  going: { opacity: 0.25, transform: 'translateX(-6px)' },
  side: { overflowY: 'auto', font: `11px ${MONO}`, flex: 1, minHeight: 0 },
  tree: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  search: { flex: 1, minHeight: 0, flexDirection: 'column' },
  searchInner: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
  modes: {
    display: 'flex',
    gap: 4,
    padding: '4px 8px',
    borderBottom: '1px solid var(--line)',
    flex: '0 0 auto'
  },
  mode: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 20,
    background: 'transparent',
    border: '1px solid',
    borderColor: 'transparent',
    color: 'var(--faint)',
    cursor: 'pointer',
    padding: 0,
    // The white ring was Chromium's focus outline, not a style of ours: these
    // are toggles, and the one that is on already says so in colour.
    outline: 'none'
  },
  modeOn: { color: 'var(--accent-ink)', borderColor: 'var(--accent-ink)' },
  searchBar: { display: 'flex', gap: 6, padding: '5px 8px', alignItems: 'center' },
  searchInput: {
    flex: 1,
    minWidth: 0,
    outline: 'none',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    font: `11px ${MONO}`,
    padding: '3px 6px'
  },
  aa: {
    background: 'transparent',
    outline: 'none',
    border: '1px solid',
    borderColor: 'var(--line)',
    color: 'var(--faint)',
    cursor: 'pointer',
    font: `10px ${MONO}`,
    padding: '2px 5px'
  },
  aaOn: { color: 'var(--accent-ink)', borderColor: 'var(--accent-ink)' },
  results: { flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 4 },
  hit: {
    display: 'flex',
    gap: 8,
    alignItems: 'baseline',
    width: '100%',
    padding: '1px 8px 1px 22px',
    background: 'transparent',
    border: 'none',
    color: 'var(--muted)',
    cursor: 'pointer',
    font: `11px ${MONO}`,
    textAlign: 'left'
  },
  hitLine: { flex: '0 0 auto', width: 34, textAlign: 'right', color: 'var(--faint)' },
  mark: {
    background: 'color-mix(in srgb, var(--accent) 45%, transparent)',
    color: 'var(--ink)',
    borderRadius: 2
  },
  caret: { flex: '0 0 auto', width: 10, display: 'inline-block', color: 'var(--faint)' },
  badge: {
    flex: '0 0 auto',
    width: 18,
    marginRight: 5,
    textAlign: 'center',
    font: `9px ${MONO}`,
    fontWeight: 700,
    letterSpacing: '0.02em'
  },
  main: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, height: '100%' },
  // No padding at the top: a sticky header sticks to the padding edge, so the
  // 8px above it was a slot for the previous line to show through.
  reviewBody: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 8px' },
  card: {
    border: '1px solid var(--line)',
    background: 'var(--panel)',
    margin: '8px 0 10px',
    transition: `opacity ${FADE}ms ease, transform ${FADE}ms ease`
  },

  cardHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 8px',
    borderBottom: '1px solid var(--line)',
    // Which file you are looking at is the thing that scrolls away first in a
    // long diff, and it is the one thing every line below needs.
    position: 'sticky',
    top: 0,
    zIndex: 1,
    background: 'var(--panel)'
  },
  cardName: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    minWidth: 0,
    background: 'transparent',
    border: 'none',
    color: 'var(--ink)',
    cursor: 'pointer',
    font: `11px ${MONO}`,
    textAlign: 'left'
  },
  counts: { font: `10px ${MONO}`, whiteSpace: 'nowrap' },
  discardArmed: { color: 'var(--danger)', borderColor: 'var(--danger)' },
  rowHover: { position: 'relative' },
  hunkOf: {
    position: 'absolute',
    left: 30,
    top: 0,
    zIndex: 1,
    padding: '0 4px',
    background: 'var(--panel)',
    color: 'var(--faint)',
    font: `10px ${MONO}`,
    pointerEvents: 'none'
  },
  revert: {
    position: 'absolute',
    left: 2,
    top: 0,
    zIndex: 1,
    height: '100%',
    padding: '0 4px',
    background: 'var(--panel)',
    border: '1px solid',
    borderColor: 'var(--line)',
    color: 'var(--muted)',
    cursor: 'pointer',
    font: `10px ${MONO}`,
    lineHeight: 1
  },
  error: { padding: '4px 10px', color: 'var(--danger)', font: `11px ${MONO}` },
  // max-content so the row is as wide as its longest line, min-width 100% so a
  // short line still tints the full width of the panel.
  diffInner: { width: 'max-content', minWidth: '100%' },
  diffRow: {
    display: 'flex',
    alignItems: 'flex-start',
    whiteSpace: 'pre',
    minWidth: '100%',
    transition: `opacity ${FADE}ms ease, transform ${FADE}ms ease`
  },
  // Tinted across the row, not just the text: at a glance the shape of a change
  // is which lines are green and which are red, not which words are.
  diffAdd: { background: 'color-mix(in srgb, var(--ok) 16%, transparent)' },
  diffDel: { background: 'color-mix(in srgb, var(--danger) 16%, transparent)' },
  gutter: {
    flex: '0 0 auto',
    width: 34,
    paddingRight: 6,
    textAlign: 'right',
    color: 'var(--faint)',
    userSelect: 'none'
  },
  sign: { flex: '0 0 auto', width: 12, color: 'var(--faint)', userSelect: 'none' },
  diffText: { flex: '0 0 auto', paddingRight: 10, color: 'var(--ink)' },
  hunkBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: '100%',
    boxSizing: 'border-box',
    padding: '2px 8px',
    color: 'var(--faint)',
    background: 'var(--sunk)',
    borderTop: '1px solid var(--line)',
    borderBottom: '1px solid var(--line)'
  },
  reviewName: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    minWidth: 0,
    background: 'transparent',
    border: 'none',
    color: 'var(--ink)',
    cursor: 'pointer',
    font: `11px ${MONO}`,
    textAlign: 'left'
  },
  reviewOpen: {
    background: 'transparent',
    border: '1px solid',
    borderColor: 'var(--line)',
    color: 'var(--muted)',
    cursor: 'pointer',
    font: `10px ${MONO}`,
    padding: '1px 6px'
  },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 10px',
    borderBottom: '1px solid var(--line)'
  },
  sectionHead: {
    display: 'flex',
    gap: 6,
    width: '100%',
    padding: '6px 8px',
    background: 'transparent',
    border: 'none',
    color: 'var(--faint)',
    cursor: 'pointer',
    font: `10px ${MONO}`,
    letterSpacing: '0.09em',
    textTransform: 'uppercase'
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '3px 8px',
    background: 'transparent',
    border: 'none',
    color: 'var(--muted)',
    cursor: 'pointer',
    font: `11px ${MONO}`,
    textAlign: 'left'
  },
  rowActive: { background: 'var(--sunk)', color: 'var(--ink)' },
  rowName: {
    display: 'flex',
    alignItems: 'center', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowMeta: { color: 'var(--faint)', fontSize: 10 },
  code: { width: 18, flexShrink: 0, fontSize: 10, fontWeight: 700 },
  diff: {
    // The scroll lives here so the rows inside can be wider than the panel; a
    // row clipped to the panel painted its tint only as far as the fold, and a
    // long line looked half-added.
    overflowX: 'auto',
    margin: 0,
    font: `12px ${MONO}`,
    lineHeight: 1.5,
    whiteSpace: 'pre'
  },
  tab: {
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: 'var(--faint)',
    cursor: 'pointer',
    padding: '2px 4px',
    font: `10px ${MONO}`,
    letterSpacing: '0.09em',
    textTransform: 'uppercase'
  },
  tabOn: { color: 'var(--ink)', borderBottomColor: 'var(--accent)' },
  // display:flex, not a percentage height: the CodeMirror scroller is sized by
  // this box, and a box that shrank to its content put the horizontal scrollbar
  // directly under the last line with empty panel below it.
  editor: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', overflow: 'hidden' },
  close: {
    background: 'transparent',
    border: 'none',
    color: 'var(--faint)',
    cursor: 'pointer',
    font: `12px ${MONO}`,
    padding: '0 2px'
  },
  note: {
    padding: '4px 10px',
    borderBottom: '1px solid var(--line)',
    color: 'var(--muted)',
    font: `11px ${MONO}`
  },
  hint: { padding: '4px 10px', color: 'var(--faint)', font: `11px ${MONO}`, lineHeight: 1.5 },
  empty: { padding: 16, color: 'var(--faint)', font: `11px ${MONO}`, lineHeight: 1.6 }
}
