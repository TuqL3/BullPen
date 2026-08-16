import { faceFor } from '../avatar'
import { LABEL, MONO } from '../theme'
import type { Agent, MailEvent } from '../store'

/**
 * Who talks to whom, drawn from real mail traffic rather than a declared org
 * chart. Agents sit on a circle; an edge thickens with the number of messages.
 */
export function Graph({ agents, mail }: { agents: Agent[]; mail: MailEvent[] }) {
  if (agents.length === 0) return <div style={S.empty}>Nobody on the floor.</div>

  const size = 420
  const r = 150
  const cx = size / 2
  const cy = size / 2

  const pos = new Map<string, { x: number; y: number }>()
  agents.forEach((a, i) => {
    // Start at the top and go clockwise, so the layout is stable per roster.
    const angle = (i / agents.length) * Math.PI * 2 - Math.PI / 2
    pos.set(a.id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) })
  })

  const edges = new Map<string, number>()
  for (const m of mail) {
    if (!pos.has(m.from) || !pos.has(m.to)) continue
    const key = `${m.from}→${m.to}`
    edges.set(key, (edges.get(key) ?? 0) + 1)
  }

  const busiest = Math.max(1, ...edges.values())

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

        {[...edges.entries()].map(([key, count]) => {
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
              stroke="var(--faint)"
              strokeWidth={1 + (count / busiest) * 3}
              markerEnd="url(#arrow)"
              opacity={0.75}
            />
          )
        })}

        {agents.map((a) => {
          const p = pos.get(a.id)!
          const face = faceFor(a.face, a.color)
          return (
            <g key={a.id}>
              <rect x={p.x - 15} y={p.y - 15} width={30} height={30} fill="var(--sunk)" />
              <g transform={`translate(${p.x - 15}, ${p.y - 15}) scale(2.5)`} shapeRendering="crispEdges">
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
                y={p.y + 28}
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
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: { padding: 14, overflow: 'auto', height: '100%', font: `12px ${MONO}` },
  empty: { color: 'var(--faint)', padding: 18, fontSize: 11 }
}
