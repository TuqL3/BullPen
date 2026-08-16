import { useEffect, useState } from 'react'
import { LABEL, MONO } from '../theme'
import type { ActivityItem } from '../../../preload/index'

/** One colour per kind, so the stream is scannable without reading every line. */
const KIND_COLOR: Record<string, string> = {
  spawn: 'var(--ok)',
  exit: 'var(--faint)',
  message: 'var(--accent-ink)',
  question: 'var(--warn)',
  answer: 'var(--ok)',
  trust: 'var(--warn)',
  steer: 'var(--accent-ink)',
  trigger: 'var(--accent-ink)',
  approval: 'var(--danger)',
  done: 'var(--ok)',
  dead: 'var(--danger)'
}

/**
 * Everything the floor did, in order.
 *
 * Each of these already had its own IPC channel; a channel per kind cannot
 * answer "what happened, and in what order", which is the only question this
 * view exists for.
 */
export function Activity() {
  const [items, setItems] = useState<ActivityItem[]>([])
  const [filter, setFilter] = useState('')

  useEffect(() => {
    window.bullpen.activity(500).then(setItems)
    return window.bullpen.onActivity((item) => setItems((prev) => [item, ...prev].slice(0, 500)))
  }, [])

  const kinds = [...new Set(items.map((i) => i.kind))].sort()
  const shown = filter ? items.filter((i) => i.kind === filter) : items

  if (items.length === 0)
    return <div style={S.empty}>Nothing yet. Spawning, mail, triggers and approvals all land here.</div>

  return (
    <div style={S.wrap}>
      <div style={S.filters}>
        <button
          style={{ ...S.chip, ...(filter === '' ? S.chipOn : null) }}
          onClick={() => setFilter('')}
        >
          all {items.length}
        </button>
        {kinds.map((k) => (
          <button
            key={k}
            style={{ ...S.chip, ...(filter === k ? S.chipOn : null), color: KIND_COLOR[k] }}
            onClick={() => setFilter(filter === k ? '' : k)}
          >
            {k} {items.filter((i) => i.kind === k).length}
          </button>
        ))}
      </div>

      {shown.map((item) => (
        <div key={item.id} style={S.row}>
          <span style={{ ...LABEL, color: KIND_COLOR[item.kind] ?? 'var(--muted)', width: 74 }}>
            {item.kind}
          </span>
          <span style={{ flex: 1, color: 'var(--ink)', wordBreak: 'break-word' }}>{item.text}</span>
          <span style={{ ...LABEL, color: 'var(--faint)', flex: '0 0 auto' }}>
            {new Date(item.ts).toLocaleTimeString()}
          </span>
        </div>
      ))}
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: { padding: 14, height: '100%', overflowY: 'auto', font: `12px ${MONO}` },
  filters: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  chip: {
    ...LABEL,
    padding: '3px 8px',
    background: 'transparent',
    border: '1px solid var(--line)',
    cursor: 'pointer',
    font: `10px ${MONO}`,
    textTransform: 'uppercase',
    letterSpacing: '0.12em'
  },
  chipOn: { background: 'var(--sunk)', borderColor: 'var(--accent)' },
  row: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    padding: '4px 0',
    borderTop: '1px solid var(--line)'
  },
  empty: { color: 'var(--faint)', padding: 18, fontSize: 11, lineHeight: 1.6 }
}
