import { useEffect, useRef, useState } from 'react'
import type { WorkflowInfo } from '../../preload/index'
import { Markdown } from './Markdown'
import { OrgChart } from './OrgChart'
import { FLOORS } from './floor/tiles'
import { onEnter } from './keys'
import { readBrief, writeBrief } from '../../brief'
import { readRules, readType, sayType, writeRules, type Field, type Rules } from '../../rules'
import { LABEL, MONO } from './theme'



type Saved = { name: string; description: string; markdown: string; builtin: boolean }

/** The `# heading` of whatever is in the editor right now. */
const nameOf = (md: string): string => (/^#\s+(.+)$/m.exec(md)?.[1] ?? '').trim()

/**
 * The floor's shape, as something the operator can change.
 *
 * Bullpen shipped with one workflow written into its source: a boss, an
 * analyst, developers and testers, in that order. That is one opinion about how
 * work should move, and it is not everybody's - so this is where somebody
 * else's floor gets described instead.
 *
 * Deliberately a settings dialog and not a tab: a workflow is set once and then
 * left alone, and a twelfth tab beside `terminal` and `tasks` would suggest it
 * is somewhere you look while working.
 *
 * Edited as markdown rather than as JSON. Most of a workflow is the briefs -
 * several paragraphs per role - and in JSON those are one string with `\n\n` in
 * it. The part a person most needs to write was the part the format made
 * hardest to read.
 *
 * Text on the left, what it means on the right. The markdown alone is pages of
 * prose with six structural lines buried in it; the panel beside it is those
 * six lines, read back out of the same parse the router will do.
 */
/**
 * The sections of this dialog.
 *
 * It was one screen, for one thing: the workflow. Everything else adjustable
 * was a button somewhere else in the app - the theme and the bell in the title
 * bar, the workspace on an agent's own header, the webhook three tabs away -
 * which is a settings screen scattered across the product rather than absent.
 */
/**
 * The sections of this dialog, grouped by what is being changed.
 *
 * It grew as a flat list - floor, roles, try it, board, format, look, agents -
 * which is seven things in one column with nothing saying that four of them are
 * the same document and three are this machine. Grouped, and the markdown is
 * where it belongs: one entry at the bottom of the floor, for people who would
 * rather type it.
 */
const GROUPS = [
  {
    key: 'floor',
    title: 'the floor',
    hint: 'who is on it and how work moves - drawn, not typed',
    items: [['chart', 'chart']]
  },
  {
    key: 'app',
    title: 'this app',
    hint: 'this machine, not this floor',
    items: [
      ['look', 'look & alerts'],
      ['agents', 'agents & doors'],
      ['format', 'the rules']
    ]
  }
] as const
type Section = (typeof GROUPS)[number]['items'][number][0]

export function Settings({
  workflow,
  onClose,
  onApplied,
  onRestartFloor,
  mode,
  onMode,
  notifyOn,
  onNotify,
  prefs,
  onPrefs,
  onMoveGod
}: {
  workflow: WorkflowInfo | null
  onClose: () => void
  onApplied: (w: WorkflowInfo) => void
  /** Take the standing agents down and bring them back on the running shape. */
  onRestartFloor: () => Promise<void>
  mode: 'light' | 'dark'
  onMode: (m: 'light' | 'dark') => void
  notifyOn: boolean
  onNotify: (on: boolean) => void
  /** How the app is drawn on this machine: terminal size, floor colours. */
  prefs: { fontSize: number; floor: string }
  onPrefs: (next: { fontSize?: number; floor?: string }) => void
  /** Pick a new workspace for the standing agents. Restarts them. */
  onMoveGod: () => Promise<void>
}) {
  const [section, setSection] = useState<Section>('chart')
  const group = GROUPS.find((g) => g.items.some(([key]) => key === section)) ?? GROUPS[0]
  /** Agents that are still running the shape they were spawned on. */
  const [stale, setStale] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.bullpen.workflow().then((r) => setStale(r.stale))
  }, [workflow])

  /**
   * A pane saved a change to the running floor.
   *
   * Nothing else has to be told: the canvas holds the whole floor and reloads
   * from the prop, and the rest of the dialog is about this machine.
   */
  const patched = (next: WorkflowInfo): void => onApplied(next)

  /** Take the standing agents down and bring them back on the shape now running. */
  const moveFloor = async (): Promise<void> => {
    setBusy(true)
    await onRestartFloor()
    setStale([])
    setBusy(false)
  }

  const unfocus = (e: React.MouseEvent<HTMLElement>): void => e.currentTarget.blur()

  return (
    <div style={S.wrap} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.head}>
          <span style={{ ...LABEL, color: 'var(--ink)' }}>settings</span>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button style={S.icon} title="close" aria-label="close" onClick={onClose}>
              <Glyph name="close" />
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
          <div style={S.nav}>
            {/* Three, not twelve. The twelve are still there - they are the
                tabs across the top of whichever of these is open - but a column
                of twelve is a list you read rather than a place you go. */}
            {GROUPS.map((g) => (
              <button
                key={g.key}
                title={g.hint}
                style={{ ...S.navItem, ...(group.key === g.key ? S.navOn : null) }}
                onClick={(e) => {
                  unfocus(e)
                  setSection(g.items[0][0])
                }}
              >
                {g.title}
              </button>
            ))}
          </div>

          <div style={S.column}>
            <div style={S.tabs}>
              {group.items.map(([key, label]) => (
                <button
                  key={key}
                  style={{ ...S.tab, ...(section === key ? S.tabOn : null) }}
                  onClick={(e) => {
                    unfocus(e)
                    setSection(key)
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

          {section === 'chart' && <OrgChart workflow={workflow} onApplied={patched} />}
          {section === 'look' && (
            <LookPane
              mode={mode}
              onMode={onMode}
              notifyOn={notifyOn}
              onNotify={onNotify}
              prefs={prefs}
              onPrefs={onPrefs}
            />
          )}
          {section === 'agents' && (
            <AgentsPane workflow={workflow} onApplied={patched} onMoveGod={onMoveGod} />
          )}
          {section === 'format' && <FormatPane />}
          </div>
        </div>

        <div style={S.foot}>
          <span style={{ color: 'var(--faint)', flex: 1 }}>
            {stale.length > 0 ? (
              <>
                {stale.length} agent{stale.length === 1 ? '' : 's'} still on the shape they
                started on{' '}
                <button style={S.linkBtn} disabled={busy} onClick={moveFloor}>
                  restart the standing ones
                </button>
              </>
            ) : (
              'each section saves on its own'
            )}
          </span>
          <button style={S.btn} onClick={onClose}>
            close
          </button>
        </div>
      </div>
    </div>
  )
}

function Glyph({ name }: { name: 'close' }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    style: { display: 'block' }
  }
  return (
    <svg {...common} aria-hidden>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  )
}

/** Editor line height in pixels: 12px type at the 1.55 the textarea is set to. */
const LINE_PX = 12 * 1.55

function FormatPane() {
  const [doc, setDoc] = useState<{ text: string; path: string; custom: boolean } | null>(null)
  const [rules, setRules] = useState<Rules | null>(null)
  /**
   * Every law the file arrived with, and which of them are switched off.
   *
   * Kept apart from `rules.laws` because unticking one removes its line - and a
   * checkbox you cannot tick again is not a checkbox. The row stays on screen;
   * only what gets written changes.
   */
  const [all, setAll] = useState<Rules['laws']>([])
  const [off, setOff] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  /**
   * How this pane opens: reading.
   *
   * It opened as a schema editor - six boxes a field, thirty-odd fields - which
   * is the right screen for the two or three times somebody changes what a
   * floor may contain, and the wrong one for every time they came to find out
   * what it may contain. Reading is the common case; editing is a choice.
   */
  const [mode, setMode] = useState<'read' | 'edit' | 'text'>('read')
  const [text, setText] = useState('')

  const load = (d: { text: string; path: string; custom: boolean }): void => {
    const read = readRules(d.text)
    setDoc(d)
    setRules(read)
    setAll(read.laws)
    setOff(new Set())
    setText(d.text)
  }
  useEffect(() => {
    window.bullpen.workflowFormat().then(load)
  }, [])

  const write = async (next: string): Promise<void> => {
    setError('')
    const res = await window.bullpen.writeWorkflowFormat(next)
    if (res.error) return setError(res.error)
    load({ text: res.text ?? '', path: res.path ?? '', custom: res.custom ?? false })
    setNote(res.custom ? 'Saved. These are the rules now.' : 'Back to the ones Bullpen ships.')
  }

  if (!doc || !rules) return <div style={S.pane} />

  // What was read against what is on screen - not the text against the text.
  // Writing the rules back out re-flows them, so comparing the two strings said
  // "edited" the moment the pane opened.
  const kept: Rules = { ...rules, laws: all.filter((l) => !off.has(l.id)) }
  const edited =
    mode === 'text'
      ? text !== doc.text
      : JSON.stringify(kept) !== JSON.stringify({ ...readRules(doc.text), text: rules.text })
  const setField = (entity: string, at: number, patch: Partial<Field>): void =>
    setRules({
      ...rules,
      entities: rules.entities.map((e) =>
        e.name === entity ? { ...e, fields: e.fields.map((f, i) => (i === at ? { ...f, ...patch } : f)) } : e
      )
    })

  return (
    <div style={{ ...S.pane, display: 'flex', flexDirection: 'column' }}>
      <div style={{ color: 'var(--muted)', lineHeight: 1.7, marginBottom: 8 }}>
        These are the rules every floor is checked against - the same for all of them. You will
        rarely need to change anything here. To build a floor, go to{' '}
        <b>this floor</b>; this page is what that one is allowed to say.
      </div>

      <div style={{ ...S.tabs, marginBottom: 8 }}>
        {(['read', 'edit', 'text'] as const).map((m) => (
          <button
            key={m}
            style={{ ...S.tab, ...(mode === m ? S.tabOn : null) }}
            onClick={() => setMode(m)}
          >
            {m === 'read' ? 'what the rules say' : m === 'edit' ? 'change them' : 'as text'}
          </button>
        ))}
      </div>

      {mode === 'read' ? (
        <div style={{ flex: 1, overflow: 'auto', paddingRight: 4 }}>
          {rules.entities.map((entity) => (
            <div key={entity.name} style={{ marginBottom: 14 }}>
              <div style={{ ...LABEL, color: 'var(--accent-ink)' }}>{entity.name}</div>
              {entity.what && (
                <div style={{ color: 'var(--faint)', lineHeight: 1.6, margin: '2px 0 4px' }}>
                  {entity.what}
                </div>
              )}
              {entity.fields.map((f, i) => (
                <div key={i} style={S.helpRow}>
                  <code style={S.term}>{f.name}</code>
                  <span style={{ color: 'var(--muted)' }}>
                    {sayType(f.type)}
                    {f.required ? ' · must be there' : ''}
                    {f.unique ? ' · no two the same' : ''}
                    {f.fallback ? ` · ${f.fallback} unless you say otherwise` : ''}
                    {f.what ? ` — ${f.what}` : ''}
                  </span>
                </div>
              ))}
            </div>
          ))}

          <div style={{ ...LABEL, color: 'var(--accent-ink)' }}>the checks that run</div>
          <div style={{ color: 'var(--faint)', lineHeight: 1.6, margin: '2px 0 6px' }}>
            Untick one and the app stops checking it. It does not stop doing the thing.
          </div>
          {all.map((law) => (
            <label key={law.id} style={{ ...S.helpRow, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!off.has(law.id)}
                onChange={(e) => {
                  const next = new Set(off)
                  if (e.target.checked) next.delete(law.id)
                  else next.add(law.id)
                  setOff(next)
                }}
              />
              <span style={{ color: off.has(law.id) ? 'var(--faint)' : 'var(--muted)' }}>
                {law.says}
              </span>
            </label>
          ))}
        </div>
      ) : mode === 'text' ? (
        <textarea
          style={{ ...S.editor, flex: 1, width: '100%', boxSizing: 'border-box' }}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <div style={{ flex: 1, overflow: 'auto', paddingRight: 4 }}>
          {rules.entities.map((entity) => (
            <div key={entity.name} style={{ marginBottom: 16 }}>
              <div style={{ ...LABEL, color: 'var(--accent-ink)' }}>{entity.name}</div>
              {entity.what && (
                <div style={{ color: 'var(--faint)', lineHeight: 1.6, margin: '2px 0 6px' }}>
                  {entity.what}
                </div>
              )}
              {entity.fields.map((f, i) => (
                <div key={i} style={S.formRow}>
                  <input
                    style={{ ...S.field, width: 150 }}
                    value={f.name}
                    spellCheck={false}
                    onChange={(e) => setField(entity.name, i, { name: e.target.value })}
                  />
                  <input
                    style={{ ...S.field, width: 190 }}
                    value={sayType(f.type)}
                    spellCheck={false}
                    title="text · sentence · prose · percent · colour · path · agent · role · list of X · one of a, b"
                    onChange={(e) => setField(entity.name, i, { type: readType(e.target.value) })}
                  />
                  <label style={S.checkRow} title="a floor must say this">
                    <input
                      type="checkbox"
                      checked={f.required}
                      onChange={(e) => setField(entity.name, i, { required: e.target.checked })}
                    />
                    required
                  </label>
                  <label style={S.checkRow} title="no two may share it">
                    <input
                      type="checkbox"
                      checked={f.unique}
                      onChange={(e) => setField(entity.name, i, { unique: e.target.checked })}
                    />
                    unique
                  </label>
                  <input
                    style={{ ...S.field, width: 90 }}
                    value={f.fallback ?? ''}
                    placeholder="default"
                    onChange={(e) => setField(entity.name, i, { fallback: e.target.value || undefined })}
                  />
                  <input
                    style={{ ...S.field, flex: 1, minWidth: 80 }}
                    value={f.what}
                    placeholder="what it is, in your words"
                    onChange={(e) => setField(entity.name, i, { what: e.target.value })}
                  />
                </div>
              ))}
            </div>
          ))}

          <div style={{ ...LABEL, color: 'var(--accent-ink)' }}>the checks that run</div>
          <div style={{ color: 'var(--faint)', lineHeight: 1.6, margin: '2px 0 6px' }}>
            Untick one and the app stops checking it. It does not stop doing the thing.
          </div>
          {all.map((law, i) => (
            <div key={law.id} style={S.formRow}>
              <label style={{ ...S.checkRow, width: 200 }}>
                <input
                  type="checkbox"
                  checked={!off.has(law.id)}
                  onChange={(e) => {
                    const next = new Set(off)
                    if (e.target.checked) next.delete(law.id)
                    else next.add(law.id)
                    setOff(next)
                  }}
                />
                <code style={{ ...S.term, opacity: off.has(law.id) ? 0.5 : 1 }}>{law.id}</code>
              </label>
              <input
                style={{ ...S.field, flex: 1, opacity: off.has(law.id) ? 0.5 : 1 }}
                value={law.says}
                onChange={(e) =>
                  setAll(all.map((l, at) => (at === i ? { ...l, says: e.target.value } : l)))
                }
              />
            </div>
          ))}
        </div>
      )}

      {error && <div style={S.problems}>{error}</div>}
      {note && <div style={S.ok}>· {note}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          style={{ ...S.btn, ...(edited ? S.btnGo : S.btnOff) }}
          disabled={!edited}
          onClick={() => write(mode === 'text' ? text : writeRules(kept))}
        >
          save the rules
        </button>
        {doc.custom && (
          <button style={S.btn} title="delete your copy" onClick={() => write('')}>
            use the ones Bullpen ships
          </button>
        )}
      </div>
    </div>
  )
}

/** Theme and notifications: the two switches that were only ever icons. */
function LookPane({
  mode,
  onMode,
  notifyOn,
  onNotify,
  prefs,
  onPrefs
}: {
  mode: 'light' | 'dark'
  onMode: (m: 'light' | 'dark') => void
  notifyOn: boolean
  onNotify: (on: boolean) => void
  prefs: { fontSize: number; floor: string }
  onPrefs: (next: { fontSize?: number; floor?: string }) => void
}) {
  return (
    <div style={S.pane}>
      <div style={{ ...LABEL, color: 'var(--accent-ink)' }}>theme</div>
      <div style={{ display: 'flex', gap: 8, margin: '6px 0 16px' }}>
        {(['light', 'dark'] as const).map((m) => (
          <button
            key={m}
            style={{ ...S.btn, ...(mode === m ? S.btnGo : null) }}
            onClick={() => onMode(m)}
          >
            {m}
          </button>
        ))}
      </div>
      <div style={{ color: 'var(--faint)', lineHeight: 1.7, marginBottom: 16 }}>
        Every agent&apos;s own CLI is told the same thing at spawn, so a running agent keeps the
        theme it started in until it is restarted.
      </div>

      <div style={{ ...LABEL, color: 'var(--accent-ink)' }}>terminal</div>
      <div style={S.formRow}>
        <input
          type="range"
          min={9}
          max={20}
          step={0.5}
          value={prefs.fontSize}
          style={{
            width: 220,
            // The filled part, in the app's accent. Inline because it moves
            // with the value, and a stylesheet cannot see the value.
            background: `linear-gradient(to right, var(--accent-ink) 0 ${
              ((prefs.fontSize - 9) / 11) * 100
            }%, var(--sunk) ${((prefs.fontSize - 9) / 11) * 100}% 100%)`
          }}
          onChange={(e) => onPrefs({ fontSize: Number(e.target.value) })}
        />
        {/* Not LABEL: that upper-cases, and "12.5PX" is a size shouted. */}
        <span style={{ color: 'var(--ink)', font: `12px ${MONO}` }}>{prefs.fontSize}px</span>
      </div>
      {/* The size a pty is spawned at is computed from this, so it is not only
          how the text looks - it is how wide the CLI thinks its window is. */}
      <div style={{ color: 'var(--faint)', lineHeight: 1.7, margin: '2px 0 16px' }}>
        Applies to every terminal at once, and to how wide the next agent&apos;s CLI is told its
        window is.
      </div>

      <div style={{ ...LABEL, color: 'var(--accent-ink)' }}>office floor</div>
      <div style={{ display: 'flex', gap: 8, margin: '6px 0 16px' }}>
        {FLOORS.map((f) => (
          <button
            key={f}
            style={{ ...S.btn, ...(prefs.floor === f ? S.btnGo : null) }}
            onClick={() => onPrefs({ floor: f })}
          >
            {f}
          </button>
        ))}
      </div>

      <div style={{ ...LABEL, color: 'var(--accent-ink)' }}>notifications</div>
      <label style={{ ...S.formRow, cursor: 'pointer' }}>
        <input type="checkbox" checked={notifyOn} onChange={(e) => onNotify(e.target.checked)} />
        <span style={{ color: 'var(--muted)' }}>
          Tell me when an agent needs an answer, and when work comes back.
        </span>
      </label>
    </div>
  )
}

/**
 * Where the floor works, how full an agent may be before it is left alone, and
 * the inbound door. Three settings that were in three different places.
 */
function AgentsPane({
  workflow,
  onApplied,
  onMoveGod
}: {
  workflow: WorkflowInfo | null
  onApplied: (w: WorkflowInfo, markdown?: string) => void
  onMoveGod: () => Promise<void>
}) {
  const [cwd, setCwd] = useState('')
  const [reuse, setReuse] = useState(workflow?.reuseBelowPct ?? 50)
  const [hire, setHire] = useState(workflow?.hireAbovePct ?? 70)
  const [hook, setHook] = useState<{ enabled: boolean; port: number } | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    window.bullpen.godCwd().then(setCwd)
    window.bullpen.webhook().then((w) => setHook({ enabled: w.enabled, port: w.port }))
  }, [])

  const saveThresholds = async (): Promise<void> => {
    setError('')
    setNote('')
    const res = await window.bullpen.patchWorkflow({ reuseBelowPct: reuse, hireAbovePct: hire })
    if (res.error) return setError(res.error)
    if (res.workflow) {
      onApplied(res.workflow, res.markdown)
      setNote('Saved into the workflow.')
    }
  }

  const moved = reuse !== workflow?.reuseBelowPct || hire !== workflow?.hireAbovePct

  return (
    <div style={S.pane}>
      <div style={{ ...LABEL, color: 'var(--accent-ink)' }}>workspace</div>
      <div style={{ color: 'var(--faint)', lineHeight: 1.7, margin: '4px 0 6px' }}>
        Where the standing agents work, and the only directory they may write in. Moving it is a
        restart: their conversations do not survive it.
      </div>
      <div style={S.formRow}>
        <code style={{ ...S.path, flex: 1 }}>{cwd || '—'}</code>
        <button style={S.btn} onClick={onMoveGod}>
          move
        </button>
      </div>

      <div style={{ ...LABEL, color: 'var(--accent-ink)', marginTop: 16 }}>context</div>
      <div style={{ color: 'var(--faint)', lineHeight: 1.7, margin: '4px 0 6px' }}>
        How full an idle agent may be before it is reused, and the point past which it is treated
        as unavailable even when it is doing nothing. Part of the workflow, saved into it.
      </div>
      <div style={S.formRow}>
        <span style={{ color: 'var(--muted)', width: 92 }}>reuse below</span>
        <input
          type="number"
          style={{ ...S.field, width: 70 }}
          value={reuse}
          onChange={(e) => setReuse(Number(e.target.value))}
        />
        <span style={{ color: 'var(--muted)', width: 80 }}>hire above</span>
        <input
          type="number"
          style={{ ...S.field, width: 70 }}
          value={hire}
          onChange={(e) => setHire(Number(e.target.value))}
        />
        <button
          style={{ ...S.btn, ...(moved ? S.btnGo : S.btnOff) }}
          disabled={!moved}
          onClick={saveThresholds}
        >
          save
        </button>
      </div>

      <div style={{ ...LABEL, color: 'var(--accent-ink)', marginTop: 16 }}>inbound</div>
      <div style={{ color: 'var(--faint)', lineHeight: 1.7, margin: '4px 0 6px' }}>
        A door on 127.0.0.1 that turns a POST into work for the floor. The token and the call log
        are in the triggers tab, which is where the calls arrive.
      </div>
      {hook && (
        <div style={S.formRow}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={hook.enabled}
              onChange={async (e) => {
                const next = await window.bullpen.setWebhook(e.target.checked, hook.port)
                setHook({ enabled: next.enabled, port: next.port })
              }}
            />
            <span style={{ color: 'var(--muted)' }}>listening</span>
          </label>
          <span style={{ color: 'var(--muted)' }}>port</span>
          <input
            type="number"
            style={{ ...S.field, width: 90 }}
            value={hook.port}
            onChange={(e) => setHook({ ...hook, port: Number(e.target.value) })}
            onBlur={async () => {
              const next = await window.bullpen.setWebhook(hook.enabled, hook.port)
              setHook({ enabled: next.enabled, port: next.port })
            }}
          />
        </div>
      )}

      {error && <div style={S.problems}>{error}</div>}
      {note && <div style={S.ok}>· {note}</div>}
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 60,
    padding: 24
  },
  modal: {
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    padding: 16,
    // Was full height and 1180 wide, which put a page of prose on screen and
    // nothing to read it against. This is a dialog, not the app.
    width: '100%',
    maxWidth: 1460,
    height: '84vh',
    display: 'flex',
    flexDirection: 'column',
    gap: 9,
    font: `12px ${MONO}`,
    color: 'var(--ink)'
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  // A 30px target rather than eleven characters of 11px text.
  icon: {
    background: 'transparent',
    border: 'none',
    color: 'var(--faint)',
    cursor: 'pointer',
    padding: 7,
    display: 'flex',
    alignItems: 'center'
  },
  iconOn: { color: 'var(--accent-ink)' },
  tab: {
    background: 'transparent',
    border: 'none',
    color: 'var(--faint)',
    cursor: 'pointer',
    padding: '4px 8px',
    font: `11px ${MONO}`
  },
  // Filled when on, nothing when off. The underline it used to carry was a
  // transparent border in the off state, and a transparent border still draws.
  tabOn: { background: 'var(--sunk)', color: 'var(--ink)' },
  /** A dot on the one the floor is actually running, which is not the same
   *  question as which one is open in the editor. */
  running: {
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: 'var(--ok)',
    display: 'inline-block'
  },
  chipX: {
    background: 'none',
    border: 'none',
    color: 'var(--faint)',
    cursor: 'pointer',
    font: `11px ${MONO}`,
    padding: '0 0 0 4px'
  },
  split: { flex: 1, minHeight: 0, display: 'flex', gap: 9 },
  list: {
    flex: '0 0 152px',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    overflowY: 'auto'
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    border: 'none',
    color: 'var(--muted)',
    padding: '4px 9px',
    font: `11px ${MONO}`
  },
  // One mark, and only on the selected row. A transparent border kept as a
  // spacer still draws - every row had a rule down its left edge and the list
  // read as four things selected. Nothing here paints unless it is chosen.
  itemOn: { background: 'var(--sunk)', color: 'var(--ink)' },
  itemName: {
    flex: 1,
    minWidth: 0,
    background: 'none',
    border: 'none',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    textAlign: 'left'
  },
  itemText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  unsaved: { color: 'var(--warn)', fontSize: 10, flex: '0 0 auto' },
  /** The generator's own dialog: narrow, and over the top of the big one. */
  small: {
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    padding: 16,
    width: '100%',
    maxWidth: 640,
    maxHeight: '82vh',
    display: 'flex',
    flexDirection: 'column',
    gap: 9,
    font: `12px ${MONO}`,
    color: 'var(--ink)'
  },
  draftBox: {
    flex: 1,
    minHeight: 140,
    background: 'var(--sunk)',
    border: '1px solid var(--line)',
    fontSize: 11,
    padding: '10px 12px'
  },
  wantBox: {
    width: '100%',
    minHeight: 72,
    resize: 'vertical',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    padding: 8,
    font: `12px ${MONO}`,
    lineHeight: 1.5,
    flex: '0 0 auto'
  },
  new: {
    marginTop: 4,
    background: 'transparent',
    border: '1px dashed var(--line)',
    color: 'var(--muted)',
    cursor: 'pointer',
    padding: '4px 6px',
    font: `11px ${MONO}`
  },
  editor: {
    flex: '1 1 34%',
    minWidth: 0,
    resize: 'none',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    padding: 10,
    font: `12px ${MONO}`,
    lineHeight: 1.55
  },
  side: {
    flex: '1 1 26%',
    minWidth: 0,
    border: '1px solid var(--line)',
    background: 'var(--sunk)',
    padding: 10,
    overflowY: 'auto',
    fontSize: 11,
    lineHeight: 1.6,
    display: 'flex',
    flexDirection: 'column',
    gap: 8
  },
  previewBody: { display: 'flex', flexDirection: 'column' },

  reader: {
    flex: '1 1 34%',
    minWidth: 0,
    background: 'var(--sunk)',
    fontSize: 11,
    padding: '10px 12px'
  },
  card: {
    borderLeft: '2px solid var(--line)',
    paddingLeft: 8,
    marginBottom: 7
  },
  badge: {
    border: '1px solid var(--line)',
    color: 'var(--accent-ink)',
    padding: '0 4px',
    fontSize: 10
  },
  warnBadge: {
    border: '1px solid var(--warn)',
    color: 'var(--warn)',
    padding: '0 4px',
    fontSize: 10
  },
  problems: {
    border: '1px solid var(--danger)',
    color: 'var(--danger)',
    padding: '6px 8px',
    flex: '0 0 auto'
  },
  problem: { marginBottom: 3 },
  problemGo: { cursor: 'pointer', textDecoration: 'underline dotted' },
  ok: { color: 'var(--ok)', flex: '0 0 auto' },
  helpRow: { display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 2 },
  term: {
    color: 'var(--ink)',
    background: 'var(--panel)',
    padding: '0 3px',
    whiteSpace: 'nowrap',
    flex: '0 0 auto'
  },
  // A home directory is as long as somebody's username makes it, and `term`
  // refuses to wrap - one path put a horizontal scrollbar under the whole panel.
  path: {
    color: 'var(--ink)',
    background: 'var(--panel)',
    padding: '0 3px',
    overflowWrap: 'anywhere' as const
  },
  note: { fontSize: 11, color: 'var(--warn)', lineHeight: 1.5, flex: '0 0 auto' },
  column: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  tabs: { display: 'flex', gap: 4, flexWrap: 'wrap', flex: '0 0 auto' },
  nav: {
    width: 132,
    flex: '0 0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    borderRight: '1px solid var(--line)',
    paddingRight: 8,
    marginRight: 10
  },
  navItem: {
    // Block: these sit inside a group now, and a button is inline by default -
    // which put the whole of "this floor" on one line.
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '5px 8px',
    border: 0,
    background: 'transparent',
    color: 'var(--muted)',
    font: 'inherit',
    cursor: 'pointer',
    borderRadius: 3
  },
  navOn: { background: 'var(--panel)', color: 'var(--ink)' },
  pane: { flex: 1, minWidth: 0, overflow: 'auto', paddingRight: 4 },
  formRow: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 },
  checkRow: { display: 'flex', gap: 4, alignItems: 'center', color: 'var(--muted)', cursor: 'pointer' },
  roleChip: {
    padding: '3px 8px',
    border: '1px solid var(--line)',
    color: 'var(--muted)',
    cursor: 'pointer',
    userSelect: 'none'
  },
  roleChipOn: { borderColor: 'var(--accent-ink)', color: 'var(--ink)', background: 'var(--panel)' },
  step: {
    display: 'flex',
    gap: 8,
    alignItems: 'baseline',
    padding: '4px 6px',
    borderLeft: '2px solid var(--line)',
    marginBottom: 2
  },
  stepBad: { borderLeft: '2px solid var(--danger)', background: 'var(--sunk)' },
  field: {
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    color: 'var(--ink)',
    font: 'inherit',
    padding: '4px 6px',
    borderRadius: 3
  },
  colour: {
    width: 34,
    height: 26,
    padding: 0,
    border: '1px solid var(--line)',
    background: 'var(--panel)',
    cursor: 'pointer'
  },
  foot: { display: 'flex', gap: 8, alignItems: 'center' },
  btn: {
    background: 'transparent',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    cursor: 'pointer',
    padding: '5px 12px',
    font: `12px ${MONO}`
  },
  btnGo: { borderColor: 'var(--accent)' },
  linkBtn: {
    background: 'none',
    border: 'none',
    borderBottom: '1px solid var(--line)',
    color: 'var(--accent-ink)',
    cursor: 'pointer',
    font: `11px ${MONO}`,
    padding: 0
  },
  btnOff: { opacity: 0.4, cursor: 'not-allowed' }
}
