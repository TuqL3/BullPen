import { faceFor } from '../roster'
import { LABEL, MONO } from '../theme'
import type { Agent, MailEvent } from '../store'
import { dispatchAgent } from '../shape'

/**
 * Who talks to whom, drawn from real mail traffic rather than a declared org
 * chart. Agents sit on a circle; an edge thickens with the number of messages.
 */
/**
 * Edge kinds, inferred from the subject line. Traffic is not all the same: a
 * request and a completion mean opposite things, and colouring them alike makes
 * the graph decorative rather than readable.
 */
const KINDS: { key: string; label: string; colour: string; test: RegExp }[] = [
  { key: 'request', label: 'request', colour: '#c98a4b', test: /\b(please|can you|do |run |fix |build)/i },
  { key: 'query', label: 'query', colour: '#4b8ac9', test: /\?|\b(what|why|how|which|status)\b/i },
  { key: 'propose', label: 'propose', colour: '#8a6bc9', test: /\b(propose|suggest|plan|draft)\b/i },
  { key: 'agree', label: 'agree/done', colour: '#4bb377', test: /\b(done|agreed|ok|shipped|merged|answer)\b/i },
  { key: 'refuse', label: 'refuse', colour: '#c95b5b', test: /\b(cannot|refuse|blocked|denied|failed)\b/i }
]

const kindOf = (subject: string): (typeof KINDS)[number] =>
  KINDS.find((k) => k.test.test(subject)) ?? { key: 'inform', label: 'inform', colour: '#8b90a0', test: /./ }

export function Graph({ agents, mail }: { agents: Agent[]; mail: MailEvent[] }) {
  if (agents.length === 0) return <div style={S.empty}>Nobody on the floor.</div>

  const size = 460
  const r = 165
  const cx = size / 2
  const cy = size / 2

  // Whoever a task is dispatched to sits at the centre; everyone else rings
  // them. That is the actual shape of the floor - work arrives through one
  // agent, and which one is the workflow's answer, not this file's.
  const god = dispatchAgent(agents)
  const ring = agents.filter((a) => a.id !== god?.id)

  const pos = new Map<string, { x: number; y: number }>()
  if (god) pos.set(god.id, { x: cx, y: cy })
  ring.forEach((a, i) => {
    const angle = (i / Math.max(1, ring.length)) * Math.PI * 2 - Math.PI / 2
    pos.set(a.id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) })
  })

  const edges = new Map<string, { count: number; colour: string }>()
  for (const m of mail) {
    if (!pos.has(m.from) || !pos.has(m.to)) continue
    const key = `${m.from}→${m.to}`
    const prev = edges.get(key)
    edges.set(key, { count: (prev?.count ?? 0) + 1, colour: kindOf(m.subject).colour })
  }

  const busiest = Math.max(1, ...[...edges.values()].map((e) => e.count))

  return (
    <div style={S.wrap}>
      <div style={{ ...LABEL, marginBottom: 10 }}>
        {edges.size === 0
          ? 'No mail yet — the graph fills in as agents write to each other.'
          : `${edges.size} route${edges.size === 1 ? '' : 's'} across ${mail.length} message${mail.length === 1 ? '' : 's'}`}
      </div>

      <svg width={size} height={size} style={{ display: 'block' }}>
        <defs>
          <marker id="arrow" markerWidth="7" markerHeight="7" refX="7" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7 z" fill="var(--faint)" />
          </marker>
        </defs>

        {[...edges.entries()].map(([key, edge]) => {
          const [from, to] = key.split('→')
          const a = pos.get(from)!
          const b = pos.get(to)!
          // Stop short of the node so the arrowhead is not hidden under it.
          const dx = b.x - a.x
          const dy = b.y - a.y
          const len = Math.hypot(dx, dy) || 1
          const trim = 22
          return (
            <line
              key={key}
              x1={a.x + (dx / len) * trim}
              y1={a.y + (dy / len) * trim}
              x2={b.x - (dx / len) * trim}
              y2={b.y - (dy / len) * trim}
              stroke={edge.colour}
              strokeWidth={1 + (edge.count / busiest) * 3}
              markerEnd="url(#arrow)"
              opacity={0.8}
            />
          )
        })}

        {agents.map((a) => {
          const p = pos.get(a.id)
          if (!p) return null
          const face = faceFor(a.face, a.color)
          const isGod = a.id === god?.id
          const half = isGod ? 21 : 15
          return (
            <g key={a.id}>
              <rect
                x={p.x - half}
                y={p.y - half}
                width={half * 2}
                height={half * 2}
                fill={isGod ? 'var(--accent)' : 'var(--sunk)'}
                stroke={isGod ? 'var(--accent-ink)' : 'var(--line)'}
              />
              <g
                transform={`translate(${p.x - half + 3}, ${p.y - half + 3}) scale(${(half * 2 - 6) / 12})`}
                shapeRendering="crispEdges"
              >
                {face.grid.map((row, y) =>
                  [...row].map((ch, x) =>
                    ch === '.' ? null : (
                      <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={face.colors[ch]} />
                    )
                  )
                )}
              </g>
              <text
                x={p.x}
                y={p.y + half + 13}
                textAnchor="middle"
                fill="var(--muted)"
                style={{ font: `10px ${MONO}` }}
              >
                {a.name}
              </text>
            </g>
          )
        })}
      </svg>

      <div style={S.legend}>
        {[...KINDS, { key: 'inform', label: 'inform', colour: '#8b90a0', test: /./ }].map((k) => (
          <span key={k.key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 14, height: 2, background: k.colour }} />
            <span style={{ ...LABEL, color: 'var(--faint)' }}>{k.label}</span>
          </span>
        ))}
      </div>
      <p style={S.note}>
        Edge kind is inferred from the subject line, not declared by the agents — a heuristic, so
        read it as a hint rather than a protocol.
      </p>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: { padding: 14, overflow: 'auto', height: '100%', font: `12px ${MONO}` },
  legend: { display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 10 },
  note: { fontSize: 11, color: 'var(--faint)', marginTop: 8, lineHeight: 1.6 },
  empty: { color: 'var(--faint)', padding: 18, fontSize: 11 }
}
