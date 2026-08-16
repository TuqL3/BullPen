import { useEffect, useState } from 'react'
import { LABEL, MONO } from '../theme'
import type { Agent } from '../store'

/**
 * The standing instructions an agent carries into every turn. Read-only: this
 * panel exists to answer "why is it behaving like that", and editing project
 * files belongs in an editor.
 */
export function Memory({ agent }: { agent: Agent | null }) {
  const [doc, setDoc] = useState<{ name: string; text: string } | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!agent) return setDoc(null)
    setLoading(true)
    window.bullpen
      .memory(agent.cwd)
      .then(setDoc)
      .finally(() => setLoading(false))
  }, [agent?.id, agent?.cwd])

  if (!agent) return <div style={S.empty}>Pick an agent to see what it was told.</div>
  if (loading) return <div style={S.empty}>Reading…</div>

  if (!doc)
    return (
      <div style={S.wrap}>
        <div style={S.empty}>
          No CLAUDE.md, CLAUDE.local.md or AGENTS.md in {agent.cwd}. This agent is running on the
          briefing you gave it and nothing else.
        </div>
      </div>
    )

  return (
    <div style={S.wrap}>
      <div style={{ ...LABEL, marginBottom: 4 }}>
        {doc.name} · {agent.cwd}
      </div>
      <div style={{ ...LABEL, color: 'var(--faint)', marginBottom: 10 }}>
        {doc.text.split('\n').length} lines · loaded into every turn
      </div>
      <pre style={S.doc}>{doc.text}</pre>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: { padding: 14, overflowY: 'auto', height: '100%', font: `12px ${MONO}` },
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
