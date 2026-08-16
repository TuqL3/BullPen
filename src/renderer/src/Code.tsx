import { useEffect, useRef, useState } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { LABEL, MONO } from './theme'
import type { Agent } from './store'
import type { CodeEdit, CodeEntry, GitChanges } from '../../preload/index'

export type OpenFile = {
  agentId: string
  root: string
  path: string
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
export async function openFile(agent: Agent, path: string): Promise<OpenFile | string> {
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
  onOpen: (path: string) => void
}) {
  const [edits, setEdits] = useState<CodeEdit[]>([])
  const [git, setGit] = useState<GitChanges | null>(null)
  const [showTree, setShowTree] = useState(true)
  const [showRecent, setShowRecent] = useState(false)
  const [showChanges, setShowChanges] = useState(true)
  // Bumped on every refresh so the tree re-lists: a file an agent just created
  // did not appear until the panel happened to remount.
  const [version, setVersion] = useState(0)

  const refresh = (): void => {
    if (!agent) {
      setEdits([])
      setGit(null)
      return
    }
    window.bullpen.codeEdits(agent.id).then(setEdits)
    window.bullpen.gitChanges(agent.cwd).then(setGit)
    setVersion((v) => v + 1)
  }
  useEffect(refresh, [agent?.id, agent?.cwd])

  // The lists are only useful if they keep up with the agent they watch. The
  // hook fires on every write, which is also exactly when git has more to say.
  useEffect(() => {
    return window.bullpen.onEdited((id) => {
      if (id === agent?.id) refresh()
    })
  }, [agent?.id])

  // A Bash command, a rebase or an editor outside Bullpen changes files without
  // any hook firing, so the list also refreshes on a slow clock.
  useEffect(() => {
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [agent?.id, agent?.cwd])

  if (!agent) return <div style={S.empty}>Pick an agent to see what it is working on.</div>

  return (
    <div style={S.side}>
      <Section
        title={`changes${git?.branch ? ` · ${git.branch}` : ''}`}
        open={showChanges}
        onToggle={() => setShowChanges(!showChanges)}
      >
        {!git ? (
          <div style={S.hint}>Reading…</div>
        ) : !git.repo ? (
          <div style={S.hint}>Not a git repository — no baseline to compare against.</div>
        ) : git.error ? (
          <div style={S.hint}>{git.error}</div>
        ) : git.changes.length === 0 ? (
          <div style={S.hint}>Working tree clean.</div>
        ) : (
          git.changes.map((c) => (
            <button
              key={c.path}
              style={{ ...S.row, ...(openPath === c.path ? S.rowActive : null) }}
              title={`${c.code} ${c.path}`}
              onClick={() => onOpen(c.path)}
            >
              <span style={{ ...S.code, color: STATUS_COLOUR(c.code) }}>{c.code.trim() || 'M'}</span>
              <span style={S.rowName}>{c.path}</span>
              {c.staged && <span style={S.rowMeta}>staged</span>}
            </button>
          ))
        )}
      </Section>

      <Section title="recently touched" open={showRecent} onToggle={() => setShowRecent(!showRecent)}>
        {edits.length === 0 ? (
          <div style={S.hint}>Nothing yet — this fills in as {agent.name} writes files.</div>
        ) : (
          edits.map((e) => (
            <button
              key={e.path}
              style={{ ...S.row, ...(openPath === rel(agent.cwd, e.path) ? S.rowActive : null) }}
              title={e.path}
              onClick={() => onOpen(rel(agent.cwd, e.path))}
            >
              <span style={S.rowName}>{base(e.path)}</span>
              <span style={S.rowMeta}>{ago(e.ts)}</span>
            </button>
          ))
        )}
      </Section>

      <Section title="files" open={showTree} onToggle={() => setShowTree(!showTree)}>
        <Tree key={agent.id} root={agent.cwd} version={version} onOpen={onOpen} openPath={openPath} />
      </Section>
    </div>
  )
}

/** The editor, and nothing else - the file list is its own panel. */
export function FilePanel({
  file,
  onSave,
  note
}: {
  file: OpenFile | null
  onSave: (text: string) => void
  note: string
}) {
  const [dirty, setDirty] = useState(false)
  const [view, setView] = useState<'file' | 'diff'>('file')

  useEffect(() => setDirty(false), [file?.agentId, file?.path])

  // A file with no diff has nothing to show on that tab, and leaving the panel
  // on it after opening an unchanged file looks like the diff failed.
  const hasDiff = Boolean(file?.diff?.trim())
  useEffect(() => {
    if (!hasDiff) setView('file')
  }, [hasDiff, file?.path])

  return (
    <div style={S.main}>
      <div style={S.bar}>
        <span style={{ ...LABEL, color: 'var(--ink)' }}>{file?.path ?? 'no file open'}</span>
        {dirty && <span style={{ ...LABEL, color: 'var(--warn)' }}>unsaved</span>}
        <span style={{ flex: 1 }} />
        {file && (
          <>
            <button
              style={{ ...S.tab, ...(view === 'file' ? S.tabOn : null) }}
              onClick={() => setView('file')}
            >
              file
            </button>
            <button
              style={{
                ...S.tab,
                ...(view === 'diff' ? S.tabOn : null),
                ...(hasDiff ? null : { opacity: 0.4, cursor: 'default' })
              }}
              title={hasDiff ? 'changes against HEAD' : 'unchanged since the last commit'}
              onClick={() => hasDiff && setView('diff')}
            >
              diff
            </button>
          </>
        )}
        <span style={{ ...LABEL, color: 'var(--faint)' }}>
          {view === 'diff' ? 'read-only' : 'vim · :w saves'}
        </span>
      </div>
      {note && <div style={S.note}>{note}</div>}
      {!file && <div style={S.empty}>Open a file from the work tree.</div>}
      {file?.binary && <div style={S.empty}>{file.path} is binary.</div>}
      {file && view === 'diff' && <Diff text={file.diff ?? ''} />}
      {file && !file.binary && view === 'file' && (
        <Editor
          key={`${file.agentId}:${file.path}`}
          path={file.path}
          text={file.text}
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
 * A unified diff, coloured per line.
 *
 * Plain markup rather than a second CodeMirror: a diff is read, not edited, and
 * the whole rendering is a colour per line prefix. A diff language mode would be
 * another dependency to do exactly this.
 */
function Diff({ text }: { text: string }) {
  if (!text.trim()) return <div style={S.empty}>No changes against HEAD.</div>
  return (
    <div style={S.diff}>
      {text.split('\n').map((line, i) => (
        <div key={i} style={{ color: diffColour(line) }}>
          {line || ' '}
        </div>
      ))}
    </div>
  )
}

const diffColour = (line: string): string => {
  if (line.startsWith('+++') || line.startsWith('---')) return 'var(--faint)'
  if (line.startsWith('@@')) return 'var(--accent-ink)'
  if (line.startsWith('+')) return 'var(--ok)'
  if (line.startsWith('-')) return 'var(--danger)'
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'var(--faint)'
  return 'var(--muted)'
}

function Section({
  title,
  open,
  onToggle,
  children
}: {
  title: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div style={{ borderBottom: '1px solid var(--line)' }}>
      <button style={S.sectionHead} onClick={onToggle}>
        <span>{open ? '▾' : '▸'}</span>
        <span>{title}</span>
      </button>
      {open && <div style={{ paddingBottom: 6 }}>{children}</div>}
    </div>
  )
}

/**
 * One directory level at a time. A recursive walk of a real repository is
 * thousands of stats before anything is on screen, and node_modules alone would
 * dominate it.
 */
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
              {e.dir ? (expanded.includes(e.path) ? '▾ ' : '▸ ') : ''}
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
  onChange,
  onSave
}: {
  path: string
  text: string
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
          EditorView.theme({
            '&': { height: '100%', fontSize: '12px' },
            '.cm-scroller': { fontFamily: MONO, lineHeight: '1.55' }
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

const S: Record<string, React.CSSProperties> = {
  side: { overflowY: 'auto', font: `11px ${MONO}`, height: '100%', minHeight: 0 },
  main: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, height: '100%' },
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
  rowName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowMeta: { color: 'var(--faint)', fontSize: 10 },
  code: { width: 18, flexShrink: 0, fontSize: 10, fontWeight: 700 },
  diff: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    margin: 0,
    padding: '6px 10px',
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
  editor: { flex: 1, minHeight: 0, overflow: 'hidden' },
  note: {
    padding: '4px 10px',
    borderBottom: '1px solid var(--line)',
    color: 'var(--muted)',
    font: `11px ${MONO}`
  },
  hint: { padding: '4px 10px', color: 'var(--faint)', font: `11px ${MONO}`, lineHeight: 1.5 },
  empty: { padding: 16, color: 'var(--faint)', font: `11px ${MONO}`, lineHeight: 1.6 }
}
