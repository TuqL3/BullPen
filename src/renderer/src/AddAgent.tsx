import { useState } from 'react'
import { Avatar } from './Avatar'
import { PRESETS, projectOf, SHIRT_CHOICES, slug } from './roster'
import { modelOf, withModel } from '../../models'
import { ENGINES, engineFor, retune } from '../../engines'
import { LABEL, MONO } from './theme'
import type { WorkflowInfo } from '../../preload/index'

type RoleOf = WorkflowInfo['roles'][string]

export type Draft = {
  /**
   * What this agent is for: a role name from the running workflow. The roles
   * with a fixed agent are spawned by the app; what the wizard makes is one of
   * the roles that workflow says may be hired into.
   */
  role: string
  project: string
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
  role: 'dev',
  project: '',
  name: '',
  face: PRESETS[1],
  color: SHIRT_CHOICES[2],
  cwd: '',
  cmd: 'claude',
  args: '',
  briefing: ''
}

/**
 * The standing agents are spawned by the app and hold their ids, so suggesting
 * one of those names here only ever produced "already on the floor". Suggest
 * the first preset nobody has taken, and no suggestion once they run out.
 */
const suggest = (taken: string[]): { name: string; face: string } => {
  const free = PRESETS.find((p) => !taken.includes(slug(p)))
  return { name: free ?? '', face: free ?? PRESETS[1] }
}

