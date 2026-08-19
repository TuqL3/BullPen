import { useEffect, useState } from 'react'
import { onEnter } from '../keys'
import { LABEL, MONO } from '../theme'
import type { ContextRule, WebhookCall, WebhookState } from '../../../preload/index'
import type { Agent } from '../store'
import { anyoneChecks, dispatchRole, entryRole, roleName, rolesWith } from '../shape'

type Trigger = {
  id: string
  agentId: string
  prompt: string
  everyMinutes: number
  enabled: boolean
  lastRun: number
}

/**
 * How long until a schedule fires again, counted down live.
 *
 * Seconds under a minute: "next in 0m" for the last sixty seconds of every
 * hour reads as broken, and this is the one number on the row that moves.
 */
function until(t: { lastRun: number; everyMinutes: number }, now: number): string {
  // Never run: it goes in on the scheduler's next sweep, not in `everyMinutes`.
  if (!t.lastRun) return 'on next sweep'
  const left = Math.max(0, t.lastRun + t.everyMinutes * 60_000 - now)
  if (left >= 60_000) return `next in ${Math.ceil(left / 60_000)}m`
  return `next in ${Math.ceil(left / 1000)}s`
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
  // Subscribed as well as fetched: a trigger that fires moves its own clock,
  // and a row that only refreshes when you switch tabs says "next in 0m"
  // forever afterwards.
  useEffect(() => {
    refresh()
    return window.bullpen.onTriggers((all) =>
      setTriggers((all as Trigger[]).filter((t) => t.agentId === agent?.id))
    )
  }, [agent?.id])

  // The countdown is a clock, not state: without this it froze at whatever it
  // read when the tab was opened.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

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
          <span style={{ width: 96, color: t.enabled ? 'var(--accent-ink)' : 'var(--faint)', fontSize: 10 }}>
            {t.enabled ? until(t, now) : 'paused'}
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
        would corrupt whatever it was doing. One that comes due while the agent is busy waits and
        goes in when it next falls idle, rather than losing its turn. Each firing is a real turn
        against your subscription, so an hourly trigger is 24 turns a day whether or not there was
        anything to do. The scheduler sweeps every 30 seconds, so a countdown is accurate to that.
      </p>

      {/* Named because they are the other ways work can start, and saying "not
          built" is more useful than leaving the reader to wonder. */}
      <ContextRuleRow agent={agent} />
      <WebhookRow agent={agent} />
      <Stub
        title="organisation"
        blurb="Let a teammate's Bullpen message yours."
        state="not built — see the note below"
      />
      <p style={S.note}>
        Organisation is not built, and the reason is worth saying plainly rather than leaving as a
        greyed-out row: the mail bus is a directory on this machine, and two Bullpens talking needs
        an answer to who is allowed to send you work, how their agent ids avoid colliding with
        yours, and what happens to mail written while the other machine is off. A shared folder
        would carry the messages today — it is the same file protocol — but none of those three
        questions are answered by carrying them, and a feature that routes a stranger's prompts
        into your agents is not one to ship on a guess.
      </p>
    </div>
  )
}

/**
 * Compact or clear this agent when its window fills.
 *
 * Fires off the same context reading the CTX meter shows, and only at an idle
 * agent - `/compact` typed into a turn in progress is text in the middle of its
 * work. It re-arms once usage drops five points below the line, so a window
 * hovering on it does not compact every turn.
 */
