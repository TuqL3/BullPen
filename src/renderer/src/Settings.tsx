import { useEffect, useRef, useState } from 'react'
import type { WorkflowInfo } from '../../preload/index'
import { Markdown } from './Markdown'
import { WORKFLOW_SPEC } from '../../workflow-spec'
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
export function Settings({
  workflow,
  onClose,
  onApplied,
  onRestartFloor
}: {
  workflow: WorkflowInfo | null
  onClose: () => void
  onApplied: (w: WorkflowInfo) => void
  /** Take the standing agents down and bring them back on the running shape. */
  onRestartFloor: () => Promise<void>
}) {
  const [saved, setSaved] = useState<Saved[]>([])
  const [text, setText] = useState('')
  const [problems, setProblems] = useState<string[]>([])
  const [preview, setPreview] = useState<WorkflowInfo | null>(null)
  const [note, setNote] = useState('')
  const [stale, setStale] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [help, setHelp] = useState(false)
  /** The sentence a floor is described in, before there is a file for it. */
  /** The describe-a-floor dialog: open, what was asked, and what came back. */
  const [describing, setDescribing] = useState(false)
  /**
   * Two different questions, and conflating them is what made `apply` go grey
   * the moment a workflow was picked from the list:
   *
   * `running` is what the floor is on now - `apply` is offered whenever the
   * editor differs from it, which is exactly when there is a switch to make.
   * `loaded` is the text as it arrived in the editor - unsaved work is the
   * difference from that, which is what closing has to warn about.
   */
  const [running, setRunning] = useState('')
  const [loaded, setLoaded] = useState('')

  /**
   * The source and its rendering scroll together.
   *
   * Proportionally, not line for line: rendered text is shorter than its source
   * - a heading loses its hashes, a bullet loses its dash - so matching pixels
   * would drift apart down the page. `syncing` is the loop guard: setting
   * scrollTop fires the other pane's own scroll handler.
   *
   * Only these two. The structure panel is a summary of the whole document
   * rather than a view of part of it, so there is no position in it to keep.
   */
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const readRef = useRef<HTMLDivElement>(null)
  const syncing = useRef(false)

  const sync = (from: HTMLElement | null, to: HTMLElement | null): void => {
    if (!from || !to || syncing.current) return
    const fromMax = from.scrollHeight - from.clientHeight
    const toMax = to.scrollHeight - to.clientHeight
    if (fromMax <= 1 || toMax <= 1) return
    syncing.current = true
    to.scrollTop = (from.scrollTop / fromMax) * toMax
    requestAnimationFrame(() => {
      syncing.current = false
    })
  }

  /**
   * Drop the focus ring a mouse click leaves behind.
   *
   * A toggle that keeps focus after being clicked off still looks pressed, and
   * on a button whose whole job is "on or off" that reads as the click not
   * having worked. Keyboard focus is untouched: tabbing to it still rings it,
   * because nothing here removes the outline.
   */
  const unfocus = (e: React.MouseEvent<HTMLElement>): void => e.currentTarget.blur()

  /**
   * Take me to the thing that is wrong.
   *
   * A problem naming a blank is a place in the document, and reading it out of
   * the text was the operator's job: five blanks scattered through forty lines
   * of brief, found by eye. The linter already knows which one it means - it
   * quotes it - so the list becomes what it always described, a set of places
   * to go.
   *
   * Searched forward from where the cursor is and wrapped, so the same blank
   * appearing in two roles walks between them rather than always landing on the
   * first.
   */
  const goTo = (problem: string): void => {
    const blank = /«[^»]*»/.exec(problem)?.[0]
    const box = editorRef.current
    if (!blank || !box) return
    const from = box.selectionEnd
    const at = text.indexOf(blank, from) === -1 ? text.indexOf(blank) : text.indexOf(blank, from)
    if (at === -1) return
    box.focus()
    box.setSelectionRange(at, at + blank.length)
    // Selecting does not scroll on its own when the range is off-screen. Line
    // height times the line number is close enough, and centred so there is
    // context above it rather than the blank pinned to the top edge.
    const line = text.slice(0, at).split('\n').length
    box.scrollTop = Math.max(0, line * LINE_PX - box.clientHeight / 2)
  }

  /**
   * Tab walks the blanks, the way it walks the fields of a form - which is what
   * a half-filled template is. Only while any are left: once they are gone the
   * key goes back to moving focus out of the box, which is what it is for.
   */
  const onTab = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Tab' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
    const box = e.currentTarget
    const rest = text.slice(box.selectionEnd)
    const ahead = /«[^»]*»/.exec(rest)
    const found = ahead
      ? { at: box.selectionEnd + ahead.index, len: ahead[0].length }
      : (() => {
          const first = /«[^»]*»/.exec(text)
          return first ? { at: first.index, len: first[0].length } : null
        })()
    if (!found) return
    e.preventDefault()
    box.setSelectionRange(found.at, found.at + found.len)
    const line = text.slice(0, found.at).split('\n').length
    box.scrollTop = Math.max(0, line * LINE_PX - box.clientHeight / 2)
  }

  const reload = (): Promise<void> => window.bullpen.workflowList().then(setSaved)

  useEffect(() => {
    reload()
    window.bullpen.workflow().then((r) => {
      setText(r.markdown)
      setRunning(r.markdown)
      setLoaded(r.markdown)
      setStale(r.stale)
    })
  }, [])

  /**
   * Checked as you type, not only on apply: every problem the linter finds is
   * one that fails silently at runtime - a card that never moves, a report that
   * reaches nobody - and finding that out an hour into a run is finding out too
   * late. Debounced because it crosses to main on every keystroke otherwise.
   */
  useEffect(() => {
    if (!text.trim()) return
    const t = setTimeout(async () => {
      const r = await window.bullpen.lintWorkflow(text)
      setProblems(r.problems)
      setPreview(r.preview)
    }, 350)
    return () => clearTimeout(t)
  }, [text])

  const edit = (next: string): void => {
    setText(next)
    setNote('')
  }

  /** Unsaved typing, as opposed to "this is a different workflow than is running". */
  const dirty = text !== loaded
  /** There is a switch to make: what is in the editor is not what is running. */
  const changed = text.trim().length > 0 && text !== running
  const editing = nameOf(text)
  /**
   * Something in the editor that is not one of the saved workflows - which is
   * what `+ new workflow` produces, and the only time having one written for
   * you is on offer. Offering it while a saved floor is open would be offering
   * to overwrite it.
   */
  const unsaved = Boolean(editing) && !saved.some((p) => p.name === editing)

  const load = (md: string, force = false): void => {
    if (!force && dirty && !confirm('Discard the changes in the editor?')) return
    edit(md)
    setLoaded(md)
  }

  const keep = async (): Promise<void> => {
    setBusy(true)
    const res = await window.bullpen.saveWorkflow(text)
    setNote(res.error ?? `Saved "${res.name}" — kept, not running.`)
    if (!res.error) {
      setLoaded(text)
      await reload()
    }
    setBusy(false)
  }

  const drop = async (name: string): Promise<void> => {
    if (!confirm(`Delete the "${name}" workflow? The file is removed.`)) return
    const res = await window.bullpen.deleteWorkflow(name)
    if (res.error) return setNote(res.error)
    await reload()
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    setNote('')
    const res = await window.bullpen.setWorkflow(text)
    if (res.error) setNote(res.error)
    else if (res.workflow) {
      onApplied(res.workflow)
      setRunning(res.markdown ?? text)
      setLoaded(res.markdown ?? text)
      // Re-read who is stale: the ones that were running before this apply are
      // now the ones on the old shape, and that is the list the button offers.
      const after = await window.bullpen.workflow()
      setStale(after.stale)
      setNote(after.stale.length ? '' : 'Running.')
      reload()
    }
    setBusy(false)
  }

  const moveFloor = async (): Promise<void> => {
    if (
      !confirm(
        `Restart the standing agents on "${workflow?.name}"?\n\nA brief is given once, at spawn, so this is the only way to move them. Their conversations are lost. Hired agents are left alone.`
      )
    )
      return
    setBusy(true)
    setNote('')
    await onRestartFloor()
    setStale((await window.bullpen.workflow()).stale)
    setNote('The floor is on the new shape.')
    setBusy(false)
  }

  const shut = (): void => {
    if (dirty && !confirm('Close without applying? The changes are lost.')) return
    onClose()
  }

  return (
    <div style={S.wrap} onClick={shut}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.head}>
          <span style={{ ...LABEL, color: 'var(--ink)' }}>workflow</span>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {unsaved && (
              <button
                style={S.tab}
                title="say what the floor should do and have one written"
                onClick={(e) => {
                  unfocus(e)
                  setDescribing(true)
                }}
              >
                describe one
              </button>
            )}
            <button
              style={{ ...S.tab, ...(help ? S.tabOn : null) }}
              title="what the format means"
              onClick={(e) => {
                unfocus(e)
                setHelp(!help)
              }}
            >
              help
            </button>
            <button style={S.icon} title="close" aria-label="close" onClick={shut}>
              <Glyph name="close" />
            </button>
          </div>
        </div>

        <div style={S.split}>
          {/* A column rather than a row of chips: it is a list of documents, and
              a list reads down. It also has room to say which one is running
              and which one is open without either being a coloured border. */}
          <div style={S.list}>
            {saved.map((p) => {
              const open = p.name === editing
              return (
                <div key={p.name} style={{ ...S.item, ...(open ? S.itemOn : null) }}>
                  <button
                    style={S.itemName}
                    title={`${p.description}${p.builtin ? ' · ships with Bullpen' : ''}`}
                    onClick={(e) => {
                      unfocus(e)
                      load(p.markdown, open)
                    }}
                  >
                    <span style={S.itemText}>{p.name}</span>
                    {p.name === workflow?.name && <span style={S.running} title="running now" />}
                  </button>
                  {/* A preset is the only copy of an example of the format. */}
                  {!p.builtin && (
                    <button style={S.chipX} title={`delete ${p.name}`} onClick={() => drop(p.name)}>
                      ×
                    </button>
                  )}
                </div>
              )
            })}

            {/* Something in the editor that is not any of the above. Without a
                row of its own, picking "new" left every entry unhighlighted and
                nothing at all saying what was on screen. */}
            {unsaved && (
              <div style={{ ...S.item, ...S.itemOn }}>
                <span style={{ ...S.itemName, cursor: 'default' }}>
                  <span style={S.itemText}>{editing}</span>
                  <span style={S.unsaved}>new</span>
                </span>
              </div>
            )}

            <button
              style={S.new}
              title="a blank floor to fill in"
              onClick={async () => load(await window.bullpen.workflowStarter())}
            >
              + new workflow
            </button>
          </div>

          <textarea
            ref={editorRef}
            spellCheck={false}
            value={text}
            onChange={(e) => edit(e.target.value)}
            onScroll={() => sync(editorRef.current, readRef.current)}
            onKeyDown={onTab}
            style={S.editor}
          />

          {/* Read back out of the same parse the router will do. A preview that
              agrees with the editor but not with main is worse than none. */}
          {/* Both readings at once rather than a tab between them: they answer
              different questions - "does the brief say what I meant" and "what
              floor is this" - and switching to check the second one loses your
              place in the first.

              Rendered text next to the source it came from, so the eye moves a
              short distance to compare them; the structure table is a summary
              and reads fine from the far end. */}
          <Markdown
            text={text}
            style={S.reader}
            innerRef={readRef}
            onScroll={() => sync(readRef.current, editorRef.current)}
          />
          <div style={S.side}>
            {help ? (
              <Help />
            ) : (
              <Preview name={editing} wf={preview} problems={problems} onGoTo={goTo} />
            )}
          </div>
        </div>

        {note && <div style={S.note}>{note}</div>}

        {describing && (
          <Describe
            onClose={() => setDescribing(false)}
            onUse={(md) => {
              if (dirty && !confirm('Discard the changes in the editor?')) return
              edit(md)
              setLoaded(md)
              setDescribing(false)
              setNote('Written. Read it before you run it.')
            }}
          />
        )}

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
              'nobody is running'
            )}
          </span>
          <button style={S.btn} onClick={shut}>
            cancel
          </button>
          <button
            style={{ ...S.btn, ...(problems.length || busy || !dirty ? S.btnOff : null) }}
            disabled={problems.length > 0 || busy || !dirty}
            title="keep this without running it"
            onClick={keep}
          >
            save
          </button>
          <button
            style={{ ...S.btn, ...(problems.length || busy || !changed ? S.btnOff : S.btnGo) }}
            disabled={problems.length > 0 || busy || !changed}
            title={changed ? `run this instead of "${workflow?.name}"` : 'this is already running'}
            onClick={apply}
          >
            {changed && editing !== workflow?.name ? `switch to ${editing}` : 'apply'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Say what the floor should do; read what gets written.
 *
 * A dialog of its own rather than a box in the sidebar, for two reasons: it
 * takes a couple of minutes and needs somewhere to say so, and what comes back
 * is a document to read before it goes anywhere near the editor. Nothing is
 * written into the editor until `use it` - a generated floor is a draft, and
 * dropping it silently over whatever was open is how you lose work you meant to
 * keep.
 */
function Describe({ onClose, onUse }: { onClose: () => void; onUse: (md: string) => void }) {
  const [want, setWant] = useState('')
  const [writing, setWriting] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [error, setError] = useState('')

  const write = async (): Promise<void> => {
    if (!want.trim() || writing) return
    setWriting(true)
    setError('')
    const res = await window.bullpen.generateWorkflow(want)
    if (res.error) setError(res.error)
    else if (res.markdown) {
      setDraft(res.markdown)
      setProblems(res.problems ?? [])
    }
    setWriting(false)
  }

  return (
    <div style={S.wrap} onClick={onClose}>
      <div style={S.small} onClick={(e) => e.stopPropagation()}>
        <div style={S.head}>
          <span style={{ ...LABEL, color: 'var(--ink)' }}>describe a floor</span>
          <button style={S.icon} title="close" aria-label="close" onClick={onClose}>
            <Glyph name="close" />
          </button>
        </div>

        <div style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.6 }}>
          Who is on it, who hands work to whom, and who decides a task is finished.
          Plain sentences — the roles and the briefs get written for you.
        </div>

        <textarea
          autoFocus
          value={want}
          disabled={writing}
          placeholder={'a boss, a designer who writes the spec, and two builders who take turns; nobody tests'}
          onChange={(e) => setWant(e.target.value)}
          style={S.wantBox}
        />

        {/* The wait is real - a four-role floor measured over two minutes - so
            it is said out loud rather than left to look like a hang. */}
        {writing && <div style={S.note}>Writing it. This takes a couple of minutes.</div>}
        {error && <div style={S.problems}>{error}</div>}

        {draft && !writing && (
          <>
            {problems.length > 0 ? (
              <div style={S.problems}>
                {problems.map((p) => (
                  <div key={p}>· {p}</div>
                ))}
                <div style={{ marginTop: 4, color: 'var(--muted)' }}>
                  Use it anyway and fix these in the editor, or ask again.
                </div>
              </div>
            ) : (
              <div style={S.ok}>· this floor will run</div>
            )}
            <Markdown text={draft} style={S.draftBox} />
          </>
        )}

        <div style={S.foot}>
          <span style={{ flex: 1 }} />
          <button style={S.btn} onClick={onClose}>
            cancel
          </button>
          <button
            style={{ ...S.btn, ...(writing || !want.trim() ? S.btnOff : null) }}
            disabled={writing || !want.trim()}
            onClick={write}
          >
            {writing ? 'writing…' : draft ? 'write again' : 'write it'}
          </button>
          {draft && (
            <button
              style={{ ...S.btn, ...(writing ? S.btnOff : S.btnGo) }}
              disabled={writing}
              title="put this in the editor - it does not run anything"
              onClick={() => onUse(draft)}
            >
              use it
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * What the text in the editor actually describes.
 *
 * The six structural lines per role are buried in pages of brief, and reading
 * them back out is the only way to see the floor rather than the document.
 */
function Preview({
  name,
  wf,
  problems,
  onGoTo
}: {
  name: string
  wf: WorkflowInfo | null
  problems: string[]
  /** Put the cursor on the blank this problem is about. */
  onGoTo: (problem: string) => void
}) {
  return (
    <>
      {problems.length > 0 ? (
        <div style={S.problems}>
          {problems.map((p) => {
            const place = /«[^»]*»/.test(p)
            return (
              <div
                key={p}
                role={place ? 'button' : undefined}
                title={place ? 'go to it' : undefined}
                style={{ ...S.problem, ...(place ? S.problemGo : null) }}
                onClick={place ? () => onGoTo(p) : undefined}
              >
                · {p}
              </div>
            )
          })}
        </div>
      ) : (
        <div style={S.ok}>· this floor will run</div>
      )}

      {wf && (
        <div style={S.previewBody}>
          <div style={{ ...LABEL, color: 'var(--accent-ink)' }}>{wf.name || name}</div>
          {wf.description && (
            <div style={{ color: 'var(--muted)', marginBottom: 8 }}>{wf.description}</div>
          )}
          {Object.entries(wf.roles).map(([role, def]) => (
            <div key={role} style={S.card}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--ink)' }}>{role}</span>
                {def.fixed && (
                  <span style={{ color: 'var(--faint)' }}>
                    {def.fixed.id} · {def.fixed.name}
                  </span>
                )}
                {role === wf.dispatch && <span style={S.badge}>dispatch</span>}
                {role === wf.entry && <span style={S.badge}>entry</span>}
                {def.hireable && <span style={S.badge}>hireable</span>}
                {!def.fixed && !def.hireable && <span style={S.warnBadge}>unreachable</span>}
              </div>
              <div style={{ color: 'var(--faint)' }}>
                {def.can.length ? def.can.join(' · ') : 'no capabilities — it can only carry mail'}
              </div>
              <div style={{ color: 'var(--muted)' }}>
                → {(wf.talksTo[role] ?? []).join(', ') || 'nobody'}
              </div>
            </div>
          ))}
          <div style={{ color: 'var(--faint)', marginTop: 6 }}>
            reuse below {wf.reuseBelowPct}% · hire above {wf.hireAbovePct}%
          </div>
        </div>
      )}
    </>
  )
}

/**
 * The format, in the dialog rather than in a document nobody opens.
 *
 * Opens in the same panel as the preview rather than pushing the editor down:
 * a person reads this while typing into the pane beside it.
 */
function Help() {
  return (
    <div style={S.previewBody}>
      <div style={{ color: 'var(--muted)', lineHeight: 1.7, marginBottom: 10 }}>
        A workflow is one markdown file. <code style={S.term}>##</code> starts a role. The
        bullets under it say what that role can do and who it may write to. Everything
        after the bullets is what that agent is told the moment it starts.
      </div>
      {WORKFLOW_SPEC.map(({ title, rows }) => (
        <div key={title} style={{ marginBottom: 10 }}>
          <div style={{ ...LABEL, color: 'var(--accent-ink)', marginBottom: 4 }}>{title}</div>
          {rows.map(([term, what]) => (
            <div key={term} style={S.helpRow}>
              <code style={S.term}>{term}</code>
              <span style={{ color: 'var(--muted)' }}>{what}</span>
            </div>
          ))}
        </div>
      ))}
      <div style={{ color: 'var(--faint)', lineHeight: 1.7 }}>
        The router reads capabilities, not names — a role called{' '}
        <code style={S.term}>reviewer</code> that checks moves cards exactly like one called{' '}
        <code style={S.term}>tester</code>. Anything between <code style={S.term}>&lt;!--</code>{' '}
        and <code style={S.term}>--&gt;</code> is a note to yourself and never reaches an agent.
      </div>
    </div>
  )
}

/** Inline rather than imported: the icon set lives in App. */
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
  note: { fontSize: 11, color: 'var(--warn)', lineHeight: 1.5, flex: '0 0 auto' },
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
