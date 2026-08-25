import { useEffect, useRef, useState } from 'react'
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
  /** The chart's own save, so `shut` can offer it. */
  const saveFloor = useRef<(() => Promise<boolean>) | null>(null)
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
  /**
   * The unsaved question, and what to do when the dialog behind it is not
   * there yet: main and this window reload separately, and a press that throws
   * because the bridge is a version behind is a press that silently does
   * nothing. Two answers rather than three, and never the destructive one by
   * accident.
   */
  const askUnsaved = async (detail: string): Promise<'save' | 'discard' | 'cancel'> =>
    window.bullpen.unsavedAsk
      ? window.bullpen.unsavedAsk(detail)
      : confirm(`${detail}\n\nLeave without saving?`)
        ? 'discard'
        : 'cancel'

  /**
   * Leaving the floor for another tab, which unmounts the canvas.
   *
   * The × and the backdrop asked; this did not, and it is one click away from
   * both - so the cheapest way to lose a drawing was to glance at the other
   * tab. Same question, same three answers.
   */
  const go = async (to: Section): Promise<void> => {
    if (to === section) return
    if (section === 'floor' && dirty) {
      const ans = await askUnsaved('The drawing is not kept when you leave it.')
      if (ans === 'cancel') return
      if (ans === 'save' && !(await saveFloor.current?.())) return
    }
    setSection(to)
  }

  const shut = async (): Promise<void> => {
    if (dirty) {
      const ans = await askUnsaved('Closing takes the drawing off the screen.')
      if (ans === 'cancel') return
      // Saving can fail - a file that does not read as a floor, a disk that
      // says no - and closing over a save that did not happen is the same lost
      // drawing the question was asked to prevent.
      if (ans === 'save' && !(await saveFloor.current?.())) return
    }
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
              onClick={() => go(key)}
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
            {/* Not until there is one to draw.
                `OrgChart` returns early when it has no floor, and three of its
                effects are declared after that return - so mounting it empty
                and handing it a floor a moment later changed the number of
                hooks between two renders, which React answers by unmounting
                the tree. Nothing opened this dialog before the floor had
                arrived until `apply` started reopening it on the way back in,
                and then the window came back blank. */}
            {workflow ? (
              <OrgChart
                workflow={workflow}
                onDirty={(d, save) => {
                  setDirty(d)
                  saveFloor.current = save
                }}
              />
            ) : (
              <div style={{ color: 'var(--faint)', padding: 8 }}>reading the floor…</div>
            )}
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
            <div style={S.rule} />
            <SyncPane />
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

/**
 * The same floors on the other machine.
 *
 * Three presses and no daemon. A sync that runs on its own is a sync that
 * overwrites work while somebody is in the middle of it, and last-write-wins
 * has no opinion about who was typing - so the operator says when, and is told
 * afterwards which way it went and whose version won.
 *
 * What crosses is the floors and the settings that mean the same thing
 * anywhere. Not where Michael works, not the window size, not the webhook
 * token, and not which floor is running: pulling that would swap the floor out
 * from under agents already standing on it.
 */
function SyncPane() {
  const [state, setState] = useState<{
    gist: string
    machine: string
    hasToken: boolean
    user: string
    keyring: boolean
    canSignIn: boolean
    floors: number
  } | null>(null)
  /** The code GitHub is waiting to be told, while it is being told. */
  const [code, setCode] = useState<{ userCode: string; url: string } | null>(null)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  /**
   * `confirm` asks GitHub who the stored token belongs to - which means
   * decrypting it, which on macOS means the keychain.
   *
   * Not done on mount any more. A token can be revoked from the other side and
   * the remembered name go stale, but the cost of checking was a login-password
   * prompt every time this pane was opened after an update: the keychain item's
   * ACL is tied to the code signature, and an ad-hoc signed app signs
   * differently every build. The name is confirmed after the two presses that
   * use the token anyway, and a token revoked from the other side says so in
   * the error from `sync now` rather than in silence.
   */
  const read = (confirm = false): void => {
    window.bullpen.syncStatus().then((s) => {
      setState(s)
      if (confirm && s.hasToken) {
        window.bullpen.whoAmI().then((who) => {
          if (who.login) setState((was) => (was ? { ...was, user: who.login! } : was))
        })
      }
    })
  }
  useEffect(() => read(), [])

  if (!state) return <div style={{ color: 'var(--faint)' }}>reading…</div>

  const ready = state.hasToken

  return (
    <div>
      <div style={{ ...LABEL, color: 'var(--accent-ink)' }}>the same floors elsewhere</div>
      <div style={{ color: 'var(--faint)', lineHeight: 1.6, margin: '2px 0 10px' }}>
        Floors and the settings that travel, through a secret gist. Whichever machine syncs last
        is the one that wins — this is not a merge. Nothing about <i>this</i> machine goes up:
        not where Michael works, not the webhook token, not which floor is running.
      </div>

      <div style={S.row}>
        <span style={S.rowLabel}>this machine</span>
        <input
          style={S.field}
          value={state.machine}
          placeholder="laptop"
          title="what the other machine sees when this one wins"
          onChange={(e) => setState({ ...state, machine: e.target.value })}
          onBlur={async () => {
            await window.bullpen.setSync({ machine: state.machine })
            read()
          }}
        />
      </div>

      {/* The sign-in, and the only way in. GitHub shows a box and this shows
          the code that goes in it - no server, no redirect, nothing pasted out
          of a settings page on github.com. */}
      <div style={S.row}>
        <span style={S.rowLabel}>github</span>
        {state.hasToken ? (
          <>
            <span style={{ flex: 1, color: 'var(--ok)' }}>
              signed in{state.user ? ' as ' : ''}
              {state.user && <b style={{ color: 'var(--accent-ink)' }}>{state.user}</b>}
            </span>
            <button
              style={S.btn}
              title="forget this account on this machine"
              onClick={async () => {
                if (!confirm('Sign out? This machine stops syncing until you sign in again.')) return
                await window.bullpen.setSync({ token: '' })
                setNote('Signed out.')
                read()
              }}
            >
              sign out
            </button>
          </>
        ) : (
          <>
            {code ? (
              <span style={{ flex: 1, lineHeight: 1.6 }}>
                Type{' '}
                <b style={{ color: 'var(--accent-ink)', letterSpacing: '0.12em' }}>{code.userCode}</b>{' '}
                at <span style={{ color: 'var(--muted)' }}>{code.url}</span> — waiting…
              </span>
            ) : (
              <button
                style={{ ...S.btn, ...S.btnGo }}
                disabled={busy !== ''}
                onClick={async () => {
                  setBusy('signin')
                  setError('')
                  setNote('')
                  const got = await window.bullpen.signIn()
                  if (got.error || !got.userCode || !got.url) {
                    setBusy('')
                    return setError(got.error ?? 'GitHub did not send a code.')
                  }
                  setCode({ userCode: got.userCode, url: got.url })
                  const done = await window.bullpen.awaitSignIn()
                  setCode(null)
                  setBusy('')
                  if (done.error) return setError(done.error)
                  setNote('Signed in.')
                  read(true)
                }}
              >
                {busy === 'signin' ? 'waiting…' : 'sign in with GitHub'}
              </button>
            )}
          </>
        )}
      </div>

      {!state.keyring && state.hasToken && (
        <div style={{ color: 'var(--warn)', lineHeight: 1.6, marginBottom: 6 }}>
          No keyring on this machine, so the token is written plainly in{' '}
          <code>~/.bullpen/credentials</code>. Said rather than hidden.
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <span style={{ color: 'var(--faint)', flex: 1, lineHeight: 1.5 }}>
          {state.floors} floor{state.floors === 1 ? '' : 's'} here
        </span>
        <button
          style={{ ...S.btn, ...(ready ? S.btnGo : null) }}
          disabled={!ready || busy !== ''}
          title={ready ? 'read what is up there, and let the clock decide' : 'sign in first'}
          onClick={async () => {
            setBusy('now')
            setError('')
            setNote('')
            const res = await window.bullpen.syncNow()
            setBusy('')
            if (res.error) return setError(res.error)
            if (res.went === 'up') setNote(`Up: ${res.floors} floors from here.`)
            else {
              const gone = res.dropped?.length ? `, ${res.dropped.length} taken off` : ''
              setNote(`Down: ${res.floors} floors from ${res.from}${gone}.`)
            }
            read(true)
          }}
        >
          {busy === 'now' ? 'syncing…' : 'sync now'}
        </button>
      </div>
      {/* Where it went. Nothing on this pane used to say - the gist id had a
          field of its own and then the field was taken out, which left "Up: 3
          floors from here" and no way to go and look at them. */}
      {state.gist && (
        <div style={{ color: 'var(--faint)', marginTop: 6, lineHeight: 1.6 }}>
          through gist <code>{state.gist.slice(0, 8)}</code> on {state.user || 'GitHub'} —{' '}
          <a
            href={`https://gist.github.com/${state.gist}`}
            style={{ color: 'var(--accent-ink)' }}
            onClick={(e) => {
              e.preventDefault()
              window.bullpen.openExternal(`https://gist.github.com/${state.gist}`)
            }}
          >
            open it
          </a>
        </div>
      )}
      {note && <div style={{ color: 'var(--ok)', marginTop: 6 }}>{note}</div>}
      {error && <div style={{ color: 'var(--danger)', marginTop: 6, lineHeight: 1.6 }}>{error}</div>}
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
  /** What the last test notification did, or why it could not. */
  const [tested, setTested] = useState('')
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
      {/* The switch says what Bullpen will send. Whether anything arrives is
          the operating system's answer, and on macOS it is given once, in a
          panel nobody comes back to - so ask it here rather than leaving a
          ticked box standing in for a permission that was refused. */}
      <div style={{ ...S.formRow, gap: 10 }}>
        <button
          style={S.btn}
          onClick={async () => {
            const res = await window.bullpen.notifyTest()
            setTested(res.error ?? 'Sent. Nothing on screen means this machine is refusing them.')
          }}
        >
          send a test
        </button>
        {tested && <span style={{ color: 'var(--muted)', lineHeight: 1.5 }}>{tested}</span>}
      </div>
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
  /** A label and its control on one line, the way the rest of this pane reads. */
  row: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 },
  rowLabel: { color: 'var(--muted)', width: 96, flex: '0 0 auto' },
  field: {
    flex: 1,
    minWidth: 0,
    background: 'var(--panel)',
    border: '1px solid',
    borderColor: 'var(--line)',
    color: 'var(--ink)',
    font: 'inherit',
    padding: '4px 6px'
  },
  btn: {
    background: 'transparent',
    color: 'var(--muted)',
    border: '1px solid',
    borderColor: 'var(--line)',
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
    // Longhand, because `tabOn` sets `borderBottomColor`: React clears that
    // on the way out without rewriting the shorthand still in the object, and
    // the tab nobody was on kept an underline in `currentcolor`.
    borderBottom: '2px solid',
    borderBottomColor: 'transparent',
    color: 'var(--muted)',
    cursor: 'pointer',
    padding: '4px 10px',
    font: `11px ${MONO}`,
    textTransform: 'uppercase',
    letterSpacing: '0.08em'
  },
  tabOn: { color: 'var(--accent-ink)', borderBottomColor: 'var(--accent-ink)' }
}
