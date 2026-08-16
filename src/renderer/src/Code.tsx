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
import type { CodeEdit, CodeEntry } from '../../preload/index'

export type OpenFile = {
  agentId: string
  root: string
  path: string
  text: string
  truncated: boolean
  binary: boolean
}

/**
 * Ask main for a file, in the form the editor panel wants it.
 *
 * Lives here rather than in either panel because the tree opens files and the
 * editor displays them, and they are separate panels the operator can put in
 * different columns.
 */
export async function openFile(agent: Agent, path: string): Promise<OpenFile | string> {
  const res = await window.bullpen.codeRead(agent.cwd, path)
  if (res.error) return res.error
  return {
    agentId: agent.id,
    root: agent.cwd,
    path,
    text: res.text ?? '',
    truncated: !!res.truncated,
    binary: !!res.binary
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
  const [showTree, setShowTree] = useState(true)
  const [showRecent, setShowRecent] = useState(true)

  const refreshEdits = (): void => {
    if (!agent) return setEdits([])
    window.bullpen.codeEdits(agent.id).then(setEdits)
  }
  useEffect(refreshEdits, [agent?.id])

  // The list is only useful if it keeps up with the agent it is watching.
  useEffect(() => {
    return window.bullpen.onEdited((id) => {
      if (id === agent?.id) refreshEdits()
    })
  }, [agent?.id])

  if (!agent) return <div style={S.empty}>Pick an agent to see what it is working on.</div>

  return (
    <div style={S.side}>
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
        <Tree key={agent.id} root={agent.cwd} onOpen={onOpen} openPath={openPath} />
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

  useEffect(() => setDirty(false), [file?.agentId, file?.path])

  return (
    <div style={S.main}>
      <div style={S.bar}>
        <span style={{ ...LABEL, color: 'var(--ink)' }}>{file?.path ?? 'no file open'}</span>
        {dirty && <span style={{ ...LABEL, color: 'var(--warn)' }}>unsaved</span>}
        <span style={{ flex: 1 }} />
        <span style={{ ...LABEL, color: 'var(--faint)' }}>vim · :w saves</span>
      </div>
      {note && <div style={S.note}>{note}</div>}
      {!file && <div style={S.empty}>Open a file from the work tree.</div>}
      {file?.binary && <div style={S.empty}>{file.path} is binary.</div>}
      {file && !file.binary && (
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
  onOpen,
  openPath,
  rel = '',
  depth = 0
}: {
  root: string
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
  }, [root, rel])

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
            <Tree root={root} onOpen={onOpen} openPath={openPath} rel={e.path} depth={depth + 1} />
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
