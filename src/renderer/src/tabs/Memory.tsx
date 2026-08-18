import { useEffect, useRef, useState } from 'react'
import { onEnter } from '../keys'
import { parseMarkdown, type Block, type Span } from '../../../markdown.ts'
import { LABEL, MONO } from '../theme'
import type { Agent } from '../store'

/**
 * What each agent is carrying, and a way to find anything the floor has written.
 *
 * The memory file is rendered rather than dumped, and editable in place: it is
 * the one file in the workspace whose contents are instructions to the agent,
 * so "why is it behaving like that" and "stop it behaving like that" are the
 * same panel. Search is a plain substring sweep over the board, the activity
 * log and every inbox - no index, no embedding model, exact text only.
 */
export function Memory({ agents, selected }: { agents: Agent[]; selected: string | null }) {
  const [who, setWho] = useState<string>(selected ?? agents[0]?.id ?? '')
  const [doc, setDoc] = useState<{ name: string; text: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ where: string; text: string }[] | null>(null)
  /**
   * Read it, or write it with the rendering beside you.
   *
   * No editor-only mode: a memory file is prose that has to read well, and an
   * editor with the reading hidden is the one of the two nobody asked for.
   */
  const [mode, setMode] = useState<'read' | 'split'>('read')
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')

  const agent = agents.find((a) => a.id === who) ?? null

  const load = (): void => {
    if (!agent) return setDoc(null)
    setLoading(true)
    window.bullpen
      .memory(agent.cwd)
      .then(setDoc)
      .finally(() => setLoading(false))
  }
  // Editing is dropped when the agent changes: a draft belongs to the file it
  // was opened from, and carrying it across would write one agent's rules into
  // another's workspace.
  useEffect(() => {
    setMode('read')
    setNote('')
    load()
  }, [agent?.id, agent?.cwd])

  /**
   * The two halves of split scroll together.
   *
   * Proportionally, not line for line: rendered text is shorter than its source
   * - a fence loses its backticks, a heading loses its hashes - so matching
   * pixels would drift apart down the page. `syncing` is the loop guard:
   * setting scrollTop fires the other pane's own scroll handler.
   */
  const editor = useRef<HTMLTextAreaElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const syncing = useRef(false)

  const sync = (from: HTMLElement | null, to: HTMLElement | null): void => {
    if (!from || !to || syncing.current || mode !== 'split') return
    const fromMax = from.scrollHeight - from.clientHeight
    const toMax = to.scrollHeight - to.clientHeight
    if (fromMax <= 1 || toMax <= 1) return
    syncing.current = true
    to.scrollTop = (from.scrollTop / fromMax) * toMax
    requestAnimationFrame(() => {
      syncing.current = false
    })
  }

  /** Opening the editor starts from what is on disk, not from the last draft. */
  const open = (next: 'split'): void => {
    if (mode === 'read') setDraft(doc?.text ?? `# ${agent?.name ?? 'Agent'}\n\n`)
    setNote('')
    setMode(next)
  }

  const save = async (): Promise<void> => {
    if (!agent) return
    const name = doc?.name ?? 'CLAUDE.md'
    const res = await window.bullpen.codeWrite(agent.cwd, name, draft)
    if (res.error) return setNote(res.error)
    setNote(`saved ${name} — it takes effect on the agent's next turn`)
    setMode('read')
    load()
  }

  const search = async (): Promise<void> => {
    if (query.trim().length < 2) return setHits([])
    setHits(await window.bullpen.search(query.trim()))
  }

  if (agents.length === 0) return <div style={S.empty}>Nobody on the floor yet.</div>

  return (
    <div style={S.wrap}>
      <div style={LABEL}>Text search — board, activity, inboxes</div>
      <div style={{ display: 'flex', gap: 8, margin: '6px 0 16px' }}>
        <input
          style={S.input}
          value={query}
          placeholder="find exact text across the hive…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onEnter(search)}
        />
        <button style={S.btn} onClick={search}>
          search
        </button>
      </div>

      {hits !== null && (
        <div style={{ marginBottom: 18, maxHeight: 200, overflowY: 'auto', flex: '0 0 auto' }}>
          <div style={{ ...LABEL, color: 'var(--faint)', marginBottom: 6 }}>
            {hits.length} match{hits.length === 1 ? '' : 'es'}
          </div>
          {hits.map((h, i) => (
            <div key={i} style={S.hit}>
              <span style={{ ...LABEL, color: 'var(--accent-ink)', flex: '0 0 150px' }}>{h.where}</span>
              <span style={{ flex: 1, color: 'var(--muted)', wordBreak: 'break-word' }}>{h.text}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={LABEL}>Memory file</span>
        <select style={S.select} value={who} onChange={(e) => setWho(e.target.value)}>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {doc && (
          <span style={{ ...LABEL, color: 'var(--faint)' }}>
            {doc.name} · {doc.text.split('\n').length} lines · loaded into every turn
          </span>
        )}
        <span style={{ flex: 1 }} />
        {/* One row of switches rather than an edit button that swaps the panel:
            split is where a memory file actually gets written - the rules read
            differently rendered than they do as source. */}
        {(['read', 'split'] as const).map((m) => (
          <span
            key={m}
            style={{ ...S.choice, ...(mode === m ? S.choiceOn : null) }}
            onClick={() => (m === 'read' ? setMode('read') : open('split'))}
          >
            {m}
          </span>
        ))}
        {mode !== 'read' && (
          <>
            <button style={S.btn} onClick={save}>
              save
            </button>
            <button
              style={S.link}
              onClick={() => {
                setMode('read')
                setNote('')
              }}
            >
              cancel
            </button>
          </>
        )}
      </div>

      {loading && <div style={S.empty}>Reading…</div>}
      {!loading && !doc && mode === 'read' && (
        <div style={S.empty}>
          No CLAUDE.md, CLAUDE.local.md or AGENTS.md in {agent?.cwd}. This agent runs on the briefing
          you gave it and nothing else.{' '}
          <button
            style={S.link}
            onClick={() => open('split')}
          >
            write one
          </button>
        </div>
      )}
      {note && <div style={S.note}>{note}</div>}

      <div style={{ ...S.body, ...(mode === 'split' ? S.split : null) }}>
        {mode !== 'read' && (
          <textarea
            ref={editor}
            style={S.editor}
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onScroll={() => sync(editor.current, preview.current)}
          />
        )}
        {/* In split it renders the draft, not the file: the point is seeing
            what you are typing, before it is saved. */}
        {!loading && (doc || mode === 'split') && (
          <Markdown
            text={mode === 'split' ? draft : (doc?.text ?? '')}
            innerRef={preview}
            onScroll={() => sync(preview.current, editor.current)}
          />
        )}
      </div>
    </div>
  )
}

/** The memory file as it reads, not as it is stored. */
function Markdown({
  text,
  innerRef,
  onScroll
}: {
  text: string
  innerRef?: React.RefObject<HTMLDivElement | null>
  onScroll?: () => void
}) {
  return (
    <div ref={innerRef} onScroll={onScroll} style={S.doc}>
      {parseMarkdown(text).map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  )
}

function BlockView({ block }: { block: Block }) {
  if (block.kind === 'rule') return <hr style={S.hr} />
  if (block.kind === 'fence') {
    return (
      <pre style={S.fence}>
        {block.lang && <span style={S.lang}>{block.lang}</span>}
        {block.text}
      </pre>
    )
  }
  if (block.kind === 'heading') {
    const size = [17, 15, 13, 12, 12, 12][block.level - 1] ?? 12
    return (
      <div style={{ ...S.heading, fontSize: size, marginTop: block.level === 1 ? 4 : 16 }}>
        <Spans spans={block.spans} />
      </div>
    )
  }
  if (block.kind === 'quote') {
    return (
      <div style={S.quote}>
        <Spans spans={block.spans} />
      </div>
    )
  }
  if (block.kind === 'bullet') {
    return (
      <div style={{ ...S.bullet, marginLeft: 10 + block.depth * 16 }}>
        <span style={S.dot}>{block.ordered ? '·' : '•'}</span>
        <span>
          <Spans spans={block.spans} />
        </span>
      </div>
    )
  }
  return (
    <p style={S.para}>
      <Spans spans={block.spans} />
    </p>
  )
}

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) => {
        if (s.kind === 'code') return <code key={i} style={S.code}>{s.text}</code>
        if (s.kind === 'strong') return <b key={i} style={{ color: 'var(--ink)' }}>{s.text}</b>
        if (s.kind === 'em') return <i key={i}>{s.text}</i>
        if (s.kind === 'link') {
          // Opened in the browser, not in the app: a link in a memory file is a
          // document to read, and a webview here would be a second browser.
          return (
            <a
              key={i}
              style={S.a}
              href={s.href}
              onClick={(e) => {
                e.preventDefault()
                window.bullpen.openExternal(s.href)
              }}
            >
              {s.text}
            </a>
          )
        }
        return <span key={i}>{s.text}</span>
      })}
    </>
  )
}

const S: Record<string, React.CSSProperties> = {
  // A column, not a scrolling page: the document is the part that grows, so it
  // fills whatever the panel is instead of stopping at a fixed height with a
  // field of empty panel under it.
  wrap: {
    padding: 14,
    height: '100%',
    // Border-box, or the padding is added to the 100% and the document hangs
    // 28px past the bottom of the panel it is supposed to fit in.
    boxSizing: 'border-box',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    font: `12px ${MONO}`
  },
  body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
  split: { flexDirection: 'row', gap: 10 },
  choice: {
    padding: '4px 10px',
    background: 'transparent',
    color: 'var(--muted)',
    border: '1px solid var(--line)',
    cursor: 'pointer',
    font: `11px ${MONO}`
  },
  choiceOn: { background: 'var(--accent)', color: '#241f1a', borderColor: 'var(--accent)' },
  input: {
    flex: 1,
    padding: '6px 9px',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    font: `12px ${MONO}`
  },
  select: {
    padding: '4px 6px',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    font: `11px ${MONO}`
  },
  btn: {
    padding: '6px 14px',
    background: 'var(--accent)',
    color: '#241f1a',
    border: '1px solid var(--accent)',
    cursor: 'pointer',
    font: `11px ${MONO}`
  },
  hit: {
    display: 'flex',
    gap: 10,
    padding: '4px 0',
    borderTop: '1px solid var(--line)',
    fontSize: 11
  },
  heading: { color: 'var(--ink)', fontWeight: 700, marginBottom: 4, letterSpacing: '0.02em' },
  para: { margin: '0 0 8px', color: 'var(--muted)', lineHeight: 1.6 },
  bullet: { display: 'flex', gap: 8, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 2 },
  dot: { color: 'var(--faint)' },
  quote: {
    borderLeft: '3px solid var(--line)',
    padding: '2px 0 2px 10px',
    margin: '0 0 8px',
    color: 'var(--faint)'
  },
  fence: {
    position: 'relative',
    background: 'var(--sunk)',
    border: '1px solid var(--line)',
    padding: '10px 10px 8px',
    margin: '0 0 10px',
    overflowX: 'auto',
    whiteSpace: 'pre',
    color: 'var(--ink)',
    font: `11px ${MONO}`,
    lineHeight: 1.5
  },
  lang: {
    position: 'absolute',
    top: 2,
    right: 6,
    fontSize: 9,
    color: 'var(--faint)',
    letterSpacing: '0.14em',
    textTransform: 'uppercase'
  },
  code: { background: 'var(--sunk)', padding: '1px 4px', color: 'var(--ink)' },
  a: { color: 'var(--accent-ink)', textDecoration: 'underline', cursor: 'pointer' },
  hr: { border: 0, borderTop: '1px solid var(--line)', margin: '12px 0' },
  link: {
    background: 'transparent',
    border: 'none',
    color: 'var(--accent-ink)',
    cursor: 'pointer',
    font: `11px ${MONO}`,
    textDecoration: 'underline'
  },
  note: { color: 'var(--muted)', fontSize: 11, margin: '0 0 8px' },
  editor: {
    width: '100%',
    flex: 1,
    minWidth: 0,
    minHeight: 120,
    boxSizing: 'border-box',
    padding: 10,
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    outline: 'none',
    font: `12px ${MONO}`,
    lineHeight: 1.5,
    resize: 'none'
  },
  // Rendered now, so the container is a page rather than a code block: the
  // pre-wrap and monospace belong to the fences inside it.
  doc: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflowY: 'auto',
    wordBreak: 'break-word',
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    padding: '12px 14px',
    margin: 0,
    font: `12px ${MONO}`,
    color: 'var(--ink)',
    lineHeight: 1.55
  },
  empty: { color: 'var(--faint)', padding: 18, fontSize: 11, lineHeight: 1.6 }
}