function ContextRuleRow({ agent }: { agent: Agent }) {
  const [rule, setRule] = useState<ContextRule | null>(null)
  const [pct, setPct] = useState('80')
  const [action, setAction] = useState<'compact' | 'clear'>('compact')

  useEffect(() => {
    window.bullpen.rules(agent.id).then((rs) => {
      const r = rs[0] ?? null
      setRule(r)
      if (r) {
        setPct(String(r.atPct))
        setAction(r.action)
      }
    })
    return window.bullpen.onRules((rs) => setRule(rs.find((r) => r.agentId === agent.id) ?? null))
  }, [agent.id])

  const save = async (): Promise<void> => {
    const made = await window.bullpen.setRule(agent.id, Number(pct), action)
    if (made) setRule(made)
  }

  return (
    <>
      <div style={S.sectionHead}>
        <span style={{ ...LABEL, color: 'var(--ink)' }}>context</span>
        <span style={{ fontSize: 11, color: 'var(--muted)', flex: 1 }}>
          Compact or clear {agent.name} as its window fills.
        </span>
        <span style={{ ...LABEL, color: 'var(--faint)' }}>
          {rule ? (rule.enabled ? 'on' : 'off') : 'no rule'}
        </span>
      </div>

      <div style={S.row}>
        {rule && (
          <span
            style={{ ...S.pill, ...(rule.enabled ? S.pillOn : null) }}
            onClick={() => window.bullpen.toggleRule(agent.id)}
          >
            {rule.enabled ? 'on' : 'off'}
          </span>
        )}
        <span style={{ color: 'var(--muted)' }}>at</span>
        <input
          style={{ ...S.input, flex: '0 0 56px', textAlign: 'right' }}
          value={pct}
          onChange={(e) => setPct(e.target.value)}
          onKeyDown={onEnter(save)}
        />
        <span style={{ ...LABEL }}>% send</span>
        {/* Two choices, so two switches: a native select here was the one
            control on the page the browser drew in its own colours. */}
        {(['compact', 'clear'] as const).map((a) => (
          <span
            key={a}
            style={{ ...S.choice, ...(action === a ? S.choiceOn : null) }}
            onClick={() => setAction(a)}
          >
            /{a}
          </span>
        ))}
        <button style={S.btn} onClick={save}>
          {rule ? 'update' : 'set'}
        </button>
        <span style={{ flex: 1, color: 'var(--faint)', fontSize: 11 }}>
          {rule
            ? `${rule.armed ? 'armed' : 'waiting for usage to drop'}${
                rule.lastRun ? ` · last ${new Date(rule.lastRun).toLocaleTimeString()}` : ''
              }`
            : 'nothing happens until you set one'}
        </span>
        {rule && (
          <button style={S.linkBtn} onClick={() => window.bullpen.removeRule(agent.id)}>
            ×
          </button>
        )}
      </div>
    </>
  )
}

/**
 * The inbound door: closed unless it is switched on here.
 *
 * Loopback only, and a token that has to be in the header. Anything that can
 * reach it can start work on this machine, so it says exactly what it opens
 * rather than reading as one more toggle.
 */
