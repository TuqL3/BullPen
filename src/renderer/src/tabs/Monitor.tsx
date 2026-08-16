import { Avatar } from '../Avatar'
import { CtxMeter } from '../App'
import { LABEL, MONO } from '../theme'
import type { Agent } from '../store'

export const since = (ts: number): string => {
  if (!ts) return '—'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

const DOT: Record<string, string> = {
  working: 'var(--ok)',
  blocked: 'var(--warn)',
  idle: 'var(--faint)',
  exited: 'var(--faint)'
}

/** Compact money, because a fleet figure is read at a glance, not audited here. */
const usd = (n: number): string =>
  n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : '$0'

const tokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

export function Monitor({ agents, lastSeen }: { agents: Agent[]; lastSeen: Record<string, number> }) {
  if (agents.length === 0) return <div style={S.empty}>Nobody on the floor.</div>

  const working = agents.filter((a) => a.status === 'running' && a.activity === 'working').length
  const blocked = agents.filter((a) => a.activity === 'blocked').length
  const costs = agents.map((a) => a.cost).filter(Boolean) as NonNullable<Agent['cost']>[]
  const fleetUsd = costs.reduce((sum, c) => sum + c.usd, 0)
  const fleetTokens = costs.reduce(
    (sum, c) => sum + c.input + c.output + c.cacheRead + c.cacheWrite5m + c.cacheWrite1h,
    0
  )
  const anyUnpriced = costs.some((c) => !c.complete)

  return (
    <div style={S.wrap}>
      <div style={S.summary}>
        <Stat label="hired" value={agents.length} />
        <Stat label="working" value={working} color="var(--ok)" />
        <Stat label="waiting on you" value={blocked} color={blocked ? 'var(--warn)' : undefined} />
        <Stat label="stopped" value={agents.filter((a) => a.status === 'exited').length} />
      </div>

      {costs.length > 0 && (
        <div style={S.spend}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 20, color: 'var(--ink)' }}>{usd(fleetUsd)}</span>
            <span style={{ ...LABEL, color: 'var(--faint)' }}>
              api-equivalent · {tokens(fleetTokens)} tokens ·{' '}
              {costs.reduce((n, c) => n + c.turns, 0)} turns
            </span>
          </div>
          <p style={{ ...S.note, marginTop: 6 }}>
            Priced at published API list rates. On a Claude Max or Pro subscription nothing is
            billed per token, so this is what the same work would have cost on the API — not money
            spent. Cache reads are a tenth of fresh input, which is where the number stays low.
            {anyUnpriced && ' Some tokens ran on a model with no published price and are excluded.'}
          </p>
        </div>
      )}

      {agents.map((a) => {
        const status = a.status === 'exited' ? 'exited' : a.activity
        return (
          <div key={a.id} style={S.row}>
            <Avatar id={a.face} shirt={a.color} size={26} />
            <span style={{ ...LABEL, color: 'var(--ink)', width: 110 }}>{a.name}</span>
            <span style={{ ...S.dot, background: DOT[status] }} />
            <span style={{ width: 70, color: 'var(--muted)' }}>{status}</span>
            <span style={{ width: 90, color: 'var(--muted)' }}>up {since(a.startedAt ?? 0)}</span>
            <span style={{ width: 130, color: 'var(--muted)' }}>
              last output {since(lastSeen[a.id] ?? 0)} ago
            </span>
            <span style={{ width: 210 }}>
              <CtxMeter ctx={a.ctx} />
            </span>
            <span
              style={{ width: 96, color: a.cost ? 'var(--muted)' : 'var(--faint)' }}
              title={
                a.cost
                  ? `in ${a.cost.input} · out ${a.cost.output} · cache read ${a.cost.cacheRead} · ` +
                    `cache write ${a.cost.cacheWrite5m + a.cost.cacheWrite1h}`
                  : 'no completed turn yet'
              }
            >
              {a.cost ? usd(a.cost.usd) : '—'}
            </span>
            <span
              title={a.cwd}
              style={{ flex: 1, color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {a.cwd}
            </span>
          </div>
        )
      })}

      <p style={S.note}>
        Status comes from Claude Code lifecycle hooks, not from guessing at terminal output — an
        agent that goes quiet for a minute while it thinks still reads as working.
      </p>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={S.stat}>
      <div style={{ fontSize: 22, color: color ?? 'var(--ink)' }}>{value}</div>
      <div style={{ ...LABEL, color: 'var(--faint)' }}>{label}</div>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: { padding: 14, overflowY: 'auto', height: '100%', font: `12px ${MONO}` },
  summary: { display: 'flex', gap: 28, padding: '4px 6px 16px' },
  spend: {
    padding: '10px 12px',
    marginBottom: 12,
    background: 'var(--sunk)',
    border: '1px solid var(--line)'
  },
  stat: { minWidth: 90 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '7px 6px',
    borderTop: '1px solid var(--line)'
  },
  dot: { width: 7, height: 7, borderRadius: 7, flex: '0 0 auto' },
  note: { fontSize: 11, color: 'var(--faint)', marginTop: 18, lineHeight: 1.6 },
  empty: { color: 'var(--faint)', padding: 18, fontSize: 11 }
}
