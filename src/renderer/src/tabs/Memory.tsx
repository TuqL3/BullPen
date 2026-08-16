import { useEffect, useState } from 'react'
import { LABEL, MONO } from '../theme'
import type { Agent } from '../store'

/**
 * What each agent is carrying, and a way to find anything the floor has written.
 *
 * The memory file is read-only: this panel answers "why is it behaving like
 * that", and editing project files belongs in an editor. Search is a plain
 * substring sweep over the board, the activity log and every inbox - there is
 * no index and no embedding model, so it finds exact text and nothing more.
 */
export function Memory({ agents, selected }: { agents: Agent[]; selected: string | null }) {
  const [who, setWho] = useState<string>(selected ?? agents[0]?.id ?? '')
  const [doc, setDoc] = useState<{ name: string; text: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ where: string; text: string }[] | null>(null)

  const agent = agents.find((a) => a.id === who) ?? null

  useEffect(() => {
    if (!agent) return setDoc(null)
    setLoading(true)
    window.bullpen
      .memory(agent.cwd)
      .then(setDoc)
      .finally(() => setLoading(false))
  }, [agent?.id, agent?.cwd])

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
          onKeyDown={(e) => e.key === 'Enter' && search()}
        />
        <button style={S.btn} onClick={search}>
          search
        </button>
      </div>

      {hits !== null && (
        <div style={{ marginBottom: 18 }}>
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
      </div>

      {loading && <div style={S.empty}>Reading…</div>}
      {!loading && !doc && (
        <div style={S.empty}>
          No CLAUDE.md, CLAUDE.local.md or AGENTS.md in {agent?.cwd}. This agent runs on the briefing
          you gave it and nothing else.
        </div>
      )}
      {!loading && doc && <pre style={S.doc}>{doc.text}</pre>}
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: { padding: 14, overflowY: 'auto', height: '100%', font: `12px ${MONO}` },
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
  doc: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    background: 'var(--sunk)',
    border: '1px solid var(--line)',
    padding: 12,
    margin: 0,
    font: `12px ${MONO}`,
    color: 'var(--ink)',
    lineHeight: 1.55
  },
  empty: { color: 'var(--faint)', padding: 18, fontSize: 11, lineHeight: 1.6 }
}
