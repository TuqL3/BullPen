import { useEffect, useState } from 'react'
import { onEnter } from '../keys'
import { LABEL, MONO } from '../theme'
import type { Agent } from '../store'

type Trigger = {
  id: string
  agentId: string
  prompt: string
  everyMinutes: number
  enabled: boolean
  lastRun: number
}

/** Scheduled prompts. Every one of these costs tokens on a schedule, so the UI
 *  says so rather than letting someone set a 1-minute heartbeat by accident. */
export function Triggers({ agent }: { agent: Agent | null }) {
  const [triggers, setTriggers] = useState<Trigger[]>([])
  const [prompt, setPrompt] = useState('')
  const [mins, setMins] = useState('60')
  const [error, setError] = useState('')

  const refresh = (): void => {
    if (!agent) return setTriggers([])
    window.bullpen.triggers(agent.id).then(setTriggers)
  }
  useEffect(refresh, [agent?.id])

  if (!agent) return <div style={S.empty}>Pick an agent to schedule work for it.</div>

  const add = async (): Promise<void> => {
    const n = Number(mins)
    if (!prompt.trim()) return setError('A trigger needs a prompt.')
    if (!Number.isFinite(n) || n < 1) return setError('Interval must be at least 1 minute.')
    const made = await window.bullpen.addTrigger(agent.id, prompt.trim(), n)
    if (!made) return setError('Rejected — check the prompt and interval.')
    setPrompt('')
    setError('')
    refresh()
  }

  return (
    <div style={S.wrap}>
      <div style={{ ...LABEL, color: 'var(--faint)', marginBottom: 12 }}>
        Everything that can start work without you typing.
      </div>

      <div style={{ ...S.sectionHead, marginTop: 0 }}>
        <span style={{ ...LABEL, color: 'var(--ink)' }}>schedules</span>
        <span style={{ fontSize: 11, color: 'var(--muted)', flex: 1 }}>
          Run a prompt on a repeating clock.
        </span>
        <span style={{ ...LABEL, color: 'var(--faint)' }}>
          {triggers.filter((t) => t.enabled).length} of {triggers.length} on
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
        <input
          style={S.input}
          value={prompt}
          placeholder={`sent to ${agent.name} on a schedule`}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onEnter(add)}
        />
        <input
          style={{ ...S.input, flex: '0 0 70px', textAlign: 'right' }}
          value={mins}
          onChange={(e) => setMins(e.target.value)}
        />
        <span style={{ ...LABEL, alignSelf: 'center' }}>min</span>
        <button style={S.btn} onClick={add}>
          add
        </button>
      </div>
      {error && <div style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 8 }}>{error}</div>}

      {triggers.length === 0 && <div style={S.empty}>No triggers. This agent runs only when asked.</div>}

      {triggers.map((t) => (
        <div key={t.id} style={S.row}>
          <span
            style={{ ...S.pill, ...(t.enabled ? S.pillOn : null) }}
            onClick={async () => {
              await window.bullpen.toggleTrigger(t.id)
              refresh()
            }}
          >
            {t.enabled ? 'on' : 'off'}
          </span>
          <span style={{ width: 92, color: 'var(--muted)' }}>every {t.everyMinutes}m</span>
          <span style={{ width: 96, color: 'var(--faint)', fontSize: 10 }}>
            {t.enabled
              ? `next in ${Math.max(0, Math.ceil((t.lastRun + t.everyMinutes * 60_000 - Date.now()) / 60_000))}m`
              : 'paused'}
          </span>
          <span style={{ flex: 1, color: t.enabled ? 'var(--ink)' : 'var(--faint)' }}>{t.prompt}</span>
          <span style={{ width: 120, color: 'var(--faint)', fontSize: 11 }}>
            {t.lastRun ? `last ${new Date(t.lastRun).toLocaleTimeString()}` : 'not run yet'}
          </span>
          <button
            style={S.linkBtn}
            onClick={async () => {
              await window.bullpen.removeTrigger(t.id)
              refresh()
            }}
          >
            ×
          </button>
        </div>
      ))}

      <p style={S.note}>
        Triggers fire only at an idle agent — dropping a scheduled prompt into a turn in progress
        would corrupt whatever it was doing. Each firing is a real turn against your subscription,
        so an hourly trigger is 24 turns a day whether or not there was anything to do.
      </p>

      {/* Named because they are the other ways work can start, and saying "not
          built" is more useful than leaving the reader to wonder. */}
      <Stub
        title="context"
        blurb="Compact or clear an agent as its context fills."
        state="not built — watch the ctx meter and use /compact"
      />
      <Stub
        title="webhooks"
        blurb="Let an outside system post work in."
        state="not built — no inbound HTTP surface exists"
      />
      <Stub
        title="organisation"
        blurb="Let a teammate's Bullpen message yours."
        state="not built — the hive is local to this machine"
      />
    </div>
  )
}

function Stub({ title, blurb, state }: { title: string; blurb: string; state: string }) {
  return (
    <div style={S.sectionHead}>
      <span style={{ ...LABEL, color: 'var(--muted)' }}>{title}</span>
      <span style={{ fontSize: 11, color: 'var(--faint)', flex: 1 }}>{blurb}</span>
      <span style={{ ...LABEL, color: 'var(--faint)' }}>{state}</span>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: { padding: 14, overflowY: 'auto', height: '100%', font: `12px ${MONO}` },
  sectionHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    marginTop: 16,
    padding: '8px 10px',
    background: 'var(--sunk)',
    border: '1px solid var(--line)'
  },
  input: {
    flex: 1,
    padding: '6px 9px',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    font: `12px ${MONO}`
  },
  btn: {
    padding: '6px 12px',
    background: 'var(--accent)',
    color: '#241f1a',
    border: '1px solid var(--accent)',
    cursor: 'pointer',
    font: `11px ${MONO}`
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '7px 2px',
    borderTop: '1px solid var(--line)'
  },
  pill: {
    width: 34,
    textAlign: 'center',
    padding: '2px 0',
    border: '1px solid',
    borderColor: 'var(--line)',
    color: 'var(--faint)',
    cursor: 'pointer',
    fontSize: 10
  },
  pillOn: { background: 'var(--ok)', color: '#fff', borderColor: 'var(--ok)' },
  linkBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--faint)',
    cursor: 'pointer',
    font: `12px ${MONO}`
  },
  note: { fontSize: 11, color: 'var(--faint)', marginTop: 18, lineHeight: 1.6 },
  empty: { color: 'var(--faint)', padding: 18, fontSize: 11 }
}