export function AddAgent({
  taken,
  prefill,
  onCancel,
  onSpawn,
  workflow
}: {
  taken: string[]
  /** Fields the caller already knows - hiring into a project fills in both. */
  prefill?: Partial<Draft>
  onCancel: () => void
  onSpawn: (d: Draft) => Promise<string | null>
  /** The running workflow: which roles exist here, and what each is called. */
  workflow: WorkflowInfo | null
}) {
  // Whatever this floor says may be hired into. A workflow with one kind of
  // worker shows one chip rather than a choice that is not one.
  // The chip's hover text is what the role is for, when the workflow says so:
  // "a developer" is a label, not an answer to what you are hiring one for.
  const hireable = Object.entries(workflow?.roles ?? {})
    .filter(([, def]) => def.hireable)
    .map(([role, def]) => [role, def.does ?? def.label] as const)
  /** How a role is named in a sentence: its agent's name, or what it is called. */
  const nameOf = ([role, def]: [string, RoleOf]): string => def.fixed?.name ?? def.label ?? role
  const roleEntries = Object.entries(workflow?.roles ?? {}) as [string, RoleOf][]
  const voice = roleEntries.find(([, def]) => def.can.includes('speaksToHuman'))

  const [step, setStep] = useState(0)
  // The roles with a fixed agent are spawned by the app and cannot be hired
  // into, so everyone made here fills one of the rest. Nothing to decide when
  // there is only one of those.
  const [d, setD] = useState<Draft>({
    ...EMPTY,
    // A default of 'dev' is one workflow's answer, and only a fallback here.
    role: hireable[0]?.[0] ?? EMPTY.role,
    ...suggest(taken),
    ...prefill
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** What Bullpen can do to the CLI that was chosen, and which models it has. */
  const engine = engineFor(d.cmd)
  /** Which model the arguments currently ask for. Read off them, not stored twice. */
  const picked = modelOf(d.args, engine.modelFlag)
  /** Whether the pinned ids are unfolded. Folded is the answer nearly every time. */
  const [more, setMore] = useState(false)

  // Whoever assigns and is allowed to write to the role being hired. Read off
  // talksTo rather than assumed, because a floor can have two who assign and
  // only one of them reaches this kind of agent.
  const reportsTo = roleEntries.find(
    ([r, def]) => def.can.includes('assigns') && (workflow?.talksTo[r] ?? []).includes(d.role)
  )

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
                <div style={{ fontSize: 10, color: 'var(--faint)', marginBottom: 10 }}>
                  id: {id} · becomes their mailbox and settings directory
                </div>

                {/* Every role this floor may be hired into, including when
                    there is only one. Hiding the single case saved a line and
                    cost the answer to "what roles does this floor have" - which
                    is the question somebody opening this dialog is asking. */}
                {hireable.length > 0 && <div style={{ ...LABEL, marginTop: 4 }}>Role</div>}
                <div style={{ display: 'flex', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                  {hireable.map(([role, what]) => (
                    <div
                      key={role}
                      onClick={() => set('role', role)}
                      title={what}
                      style={{ ...S.roleChip, ...(d.role === role ? S.roleChipOn : null) }}
                    >
                      {role}
                    </div>
                  ))}
                </div>
                {/* Who this one answers to is read out of the workflow: the role
                    that assigns and is allowed to write to the role being hired.
                    It was a name in the source, which was right for one floor. */}
                <div style={S.roleRow}>
                  <span>
                    {reportsTo ? (
                      <>
                        Reports to <b>{nameOf(reportsTo)}</b> — {reportsTo[1].label} hands out the
                        work and sees it through.
                      </>
                    ) : (
                      <>Nobody here assigns to this role — it works to the briefing you give it.</>
                    )}
                    {voice && ` ${nameOf(voice)} is the one who reports to you.`}
                  </span>
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
                {!workflow?.roles[d.role]?.fixed && (
                  <>
                    <div style={{ ...LABEL, marginTop: 14 }}>Project</div>
                    <input
                      style={S.input}
                      value={d.project}
                      placeholder={projectOf(d.cwd) || 'grouped by folder name if left blank'}
                      spellCheck={false}
                      onChange={(e) => set('project', e.target.value)}
                    />
                  </>
                )}

                <p style={S.note}>
                  This is the agent&apos;s sandbox. Writes outside it get escalated to you, and reads are
                  not restricted at all. Give them a scratch directory, never your home folder — Bullpen
                  refuses <code>$HOME</code> and <code>/</code> outright, but everything else is on you.
                </p>
              </>
            )}

            {step === 2 && (
              <>
                {/* A press, not a command to remember. The engine decides what
                    Bullpen may add to the spawn and what it can see afterwards,
                    which is too much to hang on somebody spelling `codex`. */}
                <div style={LABEL}>Engine</div>
                <div style={S.roleRow}>
                  {ENGINES.map((e) => (
                    <button
                      key={e.cmd}
                      title={e.caveat || 'everything Bullpen does works with this one'}
                      onClick={() =>
                        setD((prev) => ({
                          ...prev,
                          cmd: e.cmd,
                          args: retune(prev.args, engineFor(prev.cmd), e)
                        }))
                      }
                      style={{ ...S.roleChip, ...(engine.cmd === e.cmd ? S.roleChipOn : null) }}
                    >
                      {e.label}
                      {e.beta && <span style={S.beta}>beta</span>}
                    </button>
                  ))}
                  {/* A command typed by hand - out of a floor file's `- cli:`,
                      which is still the place to say one. Shown rather than
                      silently replaced by a chip that is not what is running. */}
                  {!ENGINES.some((e) => e.cmd === d.cmd) && d.cmd.trim() && (
                    <span style={{ ...S.roleChip, ...S.roleChipOn, cursor: 'default' }}>
                      {d.cmd.trim()}
                    </span>
                  )}
                </div>
                {/* What this one costs, in the words it costs them. An agent
                    nothing checks is the single most important thing this
                    dialog can say, and it used to be the last line of a
                    paragraph about `--settings`. */}
                <div
                  style={{
                    ...S.note,
                    marginTop: 0,
                    marginBottom: 12,
                    color: engine.supervised ? 'var(--ok)' : 'var(--warn)'
                  }}
                >
                  {engine.supervised
                    ? 'Approvals, context meter and cost all work with this one. Its brief is written to ' +
                      engine.briefFile +
                      ' in its workspace as well, so you can read what it was told.'
                    : engine.caveat}
                </div>
                {/* Three words answer this almost every time. The pinned ids
                    are for somebody who came looking to hold a version still,
                    which is not a thing anybody picks in passing - so they are
                    behind `more` rather than nine chips deep on the way past.

                    There is no model field on an agent: the CLI takes a flag
                    and Bullpen passes these arguments through verbatim, so this
                    rewrites that one flag and leaves the rest alone. */}
                <div style={LABEL}>Model</div>
                {engine.models.length === 0 ? (
                  <div style={{ ...S.note, marginTop: 2, marginBottom: 10 }}>
                    Bullpen ships no model list for {engine.label} &mdash; type{' '}
                    <code>{engine.modelFlag} &lt;name&gt;</code> below and it is passed through.
                  </div>
                ) : (
                  <>
                    <div style={{ ...S.roleRow, marginBottom: more ? 6 : 10 }}>
                      {engine.models
                        .filter((m) => m.common)
                        .map((m) => (
                          <button
                            key={m.id}
                            title={m.note || m.id}
                            onClick={() => set('args', withModel(d.args, m.id, engine.modelFlag))}
                            style={{ ...S.roleChip, ...(picked === m.id ? S.roleChipOn : null) }}
                          >
                            {m.label}
                          </button>
                        ))}
                      <button
                        title="let the CLI use whatever it is configured for"
                        onClick={() => set('args', withModel(d.args, null, engine.modelFlag))}
                        style={{ ...S.roleChip, ...(picked === null ? S.roleChipOn : null) }}
                      >
                        its default
                      </button>
                      <button
                        onClick={() => setMore((v) => !v)}
                        style={{ ...S.roleChip, borderColor: 'transparent' }}
                      >
                        {more ? '\u25be' : '\u25b8'} pin a version
                      </button>
                      {/* A model typed by hand, or one pinned and then folded
                          away: shown either way, because a chip row that says
                          nothing is selected while an argument says otherwise
                          is the dialog disagreeing with itself. */}
                      {picked && !engine.models.some((m) => m.common && m.id === picked) && (
                        <span style={{ ...S.roleChip, ...S.roleChipOn, cursor: 'default' }}>
                          {engine.models.find((m) => m.id === picked)?.label ?? picked}
                        </span>
                      )}
                    </div>
                    {more && (
                      <div style={S.roleRow}>
                        {engine.models
                          .filter((m) => !m.common)
                          .map((m) => (
                            <button
                              key={m.id}
                              title={m.note || m.id}
                              onClick={() => set('args', withModel(d.args, m.id, engine.modelFlag))}
                              style={{ ...S.roleChip, ...(picked === m.id ? S.roleChipOn : null) }}
                            >
                              {m.label}
                            </button>
                          ))}
                      </div>
                    )}
                  </>
                )}

                <div style={{ ...LABEL, marginTop: 14 }}>Extra arguments</div>
                <input
                  style={S.input}
                  value={d.args}
                  // Not a model: the chips above are what sets one, and naming
                  // an example here left `--model opus` sitting under a Codex
                  // agent as a suggestion it cannot take.
                  placeholder="anything else this CLI takes"
                  spellCheck={false}
                  onChange={(e) => set('args', e.target.value)}
                />

                <p style={S.note}>
                  The chips rewrite the <code>{engine.modelFlag}</code> flag; anything else here is
                  passed through, so a model released after this list was written still works.
                </p>
                <p style={S.note}>
                  The brief always lands as <code>{engine.briefFile}</code> in the workspace &mdash; a file
                  you can open and edit, and the only copy of it an unsupervised engine ever gets.
                  Bullpen writes it once and never over your edits.
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
            {/* A prefilled draft is complete at step 1, so spawning must not
                require walking to step 4 to reach the button. */}
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
    // A ceiling, not a width. Fixed at 720 it could not shrink, so a narrow
    // window scrolled the dialog sideways and cut the step list off the left
    // edge - the one column that says where you are in it.
    width: '100%',
    maxWidth: 720,
    boxSizing: 'border-box',
    maxHeight: '86vh',
    overflowY: 'auto',
    overflowX: 'hidden',
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
  roleChip: {
    padding: '4px 12px',
    border: '1px solid',
    borderColor: 'var(--line)',
    background: 'var(--sunk)',
    color: 'var(--muted)',
    cursor: 'pointer',
    // A chip is a name and reads as one line. Left to wrap, "Opus 5 · 1M" came
    // out three rows tall and the row of them looked like a table.
    whiteSpace: 'nowrap',
    font: `11px ${MONO}`
  },
  roleChipOn: { borderColor: 'var(--accent-ink)', color: 'var(--accent-ink)' },
  // Reads as part of the chip rather than a second control: no border, no
  // press, and small enough that the engine's name is still what you see.
  beta: {
    marginLeft: 5,
    fontSize: 8,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: 'var(--warn)',
    verticalAlign: 'top'
  } as React.CSSProperties,
  roleRow: {
    display: 'flex',
    // Wraps, because this row now holds nine models rather than three roles.
    // A flex row that cannot wrap and cannot shrink pushes its container wider
    // than the window, which is what put a horizontal scrollbar under a dialog.
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: 6,
    marginBottom: 10,
    fontSize: 11,
    color: 'var(--muted)',
    lineHeight: 1.5,
    cursor: 'pointer'
  },
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
    color: 'var(--muted)',
    border: '1px solid',
    borderColor: 'var(--line)',
    cursor: 'pointer',
    font: `11px ${MONO}`
  },
  btnPrimary: { background: 'var(--accent)', color: '#241f1a', borderColor: 'var(--accent)' }
}
