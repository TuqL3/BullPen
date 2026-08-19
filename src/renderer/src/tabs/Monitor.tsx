import { useEffect, useState } from 'react'
import { Avatar } from '../Avatar'
import { CtxMeter } from '../App'
import { onEnter } from '../keys'
import { LABEL, MONO } from '../theme'
import { ago, isQuiet, summarise } from '../fleet'
import type { Dispatch, Report } from '../../../preload/index'
import type { Agent } from '../store'
import {
  anyoneChecks,
  assignerAgent,
  dispatchAgent,
  isCore,
  roleLabel,
  rolesWith,
  roleTag
} from '../shape'

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
  report,
  dispatched,
  onSelect,
  onOpenTerminal
}: {
  agents: Agent[]
  lastSeen: Record<string, number>
  /** Where the work stands. Shown here and nowhere else - it is not a question. */
  report: Report | null
  /** The brief the operator handed over, as they wrote it. */
  dispatched: Dispatch | null
  /** Waiting agent picked: goes to ask me, where every question is collected. */
  onSelect: (id: string) => void
  onOpenTerminal: (id: string) => void
}) {
  const [brief, setBrief] = useState('')
  const [owner, setOwner] = useState('decide')
  const [project, setProject] = useState('')
  const [sent, setSent] = useState('')
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

  // Where a dispatched task is typed, and who it is handed to from there.
  // Both are the workflow's answer: a floor whose boss assigns directly has
  // nobody in the second seat, and `assignerAgent` says so with undefined.
  const god = dispatchAgent(agents)
  const ba = assignerAgent(agents)

  const send = async (): Promise<void> => {
    if (!brief.trim()) return
    const err = await window.bullpen.dispatch(brief.trim(), owner, project)
    setSent(err ?? `handed to ${god?.name}${ba ? ` — passed on to ${ba.name}` : ''}`)
    if (!err) setBrief('')
  }

  if (agents.length === 0) return <div style={S.empty}>Nobody on the floor.</div>

  const startedAt = Object.fromEntries(agents.map((a) => [a.id, a.startedAt ?? 0]))
  const sum = summarise(agents, lastSeen, startedAt, now)
  const asking = agents.filter((a) => a.asked)

  const costs = agents.map((a) => a.cost).filter(Boolean) as NonNullable<Agent['cost']>[]
  const fleetUsd = costs.reduce((sum, c) => sum + c.usd, 0)
  const fleetTokens = costs.reduce(
    (n, c) => n + c.input + c.output + c.cacheRead + c.cacheWrite5m + c.cacheWrite1h,
    0
  )
  const anyUnpriced = costs.some((c) => !c.complete)
  const projects = [
    ...new Set(
      agents
        .filter((a) => !isCore(a.role))
        .map((a) => a.project)
        .filter(Boolean)
    )
  ]

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

      {dispatched && (
        <div style={S.sent}>
          <span style={{ ...LABEL, color: 'var(--muted)' }}>
            you dispatched · {ago(dispatched.ts, now)} ago
            {dispatched.project ? ` · ${dispatched.project}` : ''}
            {dispatched.owner && dispatched.owner !== 'decide' ? ` · for ${dispatched.owner}` : ''}
          </span>
          <pre style={S.sentBody}>{dispatched.text}</pre>
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
                  {roleTag(a.role) && (
                    <span
                      style={{ color: isCore(a.role) ? 'var(--accent-ink)' : 'var(--muted)' }}
                    >
                      {' '}
                      ({roleTag(a.role)})
                    </span>
                  )}
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

              {/* Two different questions, both worth an answer: what it was sent
                  to do, and what it is touching right now. "working" for four
                  minutes says neither. */}
              <div style={S.doing} title={a.doing ? `${a.doing.tool} · ${a.doing.detail}` : ''}>
                {a.task && (
                  <div style={S.task} title={a.task.text}>
                    {a.task.text}
                  </div>
                )}
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

      {/* Pinned and open: it is the one control on this tab, and behind a
          disclosure it was a tab you had to remember had a control on it. */}
      <div style={S.dispatch}>
        <span style={S.disclose}>
          dispatch {god ? `— to ${god.name}` : '— no clone of you yet'}
        </span>
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
            {/* What the empty choice means, said as what happens: the box is
                addressed to whoever takes dispatch, so naming the one who
                assigns read as if the task went there instead. */}
            <option value="decide">
              {ba ? `no suggestion — ${ba.name} picks` : god ? `no suggestion — ${god.name} picks` : 'no suggestion'}
            </option>
            {agents
              .filter((a) => !isCore(a.role))
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
              ? `Describe the task — ${god.name} ${ba ? `hands it to ${ba.name}, who assigns it` : 'assigns it'}`
              : 'Create a clone of yourself first: tick "This one is me" in the add-agent wizard.'
          }
          onChange={(e) => setBrief(e.target.value)}
          // Enter sends, shift+Enter is a new line: this is a box you type one
          // sentence into and hand over, not a document. The IME guard is in
          // `onEnter` - the Enter that accepts a Vietnamese candidate is not a
          // send.
          onKeyDown={onEnter((e) => {
            // Shift+Enter is still a new line: a brief can be more than one.
            if (e.shiftKey) return
            e.preventDefault()
            send()
          })}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            style={{ ...S.btn, opacity: god && brief.trim() ? 1 : 0.5 }}
            onClick={send}
          >
            dispatch
          </button>
          {sent && <span style={{ ...LABEL, color: 'var(--muted)' }}>{sent}</span>}
        </div>
        {/* What happens next is the workflow's, not this panel's: it is read
            back out of the running one so a floor with no analyst, or no
            tester, is not described as having them. */}
        <p style={{ ...S.note, marginTop: 8 }}>
          Dispatch types the brief into {god?.name ?? 'the floor'}&apos;s own prompt.{' '}
          {ba
            ? `${ba.name} decides the breakdown and puts people on it`
            : `${god?.name ?? 'They'} puts people on it`}
          {anyoneChecks() ? `, and ${roleLabel(rolesWith('checks')[0])} decides when it is done` : ''}.
          When the floor next falls quiet, whoever it comes back through is asked where things
          stand, and it reaches you above — ask me is for questions that are waiting on an answer.
        </p>
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
  // The brief, not the orders around it: a left rule rather than a box, so it
  // reads as the thing that started the round rather than a second report.
  // One line, cut with an ellipsis: the whole brief is on the row's title, and
  // a monitor whose rows are four lines tall stops being a table.
  task: {
    color: 'var(--muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    marginBottom: 2
  },
  sent: {
    padding: '8px 12px',
    marginBottom: 10,
    background: 'var(--panel)',
    borderLeft: '3px solid var(--accent)'
  },
  sentBody: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 120,
    overflow: 'auto',
    margin: '6px 0 0',
    font: `12px ${MONO}`,
    color: 'var(--ink)'
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
    display: 'block',
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
