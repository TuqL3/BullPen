import { useEffect, useState } from 'react'
import type { WorkflowInfo } from '../../preload/index'
import { FLOORS } from './floor/tiles'
import { OrgChart } from './OrgChart'
import { LABEL, MONO } from './theme'



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
 * How the floor and this machine are set up.
 *
 * Two sections, one row of them - not the column of groups with a row of tabs
 * under it this used to be, which was two levels of navigation for three
 * destinations. The floor is one click, the rest of it is one click, and each
 * is one page with no navigation inside it.
 *
 * The floor is here rather than on a button of its own because it is
 * configuration: it is set up once and come back to when the way the company
 * works changes, which is the same shelf as everything else in this dialog.
 */
type Section = 'floor' | 'app'

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
  const [section, setSection] = useState<Section>('floor')
  const [dirty, setDirty] = useState(false)
  const [stale, setStale] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.bullpen.workflow().then((r) => setStale(r.stale))
  }, [workflow])

  /**
   * Closing throws the drawing away, so it asks first when there is one.
   *
   * The backdrop and the × both do it, and the backdrop is the one somebody
   * hits by accident - a click a few pixels outside used to be the cheapest
   * way to lose a floor.
   */
  const shut = (): void => {
    if (dirty && !confirm('The floor has unsaved changes. Close and lose them?')) return
    onClose()
  }

  const SECTIONS: [Section, string, string][] = [
    ['floor', 'the floor', 'who is on it, and how work moves between them'],
    ['app', 'this app', 'this machine, not this floor']
  ]

  return (
    <div style={S.wrap} onClick={shut}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.head}>
          {SECTIONS.map(([key, title, hint]) => (
            <button
              key={key}
              title={hint}
              style={{ ...S.tab, ...(section === key ? S.tabOn : null) }}
              onClick={(e) => {
                e.currentTarget.blur()
                setSection(key)
              }}
            >
              {title}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button style={S.icon} title="close" aria-label="close" onClick={shut}>
            ×
          </button>
        </div>

        {/* The chart draws itself into whatever it is given, so it needs a box
            that is allowed to shrink - without `minHeight: 0` a flex child sizes
            to its content and the canvas pushes the dialog off screen. */}
        {section === 'floor' ? (
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <OrgChart workflow={workflow} onApplied={onApplied} onDirty={setDirty} />
          </div>
        ) : (
          <div style={S.page}>
            <LookPane
              mode={mode}
              onMode={onMode}
              notifyOn={notifyOn}
              onNotify={onNotify}
              prefs={prefs}
              onPrefs={onPrefs}
            />
            <div style={S.rule} />
            <AgentsPane onMoveGod={onMoveGod} />
          </div>
        )}

        <div style={S.foot}>
          {section === 'floor' && stale.length > 0 ? (
            <>
              <span style={{ color: 'var(--faint)', flex: 1 }}>
                {stale.length} agent{stale.length === 1 ? '' : 's'} still on the shape they
                started on — a brief is handed over once, at spawn.
              </span>
              <button
                style={S.btn}
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  await onRestartFloor()
                  setStale([])
                  setBusy(false)
                }}
              >
                {busy ? 'restarting…' : 'restart the standing ones'}
              </button>
            </>
          ) : (
            <span style={{ color: 'var(--faint)', flex: 1 }}>
              everything here saves as you change it
            </span>
          )}
        </div>
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
            // Blurred on the way out: a button the pointer chose keeps focus,
            // and the ring around it reads as a second kind of selected.
            onClick={(e) => {
              e.currentTarget.blur()
              onMode(m)
            }}
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
            onClick={(e) => {
              e.currentTarget.blur()
              onPrefs({ floor: f })
            }}
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
  onMoveGod
}: {
  onMoveGod: () => Promise<void>
}) {
  const [cwd, setCwd] = useState('')

  useEffect(() => {
    window.bullpen.godCwd().then(setCwd)
  }, [])

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
  // Filled when on, nothing when off. The underline it used to carry was a
  // transparent border in the off state, and a transparent border still draws.
  /** A dot on the one the floor is actually running, which is not the same
   *  question as which one is open in the editor. */
  // One mark, and only on the selected row. A transparent border kept as a
  // spacer still draws - every row had a rule down its left edge and the list
  // read as four things selected. Nothing here paints unless it is chosen.
  /** The generator's own dialog: narrow, and over the top of the big one. */

  // A home directory is as long as somebody's username makes it, and `term`
  // refuses to wrap - one path put a horizontal scrollbar under the whole panel.
  path: {
    color: 'var(--ink)',
    background: 'var(--panel)',
    padding: '0 3px',
    overflowWrap: 'anywhere' as const
  },
  pane: { flex: 1, minWidth: 0, overflow: 'auto', paddingRight: 4 },
  formRow: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 },
  foot: { display: 'flex', gap: 8, alignItems: 'center' },
  /** One scrolling page. There is nothing to navigate between any more. */
  page: { flex: 1, minHeight: 0, overflow: 'auto', paddingRight: 4 },
  rule: { height: 1, background: 'var(--line)', margin: '18px 0' },
  btn: {
    background: 'transparent',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    cursor: 'pointer',
    padding: '5px 12px',
    font: `12px ${MONO}`
  },
  /** Chosen, and unmistakably so. A border one shade off the unchosen ones is
   *  not an answer to "which of these am I on", and next to a button the click
   *  left focused it read as the focus ring rather than as the choice. */
  btnGo: { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#241f1a' },
  /** Two of them, in the header. One row, one level. */
  tab: {
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: 'var(--muted)',
    cursor: 'pointer',
    padding: '4px 10px',
    font: `11px ${MONO}`,
    textTransform: 'uppercase',
    letterSpacing: '0.08em'
  },
  tabOn: { color: 'var(--ink)', borderBottomColor: 'var(--accent)' }
}
