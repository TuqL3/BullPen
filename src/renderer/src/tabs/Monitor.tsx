import { useEffect, useState } from 'react'
import { Avatar } from '../Avatar'
import { CtxMeter } from '../App'
import { LABEL, MONO } from '../theme'
import { ago, isQuiet, summarise } from '../fleet'
import type { Question } from '../../../preload/index'
import type { Agent } from '../store'

/** Kept exported: the workers tab formats uptime the same way. */
export const since = (ts: number): string => ago(ts, Date.now())

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

/**
 * The floor at a glance, and the handles to act on it.
 *
 * Ordered by how often it is read, not by how the code grew: what needs a human
 * first, then everyone's state, then what it cost, and the dispatch box last -
 * it is used a few times a day and used to push the roster off the screen.
 */
export function Monitor({
  agents,
  lastSeen,
  questions,
  onSelect,
  onOpenTerminal
}: {
  agents: Agent[]
  lastSeen: Record<string, number>
  /** Everything addressed to you; the newest from the god agent is the report. */
  questions: Question[]
  /** Waiting agent picked: goes to ask me, where every question is collected. */
  onSelect: (id: string) => void
  onOpenTerminal: (id: string) => void
}) {
  const [brief, setBrief] = useState('')
  const [owner, setOwner] = useState('decide')
  const [project, setProject] = useState('')
  const [sent, setSent] = useState('')
  const [showDispatch, setShowDispatch] = useState(false)
  const [confirmKill, setConfirmKill] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  // Everything on this tab is an elapsed time, and elapsed times do not change
  // when the store does - they change when the clock does. Without this an
  // agent that went silent still read "last output 4s ago" indefinitely.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const god = agents.find((a) => a.role === 'god')

  if (agents.length === 0) return <div style={S.empty}>Nobody on the floor.</div>

  const startedAt = Object.fromEntries(agents.map((a) => [a.id, a.startedAt ?? 0]))
  const sum = summarise(agents, lastSeen, startedAt, now)
  const asking = agents.filter((a) => a.asked)
  // Michael's progress report arrives as an ordinary question addressed to you,
  // so it is already in ask me; this is the newest one he sent.
  const report = questions.filter((q) => q.from === god?.id).at(-1)

  const costs = agents.map((a) => a.cost).filter(Boolean) as NonNullable<Agent['cost']>[]
  const fleetUsd = costs.reduce((sum, c) => sum + c.usd, 0)
  const fleetTokens = costs.reduce(
    (n, c) => n + c.input + c.output + c.cacheRead + c.cacheWrite5m + c.cacheWrite1h,
    0
  )
  const anyUnpriced = costs.some((c) => !c.complete)
  const projects = [...new Set(agents.filter((a) => a.role !== 'god').map((a) => a.project).filter(Boolean))]

  return (
    <div style={S.wrap}>
      <div style={S.scroll}>
      <div style={S.summary}>
        <span style={{ ...LABEL, color: 'var(--ink)' }}>{sum.hired} on the floor</span>
        <Count n={sum.working} label="working" color="var(--ok)" />
        <Count n={sum.waiting} label="waiting on you" color="var(--warn)" />
        <Count n={sum.quiet} label="gone quiet" color="var(--danger)" />
        <Count n={sum.stopped} label="stopped" />
      </div>

      {/* The question itself, not just a count: an agent stopped on one is the
          only thing here that cannot make progress without you. */}
      {asking.length > 0 && (
        <div style={S.asking}>
          <div style={{ ...LABEL, color: 'var(--warn)' }}>waiting on you</div>
          {asking.map((a) => (
            <button key={a.id} style={S.askRow} onClick={() => onSelect(a.id)}>
              <Avatar id={a.face} shirt={a.color} size={26} />
              <div style={{ minWidth: 0, textAlign: 'left' }}>
                <div style={{ ...LABEL, color: 'var(--ink)' }}>{a.name}</div>
                <div style={{ color: 'var(--ink)' }}>{a.asked}</div>
                <div style={{ color: 'var(--faint)' }}>click to open it in ask me</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {report && (
        <div style={S.report}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ ...LABEL, color: 'var(--accent-ink)' }}>
              latest report · {god?.name ?? report.from}
              {report.ts ? ` · ${ago(report.ts, now)} ago` : ''}
            </span>
            <span style={{ flex: 1 }} />
            <button style={S.disclose} onClick={() => setExpanded(!expanded)}>
              {expanded ? 'collapse' : 'expand'}
            </button>
          </div>
          <pre style={{ ...S.reportBody, maxHeight: expanded ? 'none' : 340 }}>{report.body}</pre>
        </div>
      )}

      <div style={S.table}>
        {agents.map((a) => {
          const status = a.status === 'exited' ? 'exited' : a.activity
          const quiet = isQuiet(a, lastSeen[a.id] ?? 0, a.startedAt ?? 0, now)
          const killing = confirmKill === a.id
          return (
            <div
              key={a.id}
              style={{ ...S.row, ...(quiet ? S.rowQuiet : null) }}
              onClick={() => onOpenTerminal(a.id)}
              title="open this agent's terminal"
            >
              <Avatar id={a.face} shirt={a.color} size={26} />
              <div style={S.who}>
                <div style={{ ...LABEL, color: 'var(--ink)' }}>
                  {a.name}
                  {a.role === 'god' && <span style={{ color: 'var(--accent-ink)' }}> (god)</span>}
                </div>
                <div style={{ color: 'var(--faint)' }} title={a.cwd}>
                  {a.project || a.cwd.split('/').filter(Boolean).pop() || a.cwd}
                </div>
              </div>

              <div style={S.state}>
                <span style={{ ...S.dot, background: quiet ? 'var(--danger)' : DOT[status] }} />
                <span style={{ color: 'var(--muted)' }}>{status}</span>
                {quiet && <span style={{ color: 'var(--danger)' }}>quiet</span>}
              </div>

              {/* "working" for four minutes says nothing; the last tool does. */}
              <div style={S.doing} title={a.doing ? `${a.doing.tool} · ${a.doing.detail}` : ''}>
                {a.doing ? (
                  <>
                    <span style={{ color: 'var(--ink)' }}>{a.doing.tool}</span>{' '}
                    <span style={{ color: 'var(--faint)' }}>{a.doing.detail}</span>
                  </>
                ) : (
                  <span style={{ color: 'var(--faint)' }}>no tool call yet</span>
                )}
              </div>

              <div style={S.times}>
                <div style={{ color: 'var(--muted)' }}>up {ago(a.startedAt ?? 0, now)}</div>
                <div style={{ color: quiet ? 'var(--danger)' : 'var(--faint)' }}>
                  quiet {ago(lastSeen[a.id] ?? a.startedAt ?? 0, now)}
                </div>
              </div>

              <div style={S.meter}>
                <CtxMeter ctx={a.ctx} compact />
              </div>

              <div
                style={{ ...S.money, color: a.cost ? 'var(--muted)' : 'var(--faint)' }}
                title={
                  a.cost
                    ? `in ${a.cost.input} · out ${a.cost.output} · cache read ${a.cost.cacheRead} · ` +
                      `cache write ${a.cost.cacheWrite5m + a.cost.cacheWrite1h}`
                    : 'no completed turn yet'
                }
              >
                {a.cost ? usd(a.cost.usd) : '—'}
              </div>

              {/* stopPropagation: the row itself opens the terminal. */}
              <div style={S.actions} onClick={(e) => e.stopPropagation()}>
                {a.asked && (
                  <button style={S.rowBtn} onClick={() => onSelect(a.id)}>
                    answer
                  </button>
                )}
                {a.status === 'running' && (
                  <button
                    style={{ ...S.rowBtn, ...(killing ? S.rowBtnDanger : null) }}
                    onClick={() => {
                      if (!killing) return setConfirmKill(a.id)
                      setConfirmKill(null)
                      window.bullpen.kill(a.id)
                    }}
                    onBlur={() => setConfirmKill((c) => (c === a.id ? null : c))}
                    title="stop this agent - its turn is lost"
                  >
                    {killing ? 'sure?' : 'stop'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {costs.length > 0 && (
        <div style={S.spend}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 18, color: 'var(--ink)' }}>{usd(fleetUsd)}</span>
            <span style={{ ...LABEL, color: 'var(--faint)' }}>
              api-equivalent · {tokens(fleetTokens)} tokens ·{' '}
              {costs.reduce((n, c) => n + c.turns, 0)} turns
            </span>
          </div>
          <p style={{ ...S.note, marginTop: 6 }}>
            Priced at published API list rates. On a Claude Max or Pro subscription nothing is
            billed per token, so this is what the same work would have cost on the API — not money
            spent.
            {anyUnpriced && ' Some tokens ran on a model with no published price and are excluded.'}
          </p>
        </div>
      )}

      <p style={S.note}>
        Status comes from Claude Code lifecycle hooks, not from guessing at terminal output — an
        agent that goes quiet for a minute while it thinks still reads as working. &quot;Quiet&quot;
        means three minutes with no output at all, which is worth a look, not proof of a hang.
      </p>
      </div>

      {/* Pinned: it is the one control on this tab, and in the flow it either
          sat above what you read or scrolled off the end of it. */}
      <div style={S.dispatch}>
        <button style={S.disclose} onClick={() => setShowDispatch(!showDispatch)}>
          {showDispatch ? '▾' : '▸'} dispatch {god ? `— via ${god.name}` : '— no clone of you yet'}
        </button>
        {showDispatch && (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
              <span style={{ ...LABEL, color: 'var(--faint)' }}>project</span>
              <select style={S.select} value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">any</option>
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <span style={{ ...LABEL, color: 'var(--faint)' }}>suggested owner</span>
              <select style={S.select} value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="decide">{god ? `${god.name} decides` : 'decide'}</option>
                {agents
                  .filter((a) => a.role !== 'god')
                  .map((a) => (
                    <option key={a.id} value={a.name}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </div>
            <textarea
              style={S.brief}
              rows={2}
              value={brief}
              placeholder={
                god
                  ? `Describe the task — ${god.name} decomposes it and assigns`
                  : 'Create a clone of yourself first: tick "This one is me" in the add-agent wizard.'
              }
              onChange={(e) => setBrief(e.target.value)}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                style={{ ...S.btn, opacity: god && brief.trim() ? 1 : 0.5 }}
                onClick={async () => {
                  if (!brief.trim()) return
                  const err = await window.bullpen.dispatch(brief.trim(), owner, project)
                  setSent(err ?? `handed to ${god?.name}`)
                  if (!err) setBrief('')
                }}
              >
                dispatch
              </button>
              {sent && <span style={{ ...LABEL, color: 'var(--muted)' }}>{sent}</span>}
            </div>
            <p style={{ ...S.note, marginTop: 8 }}>
              Dispatch types the brief into your clone&apos;s own prompt. It decides the breakdown
              and the assignment. When the floor next falls quiet it is asked for a progress report,
              which arrives above and in ask me.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function Count({ n, label, color }: { n: number; label: string; color?: string }) {
  return (
    <span style={{ ...LABEL, color: n ? (color ?? 'var(--muted)') : 'var(--faint)' }}>
      {n} {label}
    </span>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: { height: '100%', display: 'flex', flexDirection: 'column', font: `12px ${MONO}` },
  scroll: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 },
  summary: { display: 'flex', flexWrap: 'wrap', gap: 18, padding: '2px 4px 12px' },
  asking: {
    padding: '10px 12px',
    marginBottom: 12,
    background: 'var(--panel)',
    border: '1px solid var(--warn)'
  },
  askRow: {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    width: '100%',
    marginTop: 8,
    padding: 8,
    background: 'var(--sunk)',
    border: '1px solid var(--line)',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer'
  },
  report: {
    padding: '10px 12px',
    marginBottom: 12,
    background: 'var(--panel)',
    border: '1px solid var(--line)'
  },
  reportBody: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 340,
    overflow: 'auto',
    margin: '8px 0 0',
    font: `12px ${MONO}`,
    lineHeight: 1.55,
    color: 'var(--ink)'
  },
  table: { border: '1px solid var(--line)', background: 'var(--panel)', marginBottom: 12 },
  row: {
    display: 'grid',
    // Fixed only where a number has a known width; the two text cells take the
    // slack, so a narrow window squeezes them instead of overflowing the panel.
    gridTemplateColumns: '26px minmax(90px, 1fr) 84px minmax(120px, 2fr) 104px 132px 58px 92px',
    gap: 10,
    alignItems: 'center',
    padding: '7px 10px',
    borderBottom: '1px solid var(--line)',
    cursor: 'pointer'
  },
  rowQuiet: { background: 'color-mix(in srgb, var(--danger) 10%, transparent)' },
  who: { minWidth: 0, overflow: 'hidden' },
  state: { display: 'flex', alignItems: 'center', gap: 6 },
  doing: { minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' },
  times: { lineHeight: 1.4 },
  meter: { minWidth: 0 },
  money: { textAlign: 'right' },
  actions: { display: 'flex', gap: 6, justifyContent: 'flex-end' },
  rowBtn: {
    padding: '3px 8px',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid',
    borderColor: 'var(--line)',
    cursor: 'pointer',
    font: `10px ${MONO}`
  },
  rowBtnDanger: { color: 'var(--danger)', borderColor: 'var(--danger)' },
  dot: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto' },
  spend: {
    padding: '10px 12px',
    marginBottom: 12,
    background: 'var(--panel)',
    border: '1px solid var(--line)'
  },
  dispatch: {
    flex: '0 0 auto',
    maxHeight: '60%',
    overflowY: 'auto',
    padding: '8px 14px 12px',
    background: 'var(--panel)',
    borderTop: '1px solid var(--line)'
  },
  disclose: {
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    color: 'var(--ink)',
    font: `11px ${MONO}`,
    textTransform: 'uppercase',
    letterSpacing: '0.14em'
  },
  brief: {
    width: '100%',
    boxSizing: 'border-box',
    resize: 'vertical',
    padding: 8,
    marginBottom: 8,
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    font: `12px ${MONO}`
  },
  select: {
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    font: `11px ${MONO}`,
    padding: '3px 6px'
  },
  btn: {
    padding: '6px 12px',
    background: 'var(--accent)',
    color: '#241f1a',
    border: '1px solid var(--accent)',
    cursor: 'pointer',
    font: `11px ${MONO}`
  },
  note: { fontSize: 11, color: 'var(--faint)', lineHeight: 1.6 },
  empty: { color: 'var(--faint)', padding: 18, fontSize: 11, lineHeight: 1.7 }
}