function WebhookRow({ agent }: { agent: Agent }) {
  const [state, setState] = useState<WebhookState | null>(null)
  const [port, setPort] = useState('8787')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const [last, setLast] = useState<WebhookCall | null>(null)
  const [tested, setTested] = useState('')
  const [showHow, setShowHow] = useState(false)

  const take = (s: WebhookState): void => {
    setState(s)
    setPort(String(s.port))
    if (s.lastCall) setLast(s.lastCall)
  }
  useEffect(() => {
    window.bullpen.webhook().then(take)
    // Every call in, accepted or refused: a token typo in someone's CI config
    // otherwise looks exactly like a webhook nobody ever wired up.
    return window.bullpen.onWebhookCall(setLast)
  }, [])

  const apply = async (enabled: boolean): Promise<void> => {
    setBusy(true)
    take(await window.bullpen.setWebhook(enabled, Number(port)))
    setBusy(false)
  }

  const copy = async (what: string, text: string): Promise<void> => {
    await navigator.clipboard.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(''), 1200)
  }

  // The shortest thing that works: no json, no content type, one header.
  const curl =
    state &&
    `curl -X POST http://127.0.0.1:${state.port}/task ` +
      `-H 'x-bullpen-token: ${state.token}' -d 'take a look at the failing build'`

  return (
    <>
      <div style={S.sectionHead}>
        <span style={{ ...LABEL, color: 'var(--ink)' }}>webhooks</span>
        <span style={{ fontSize: 11, color: 'var(--muted)', flex: 1 }}>
          Let an outside system post work in.
        </span>
        <span style={{ ...LABEL, color: state?.running ? 'var(--ok)' : 'var(--faint)' }}>
          {state?.running ? `listening on ${state.port}` : 'closed'}
        </span>
      </div>

      <div style={S.row}>
        <span
          style={{ ...S.pill, ...(state?.enabled ? S.pillOn : null) }}
          onClick={() => !busy && apply(!state?.enabled)}
        >
          {state?.enabled ? 'on' : 'off'}
        </span>
        <span style={{ color: 'var(--muted)' }}>port</span>
        <input
          style={{ ...S.input, flex: '0 0 72px', textAlign: 'right' }}
          value={port}
          onChange={(e) => setPort(e.target.value)}
          onKeyDown={onEnter(() => apply(state?.enabled ?? false))}
        />
        <button style={S.btn} onClick={() => apply(state?.enabled ?? false)}>
          save
        </button>
        {state && (
          <>
            <button style={S.btn} onClick={() => copy('token', state.token)}>
              {copied === 'token' ? 'copied' : 'copy token'}
            </button>
            <button style={S.btn} onClick={() => copy('curl', curl ?? '')}>
              {copied === 'curl' ? 'copied' : 'copy curl'}
            </button>
            <button
              style={S.btn}
              title="post a task to yourself, through the real socket"
              onClick={async () => {
                const r = await window.bullpen.testWebhook()
                setTested(r.ok ? 'delivered' : (r.error ?? `failed ${r.status ?? ''}`))
                setTimeout(() => setTested(''), 4000)
              }}
            >
              send test
            </button>
            <button
              style={S.linkBtn}
              title="new token - anything using the old one stops working"
              onClick={async () => take(await window.bullpen.rotateWebhookToken())}
            >
              rotate
            </button>
            {tested && (
              <span style={{ ...LABEL, color: tested === 'delivered' ? 'var(--ok)' : 'var(--danger)' }}>
                {tested}
              </span>
            )}
          </>
        )}
        <span style={{ flex: 1 }} />
      </div>
      {state?.error && (
        <div style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 8 }}>{state.error}</div>
      )}
      {last && (
        <div style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 8 }}>
          last call · <span style={{ color: 'var(--ink)' }}>{last.from}</span> ·{' '}
          <span style={{ color: last.ok ? 'var(--ok)' : 'var(--danger)' }}>
            {last.ok ? 'delivered' : last.subject}
          </span>{' '}
          · {new Date(last.at).toLocaleTimeString()}
        </div>
      )}
      <div style={S.note}>
        <div>
          <b style={{ color: 'var(--muted)' }}>How it works.</b> <code>POST /task</code> on
          127.0.0.1 only. The body can be a plain line of text, a form post, or JSON — including
          somebody else&apos;s webhook payload, which is summarised rather than refused for not
          being our shape. Address it with <code>/task/&lt;agent&gt;</code>, an{' '}
          <code>x-bullpen-to</code> header or a <code>to</code> field. Leave it out and it goes
          to {roleName(entryRole())}, whose job inbound work is: someone on that project is put on
          it, or hired onto it if nobody there is free
          {anyoneChecks() ? ', it is seen through check' : ''}, and the result is passed on to{' '}
          {roleName(rolesWith('speaksToHuman')[0] ?? dispatchRole())} — who is the one who reports
          to you, on the monitor. Say which project with <code>x-bullpen-project</code> or a{' '}
          <code>project</code> field, or let them read it out of the payload. Either way it becomes a card in tasks. The token goes in{' '}
          <code>x-bullpen-token</code> or <code>Authorization: Bearer</code>. Bodies over 64 KB are
          refused.
        </div>
        <div style={{ marginTop: 8 }}>
          It is not on the network: something outside this machine reaches it only through a tunnel
          you set up. Anything holding the token can start work here, so treat it like a password
          and rotate it when a caller no longer needs it.
        </div>
        <button style={{ ...S.linkBtn, padding: '8px 0 0' }} onClick={() => setShowHow(!showHow)}>
          {showHow ? '▾' : '▸'} examples
        </button>
      </div>

      {showHow && state && (
        <div style={S.examples}>
          {examplesFor(state, agent).map((e) => (
            <div key={e.title} style={S.example}>
              <div style={S.exampleHead}>
                <span style={{ ...LABEL, color: 'var(--ink)' }}>{e.title}</span>
                <span style={{ fontSize: 11, color: 'var(--faint)', flex: 1 }}>{e.blurb}</span>
                <button style={S.linkBtn} onClick={() => copy(e.title, e.code)}>
                  {copied === e.title ? 'copied' : 'copy'}
                </button>
              </div>
              <pre style={S.code}>{e.code}</pre>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/**
 * Recipes, written against this floor's own port, token and agent.
 *
 * A worked example with the real values in it is the difference between a
 * feature someone reads about and one they paste into a terminal.
 */
function examplesFor(
  state: WebhookState,
  agent: Agent
): { title: string; blurb: string; code: string }[] {
  const base = `http://127.0.0.1:${state.port}/task`
  const auth = `-H 'x-bullpen-token: ${state.token}'`
  return [
    {
      title: 'one line',
      blurb: 'the whole interface, if you only need one',
      code: `curl -X POST ${base} \\
  ${auth} \\
  -d 'the nightly build is red, find out why'`
    },
    {
      title: `straight to ${agent.name}`,
      blurb: 'when the sender can only be given a URL',
      code: `curl -X POST ${base}/${agent.id} \\
  ${auth} \\
  -d 'take the sitemap route and verify it builds'`
    },
    {
      title: 'git hook',
      blurb: '.git/hooks/post-commit — a review after every commit',
      code:
        `#!/bin/sh
curl -sX POST ${base} \\
  ${auth} \\
` +
        `  -d "Just committed $(git log -1 --oneline). Files: $(git show --name-only --format= HEAD | tr '\\n' ' ')
` +
        `Anything here that needs a test?"`
    },
    {
      title: 'CI failure',
      blurb: 'GitHub Actions, on a runner that can reach this machine',
      code:
        `- if: failure()
  run: |
    curl -sX POST ${base} \\
` +
        `      -H "x-bullpen-token: \${{ secrets.BULLPEN_TOKEN }}" \\
` +
        `      -d "CI failed: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID - read the log and find the cause"`
    },
    {
      title: 'from the internet',
      blurb: "a tunnel, then point GitHub or Sentry at it — their payload needs no translating",
      code: `cloudflared tunnel --url http://127.0.0.1:${state.port}
# then set the webhook URL to https://<tunnel>/task
# and add the header x-bullpen-token: ${state.token}`
    }
  ]
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
  // Same shape as the buttons beside it, filled when it is the one chosen -
  // so the row is one set of controls rather than a form with a browser widget
  // dropped into the middle of it.
  choice: {
    padding: '6px 12px',
    background: 'transparent',
    color: 'var(--muted)',
    border: '1px solid var(--line)',
    cursor: 'pointer',
    font: `11px ${MONO}`
  },
  choiceOn: { background: 'var(--accent)', color: '#241f1a', borderColor: 'var(--accent)' },
  linkBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--faint)',
    cursor: 'pointer',
    font: `12px ${MONO}`
  },
  note: { fontSize: 11, color: 'var(--faint)', marginTop: 18, lineHeight: 1.6 },
  examples: { display: 'flex', flexDirection: 'column', gap: 8, margin: '10px 0 6px' },
  example: { border: '1px solid var(--line)', background: 'var(--panel)', padding: '7px 9px' },
  exampleHead: { display: 'flex', alignItems: 'baseline', gap: 10 },
  code: {
    margin: '6px 0 0',
    padding: 8,
    background: 'var(--sunk)',
    color: 'var(--ink)',
    font: `11px ${MONO}`,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    lineHeight: 1.5
  },
  empty: { color: 'var(--faint)', padding: 18, fontSize: 11 }
}
