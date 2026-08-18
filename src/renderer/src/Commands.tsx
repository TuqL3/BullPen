import { useState } from 'react'
import { catalogFor, SHARED, type Entry, type Group } from './catalog'
import { LABEL, MONO } from './theme'
import type { Agent } from './store'

/**
 * The commands the selected agent understands.
 *
 * Per agent, not per app: what you can type depends on the CLI behind that
 * terminal. Bullpen's own protocol is files, so it is listed for every agent.
 */
export function Commands({ agent }: { agent: Agent | null }) {
  const [copied, setCopied] = useState('')
  const [q, setQ] = useState('')

  const copy = async (cmd: string): Promise<void> => {
    await navigator.clipboard.writeText(cmd)
    setCopied(cmd)
    setTimeout(() => setCopied(''), 1200)
  }

  const catalog = catalogFor(agent?.cli ?? 'claude')
  const groups: Group[] = [...(catalog?.groups ?? []), SHARED]
  const needle = q.trim().toLowerCase()
  const shown = groups
    .map((g) => ({
      ...g,
      entries: g.entries.filter(
        (e) => !needle || `${e.cmd} ${e.desc}`.toLowerCase().includes(needle)
      )
    }))
    .filter((g) => g.entries.length > 0)
  const total = shown.reduce((n, g) => n + g.entries.length, 0)

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <input
          style={S.input}
          value={q}
          placeholder="filter commands"
          onChange={(e) => setQ(e.target.value)}
        />
        <span style={{ ...LABEL, color: 'var(--faint)' }}>{total}</span>
      </div>

      <div style={{ ...LABEL, color: 'var(--faint)', marginBottom: 12 }}>
        {catalog ? (
          <>
            {agent ? `${agent.name} runs ` : ''}
            <span style={{ color: 'var(--accent-ink)' }}>{catalog.label}</span> · {catalog.source} ·
            click to copy
          </>
        ) : (
          <>
            No command list for <span style={{ color: 'var(--warn)' }}>{agent?.cli}</span> yet - only
            Bullpen&apos;s own protocol, which works from any CLI.
          </>
        )}
      </div>

      {shown.map((g) => (
        <div key={g.title} style={{ marginBottom: 20 }}>
          <div style={{ ...LABEL, color: 'var(--faint)', marginBottom: 6 }}>{g.title}</div>
          {g.entries.map((e) => (
            <Row key={e.cmd} entry={e} copied={copied === e.cmd} onCopy={() => copy(e.cmd)} />
          ))}
        </div>
      ))}

      {total === 0 && <div style={S.empty}>Nothing matches “{q}”.</div>}
    </div>
  )
}

function Row({
  entry,
  copied,
  onCopy
}: {
  entry: Entry
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div onClick={onCopy} style={S.row}>
      <span>
        <div style={S.cmd}>{entry.cmd}</div>
        <div style={S.desc}>{entry.desc}</div>
        {entry.eg && <div style={S.eg}>e.g. {entry.eg}</div>}
      </span>
      <span style={{ ...LABEL, color: copied ? 'var(--ok)' : 'var(--faint)' }}>
        {copied ? 'copied' : 'copy'}
      </span>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: { padding: '14px 18px', overflowY: 'auto', height: '100%' },
  head: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
  input: {
    flex: 1,
    padding: '6px 9px',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    outline: 'none',
    font: `12px ${MONO}`
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: 12,
    alignItems: 'baseline',
    padding: '7px 0',
    borderTop: '1px solid var(--line)',
    cursor: 'pointer'
  },
  cmd: { font: `13px ${MONO}`, color: 'var(--ink)', wordBreak: 'break-all' },
  desc: { fontSize: 12, color: 'var(--muted)', marginTop: 3 },
  eg: { fontSize: 11, color: 'var(--faint)', marginTop: 3, fontStyle: 'italic' },
  empty: { color: 'var(--faint)', font: `12px ${MONO}` }
}
