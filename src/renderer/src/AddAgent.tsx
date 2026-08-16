import { useState } from 'react'
import { Avatar } from './Avatar'
import { PRESETS, SHIRT_CHOICES, slug } from './avatar'
import { LABEL, MONO } from './theme'

export type Draft = {
  name: string
  face: string
  color: string
  cwd: string
  cmd: string
  args: string
  briefing: string
}

const STEPS = [
  { title: 'Identity', hint: 'name, face and colour' },
  { title: 'Workspace', hint: 'the directory they may write in' },
  { title: 'Engine', hint: 'which CLI runs behind them' },
  { title: 'Briefing', hint: 'the first thing they are told' }
] as const

const EMPTY: Draft = {
  name: 'Michael',
  face: 'Michael',
  color: SHIRT_CHOICES[2],
  cwd: '',
  cmd: 'claude',
  args: '',
  briefing: ''
}

export function AddAgent({
  taken,
  onCancel,
  onSpawn
}: {
  taken: string[]
  onCancel: () => void
  onSpawn: (d: Draft) => Promise<string | null>
}) {
  const [step, setStep] = useState(0)
  const [d, setD] = useState<Draft>(EMPTY)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((prev) => ({ ...prev, [k]: v }))

  /** Name and face travel together: typing a preset name picks that face, and
   *  picking a face renames, unless the human has typed something of their own. */
  const setName = (name: string): void =>
    setD((prev) => {
      const match = PRESETS.find((p) => p.toLowerCase() === name.trim().toLowerCase())
      return { ...prev, name, face: match ?? prev.face }
    })

  const setFace = (face: string): void =>
    setD((prev) => {
      const nameWasAPreset = PRESETS.some((p) => p.toLowerCase() === prev.name.trim().toLowerCase())
      return { ...prev, face, name: nameWasAPreset || !prev.name.trim() ? face : prev.name }
    })

  const id = slug(d.name)
  const problems = [
    !d.name.trim() && 'Name is required.',
    taken.includes(id) && `"${id}" is already on the floor.`,
    !d.cwd.trim() && 'A workspace directory is required.'
  ].filter(Boolean) as string[]

  const spawn = async (): Promise<void> => {
    if (problems.length) {
      // Jump to the step that is actually blocking rather than just complaining.
      setStep(problems[0].includes('workspace') ? 1 : 0)
      setError(problems[0])
      return
    }
    setBusy(true)
    const err = await onSpawn(d)
    setBusy(false)
    if (err) setError(err)
  }

  return (
    <div data-modal="add-agent" style={S.overlay} onClick={onCancel}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...LABEL, color: 'var(--ink)', fontSize: 12, fontWeight: 700, marginBottom: 16 }}>
          Add agent
        </div>

        <div style={S.grid}>
          <nav>
            {STEPS.map((s, i) => (
              <div
                key={s.title}
                onClick={() => setStep(i)}
                style={{ ...S.step, ...(step === i ? S.stepActive : null) }}
              >
                <div style={{ ...LABEL, color: step === i ? 'var(--ink)' : 'var(--muted)', fontSize: 10 }}>
                  {i + 1} {s.title}
                </div>
                <div style={{ fontSize: 10, color: 'var(--faint)', marginTop: 2 }}>{s.hint}</div>
              </div>
            ))}
          </nav>

          <div style={S.content}>
            {step === 0 && (
              <>
                <div style={LABEL}>Name</div>
                <input
                  autoFocus
                  data-field="name"
                  style={S.input}
                  value={d.name}
                  spellCheck={false}
                  onChange={(e) => setName(e.target.value)}
                />
                <div style={{ fontSize: 10, color: 'var(--faint)', marginBottom: 14 }}>
                  id: {id} · becomes their mailbox and settings directory
                </div>

                <div style={LABEL}>Character</div>
                <div style={S.faces}>
                  {PRESETS.map((p) => (
                    <div
                      key={p}
                      onClick={() => setFace(p)}
                      style={{ ...S.face, ...(d.face === p ? S.faceActive : null) }}
                    >
                      <Avatar id={p} size={38} shirt={d.color} />
                      <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 3 }}>{p}</div>
                    </div>
                  ))}
                </div>

                <div style={{ ...LABEL, marginTop: 14 }}>Colour</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {SHIRT_CHOICES.map((c) => (
                    <div
                      key={c}
                      onClick={() => set('color', c)}
                      style={{
                        ...S.swatch,
                        background: c,
                        outline: d.color === c ? '2px solid var(--accent)' : '1px solid var(--line)'
                      }}
                    />
                  ))}
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <div style={LABEL}>Working directory</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    style={{ ...S.input, flex: 1, marginBottom: 0 }}
                    value={d.cwd}
                    placeholder="/path/to/a/scratch/directory"
                    spellCheck={false}
                    onChange={(e) => set('cwd', e.target.value)}
                  />
                  <button
                    style={S.btn}
                    onClick={async () => {
                      const picked = await window.bullpen.pickDir()
                      if (picked) set('cwd', picked)
                    }}
                  >
                    browse
                  </button>
                </div>
                <p style={S.note}>
                  This is the agent&apos;s sandbox. Writes outside it get escalated to you, and reads are
                  not restricted at all. Give them a scratch directory, never your home folder — Bullpen
                  refuses <code>$HOME</code> and <code>/</code> outright, but everything else is on you.
                </p>
              </>
            )}

            {step === 2 && (
              <>
                <div style={LABEL}>Command</div>
                <input
                  style={S.input}
                  value={d.cmd}
                  spellCheck={false}
                  onChange={(e) => set('cmd', e.target.value)}
                />
                <div style={LABEL}>Extra arguments</div>
                <input
                  style={S.input}
                  value={d.args}
                  placeholder="--model opus"
                  spellCheck={false}
                  onChange={(e) => set('args', e.target.value)}
                />
                <p style={S.note}>
                  Bullpen appends <code>--settings</code> pointing at this agent&apos;s generated hook
                  config, which is what makes the approvals layer work. Only <code>claude</code> is
                  wired up and tested; another CLI will spawn, but its tool calls will not be checked.
                </p>
              </>
            )}

            {step === 3 && (
              <>
                <div style={LABEL}>First message</div>
                <textarea
                  style={{ ...S.input, height: 150, resize: 'vertical' }}
                  value={d.briefing}
                  placeholder="What should they start on? Leave blank to just open a prompt."
                  onChange={(e) => set('briefing', e.target.value)}
                />
                <p style={S.note}>
                  Sent once the CLI has finished booting. Blank is fine — you can always type into their
                  terminal afterwards.
                </p>
              </>
            )}
          </div>
        </div>

        {error && <div style={S.error}>{error}</div>}

        <div style={S.footer}>
          <div style={{ fontSize: 10, color: 'var(--faint)' }}>
            Nothing spawns until you hit spawn.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 && (
              <button style={S.btn} onClick={() => setStep(step - 1)}>
                back
              </button>
            )}
            {step < STEPS.length - 1 && (
              <button style={S.btn} onClick={() => setStep(step + 1)}>
                next
              </button>
            )}
            <button style={S.btn} onClick={onCancel}>
              cancel
            </button>
            <button style={{ ...S.btn, ...S.btnPrimary }} disabled={busy} onClick={spawn}>
              {busy ? 'spawning…' : 'spawn'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50
  },
  modal: {
    width: 720,
    maxHeight: '86vh',
    overflowY: 'auto',
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    padding: 20,
    font: `12px ${MONO}`,
    color: 'var(--ink)'
  },
  grid: { display: 'grid', gridTemplateColumns: '190px 1fr', gap: 20 },
  step: { padding: '8px 10px', borderLeft: '2px solid transparent', cursor: 'pointer' },
  stepActive: { background: 'var(--sunk)', borderLeft: '2px solid var(--accent)' },
  content: { minWidth: 0 },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '7px 9px',
    margin: '6px 0 12px',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    font: `12px ${MONO}`
  },
  faces: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginTop: 6 },
  face: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '5px 2px',
    border: '1px solid transparent',
    cursor: 'pointer'
  },
  faceActive: { border: '1px solid var(--accent)', background: 'var(--sunk)' },
  swatch: { width: 26, height: 22, cursor: 'pointer' },
  note: { fontSize: 11, color: 'var(--muted)', lineHeight: 1.6, marginTop: 4 },
  error: { color: 'var(--danger)', fontSize: 11, marginTop: 14 },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 18,
    paddingTop: 14,
    borderTop: '1px solid var(--line)'
  },
  btn: {
    padding: '6px 12px',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    cursor: 'pointer',
    font: `11px ${MONO}`
  },
  btnPrimary: { background: 'var(--accent)', color: '#241f1a', borderColor: 'var(--accent)' }
}
