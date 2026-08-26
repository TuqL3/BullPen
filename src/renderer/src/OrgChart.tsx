import { useEffect, useRef, useState } from 'react'
import type { WorkflowInfo } from '../../preload/index'
import {
  anchor,
  edges,
  freeRoleId,
  shapeKey,
  fillRules,
  ruled,
  firing,
  link,
  ranks,
  staffed,
  takeLineOff,
  LABEL_H,
  layout,
  NODE_H,
  NODE_W,
  type ChartNode
} from './chart'
import { buildsCapabilityIn, HOUSE_CAPABILITIES } from './shape'
import { useStore } from './store'
import { LABEL, MONO } from './theme'

/**
 * The floor, built by dragging.
 *
 * Everything about a floor used to be a tab: roles here, capabilities there,
 * the board somewhere else, and the card rules in a fourth place - six screens
 * describing one thing, and a person expected to hold the shape in their head
 * while moving between them.
 *
 * One screen instead. The chart is the floor; whatever is selected is what the
 * panel on the right edits. Add a box, drag a line, fill in the panel, save -
 * and what gets written is still the same markdown file, because that is what
 * the router reads and what you would hand to somebody else.
 */
export function OrgChart({
  workflow,
  onDirty
}: {
  workflow: WorkflowInfo | null
  /** Told whenever the drawing has changes that are not written down. */
  onDirty?: (dirty: boolean, save: () => Promise<boolean>) => void
}) {
  /** The whole floor, edited in one place and saved in one go. */
  const [draft, setDraft] = useState<WorkflowInfo | null>(workflow)
  /** The drawing as it was last written down, which is what `dirty` is against. */
  const [saved, setSaved] = useState<WorkflowInfo | null>(workflow)
  /** And whether the file beside it has been typed in since. */
  const [fileEdited, setFileEdited] = useState(false)
  /**
   * The shape of the floor the rules were last written for.
   *
   * A rule is about a pair, and moving a line moves the pair - so rules that
   * were right a moment ago are now about a floor that is not on screen. Saving
   * that is how a file comes to describe a drawing nobody drew, and it cannot
   * be spotted by reading either one on its own.
   */
  const [ruledAt, setRuledAt] = useState(() => shapeKey(workflow))
  /**
   * The floors that come with Bullpen rather than off disk.
   *
   * One of them is running the first time the app opens, and it is not written
   * over: main refuses the save and says to give it another name. The buttons
   * that lead there were on the bar anyway - `write it` exists to unblock a
   * save, and there is no save on this floor to unblock - so the one press an
   * operator was offered on the floor they start on was the one press that
   * could not finish.
   */
  const [shipped, setShipped] = useState<string[]>([])
  useEffect(() => {
    let live = true
    window.bullpen.workflowList().then((all) => {
      if (live) setShipped(all.filter((w) => w.builtin).map((w) => w.name))
    })
    return () => {
      live = false
    }
  }, [])
  const [nodes, setNodes] = useState<ChartNode[]>([])
  /**
   * What is open, and where.
   *
   * A panel down the side was on screen whether or not anybody was editing
   * anything - a column of boxes describing the floor next to a drawing of the
   * same floor. Now nothing is open until something is clicked, and what opens
   * appears where the click was.
   */
  const [panel, setPanel] = useState<
    | {
        kind: 'role' | 'file' | 'edge' | 'floors'
        id?: string
        to?: string
      }
    | null
  >(null)
  /** Right-click: what can be done here, at the pointer. */
  const [menu, setMenu] = useState<{ x: number; y: number; role?: string } | null>(null)
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null)
  const [wire, setWire] = useState<{ from: string; x: number; y: number } | null>(null)
  const [note, setNote] = useState('')
  /**
   * Where the canvas is being looked at from: scale, and the corner it starts
   * at. Scrollbars are the wrong instrument for a drawing - they move one axis
   * at a time and cannot make anything smaller - so the middle button drags it
   * around and the wheel zooms, the way every other canvas works.
   */
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 })
  const [pan, setPan] = useState<{ x: number; y: number } | null>(null)
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [error, setError] = useState('')
  /** Set while the floor is being handed over and the window taken down. */
  const [applying, setApplying] = useState(false)
  const [writing, setWriting] = useState(false)
  /**
   * Whether `saved` is this drawing's own last written state.
   *
   * False for a floor that has never been written - a blank one, or one the
   * model has just drawn - where `saved` is still the floor that was on the
   * canvas before it. Undo needs to know the difference: going back to `saved`
   * is going back on a floor that has one, and swapping floors on a floor that
   * does not.
   */
  const [based, setBased] = useState(true)
  const svg = useRef<SVGSVGElement>(null)
  const board = useRef<HTMLDivElement>(null)
  const gesture = useRef(false)

  /**
   * Where the boxes were left last time.
   *
   * Laying the floor out from scratch on every open is correct and unhelpful:
   * somebody arranges twelve boxes the way they think about them, closes the
   * dialog, and opens it to find the arrangement gone. The positions live in
   * this machine's config, per floor - not in the workflow, which describes an
   * organisation and should not carry one screen's idea of where it sits.
   */
  useEffect(() => {
    let live = true
    ;(async () => {
      const prefs = await window.bullpen.uiPrefs()
      if (!live) return
      const placed = prefs.chart?.[workflow?.name ?? ''] ?? {}
      const seen = prefs.view?.[workflow?.name ?? '']
      setDraft(workflow)
      setSaved(workflow)
      setBased(true)
      setRuledAt(shapeKey(workflow))
      setNodes(layout(workflow).map((n) => ({ ...n, ...(placed[n.id] ?? {}) })))
      if (seen) setView(seen)
    })()
    return () => {
      live = false
    }
  }, [workflow])

  /** And where it was being looked at from, so a zoom survives the dialog. */
  const rememberView = (next: { k: number; tx: number; ty: number }): void => {
    const name = draft?.name ?? workflow?.name
    if (name) window.bullpen.setUiPrefs({ view: { [name]: next } })
  }

  /** Remember them as they are put down, not on some later save. */
  const remember = (placed: ChartNode[]): void => {
    const name = draft?.name ?? workflow?.name
    if (!name) return
    const where = Object.fromEntries(placed.map((n) => [n.id, { x: Math.round(n.x), y: Math.round(n.y) }]))
    window.bullpen.setUiPrefs({ chart: { [name]: where } })
  }

  /**
   * Nothing to draw yet.
   *
   * Three of the effects below this line are declared after it, so a render
   * that takes this branch runs fewer hooks than one that does not - and React
   * answers a changed hook count by tearing the tree down. Whoever renders this
   * has to have a floor already: `Settings` waits for one rather than mounting
   * this empty and handing it one a moment later.
   */
  if (!draft) return <div style={S.wrap} />

  const set = (patch: Partial<WorkflowInfo>): void => setDraft({ ...draft, ...patch })

  /**
   * Lay a floor out again without losing where anything was put.
   *
   * A box that is already on screen keeps its spot; one that has just appeared
   * - or come back, which is what undo does - gets the spot the layout would
   * give it. Undo used to restore the floor and not the drawing, so an undone
   * delete left the role in the file with no box anywhere.
   */
  const relayout = (w: WorkflowInfo): void => {
    setNodes((was) => {
      const kept = new Map(was.map((n) => [n.id, n]))
      return layout(w).map((n) => {
        const had = kept.get(n.id)
        return had ? { ...n, x: had.x, y: had.y } : n
      })
    })
  }

  /**
   * The other direction: what was typed in the file becomes the drawing.
   *
   * Half-typed text does not parse, and a parse that fails is left alone rather
   * than shown as an error - they are mid-word, not wrong.
   */
  const fromText = (markdown: string, said: (ok: boolean, problems: string[]) => void): void => {
    if (typing.current) clearTimeout(typing.current)
    typing.current = setTimeout(() => {
      window.bullpen.lintWorkflow(markdown).then((r) => {
        said(Boolean(r.preview), r.problems ?? [])
        if (!r.preview) {
          // On the bar, where the save button is. It was said under the text
          // box, which is as tall as the column - so somebody who typed a line
          // the parser cannot read saw a save button that would not light and
          // nothing anywhere saying why.
          return setError(r.problems?.[0] ?? 'The file does not read as a floor yet.')
        }
        setError('')
        setDraft(r.preview)
        relayout(r.preview)
      })
    }, 400)
  }
  /**
   * Unsaved, rather than "not the floor that is running".
   *
   * Those were the same thing while saving also applied. They are not any more:
   * a floor can be drawn, saved, and left on the canvas without the app running
   * it, so what the save button is about is what has not been written down.
   */
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || fileEdited
  /** Whether the rules are about the floor as it is now drawn. */
  const rulesStale = shapeKey(draft) !== ruledAt
  /** Whether this floor is one of Bullpen's own, and so not written over. */
  const readOnly = shipped.includes(draft.name)
  /** Whether what is drawn is what the app is running. */
  const running = draft.name === workflow?.name && JSON.stringify(draft) === JSON.stringify(workflow)
  // Reported up so the dialog around this can refuse to be dismissed over an
  // unsaved drawing: closing it unmounts the canvas, and a floor somebody has
  // spent ten minutes on goes with it, without a word.
  /**
   * Whether it is alright to throw this drawing away, having asked.
   *
   * Every way out asks the same three-answer question - the switch, the undo,
   * the close - rather than each one inventing its own wording for it, and
   * `save first` is a real answer here because the save is right there.
   */
  const leaving = async (detail: string): Promise<boolean> => {
    if (!dirty) return true
    // The three-answer dialog lives in main, and main is reloaded separately
    // from this window - so between a renderer that asks for it and a preload
    // that does not have it yet, the ask throws and the press does nothing at
    // all. Two answers is worse than three and far better than a dead button.
    const ans = window.bullpen.unsavedAsk
      ? await window.bullpen.unsavedAsk(detail)
      : confirm(`${detail}\n\nLeave without saving?`)
        ? 'discard'
        : 'cancel'
    if (ans === 'cancel') return false
    if (ans === 'save') return save()
    // Leaving without saving throws the changes away here and now. It used to
    // only let the press through: the panel opened over a canvas still holding
    // every edit, with `undo` beside it and the floor still reading `unsaved` -
    // so the answer given was "lose them" and nothing was lost.
    //
    // Back to the last written version of this floor, or - on one that has
    // never been written, a blank or one the model has just drawn - back to the
    // floor the app is running. That second case was left out, so answering
    // "lose them" on a new floor kept every line of it: the panel opened, the
    // canvas still held the new floor, and `write it` was still lit over it.
    const back = based && saved ? saved : workflow
    if (back) {
      setDraft(back)
      setSaved(back)
      setBased(true)
      relayout(back)
      setRuledAt(shapeKey(back))
      setFileEdited(false)
    }
    return true
  }

  // The dialog around this needs both: whether there is anything to lose, and
  // the press that would keep it.
  useEffect(() => onDirty?.(dirty, save), [dirty, onDirty])
  const at = (id: string): ChartNode | undefined => nodes.find((n) => n.id === id)

  const point = (e: React.PointerEvent): { x: number; y: number } => {
    // The rect is already scaled, so the offset into it is too: divide it back
    // out and the answer is in the drawing's own coordinates, at any zoom.
    const box = svg.current?.getBoundingClientRect()
    return {
      x: (e.clientX - (box?.left ?? 0)) / view.k - 30 + off.x,
      y: (e.clientY - (box?.top ?? 0)) / view.k - 30 + off.y
    }
  }

  /**
   * Everything on screen at once.
   *
   * Panning has no edges - the canvas is as big as somebody drags it - so the
   * one thing that must always work is getting back. This is that.
   */
  const fit = (): void => {
    const box = board.current?.getBoundingClientRect()
    if (!box || !nodes.length) return setView({ k: 1, tx: 0, ty: 0 })
    // The whole box the drawing occupies, which since boxes drag anywhere can
    // start left of and above the origin.
    const at = { x: Math.min(0, ...nodes.map((n) => n.x)), y: Math.min(0, ...nodes.map((n) => n.y)) }
    const left = Math.min(...nodes.map((n) => n.x)) - at.x + 30
    const top = Math.min(...nodes.map((n) => n.y)) - at.y + 30
    const right = Math.max(...nodes.map((n) => n.x)) - at.x + NODE_W + 60
    const bottom = Math.max(...nodes.map((n) => n.y)) - at.y + NODE_H + LABEL_H + 60
    const k = Math.min(1, box.width / (right - left), box.height / (bottom - top))
    const next = { k, tx: -left * k + 12, ty: -top * k + 12 }
    setView(next)
    rememberView(next)
  }

  /** Zoom about the pointer, so what is under it stays under it. */
  const zoom = (e: React.WheelEvent): void => {
    const box = e.currentTarget.getBoundingClientRect()
    const at = { x: e.clientX - box.left, y: e.clientY - box.top }
    const k = Math.min(2.5, Math.max(0.3, view.k * (1 - e.deltaY / 600)))
    const next = {
      k,
      tx: at.x - ((at.x - view.tx) / view.k) * k,
      ty: at.y - ((at.y - view.ty) / view.k) * k
    }
    setView(next)
    rememberView(next)
  }

  const move = (e: React.PointerEvent): void => {
    const p = point(e)
    if (drag || wire) gesture.current = true
    if (drag) {
      const x = p.x - drag.dx
      const y = p.y - drag.dy
      setNodes(nodes.map((n) => (n.id === drag.id ? { ...n, x, y } : n)))
    } else if (wire) setWire({ ...wire, x: p.x, y: p.y })
  }

  /**
   * The rules a new line needs, worked out and put in.
   *
   * Taking a line off has always taken its rules with it. Drawing one put none
   * back, so a floor written by the model and then redrawn by hand ended up
   * with arrows the board does not follow. What is already written keeps its
   * place - the router takes the first rule that fits, and a rule somebody
   * wrote is the answer they meant.
   */
  const ruleTheLines = async (next: WorkflowInfo): Promise<void> => {
    const res = await window.bullpen.rulesFromDrawing(next)
    if (!res.rules) return
    const filled = fillRules(next, res.rules)
    if (filled.length !== next.cardRules.length) setDraft({ ...next, cardRules: filled })
  }

  /**
   * Every rule, written again from the drawing as it now stands.
   *
   * The other two keep up on their own - a line taken off takes its rules, a
   * line drawn gets the one it was missing - and both leave everything already
   * written alone, which is right until the drawing has moved far enough that
   * what was written is about a floor that no longer exists. This is the one
   * that throws those away.
   */
  /**
   * The file, written again from the drawing, and handed back.
   *
   * The card rules alone used to be rewritten here, which is the part that can
   * be worked out from the lines. Everything else is prose about the same
   * lines and does not follow them: a role moved under somebody else keeps a
   * brief naming whoever it used to report to, and a `- does:` describing a job
   * it no longer has. That is what a floor is read by.
   *
   * Handed back as well as set: `setDraft` lands on the next render, and the
   * save that called this needs the floor it is about now.
   */
  const redraft = async (): Promise<WorkflowInfo | null> => {
    setError('')
    setNote('')
    setWriting(true)
    try {
      const res = await window.bullpen.redraftWorkflow(staffed(draft))
      if (res.error) {
        setError(res.error)
        return null
      }
      if (!res.markdown) return null
      const read = await window.bullpen.lintWorkflow(res.markdown)
      if (!read.preview) {
        setError(read.problems?.[0] ?? 'What came back does not read as a floor.')
        return null
      }
      setDraft(read.preview)
      relayout(read.preview)
      setRuledAt(shapeKey(read.preview))
      setNote('Written from the drawing. Read it, then save.')
      return read.preview
    } finally {
      setWriting(false)
    }
  }

  const drop = (e: React.PointerEvent): void => {
    if (wire) {
      const p = point(e)
      // The tile and its name, plus a margin. A 64-pixel square is a small
      // thing to let go of a line on, and letting go two pixels under it - on
      // the name, which reads as part of the box - did nothing at all.
      const near = 16
      const hit = nodes.find(
        (n) =>
          p.x >= n.x - near &&
          p.x <= n.x + NODE_W + near &&
          p.y >= n.y - near &&
          p.y <= n.y + NODE_H + LABEL_H + near
      )
      if (hit && hit.id !== wire.from) {
        // A line out of `you` is not a permission. The human is refused by
        // nobody - `hive.gate` lets them write to anyone - and `talksTo` is
        // written by roles about roles, so an entry under `you` lints as a
        // floor naming a role that does not exist. What the gesture can only
        // mean is where a task typed at this floor lands, so that is what it
        // does: the arrow moves rather than a second one appearing.
        if (wire.from === draft.human) {
          if (draft.roles[hit.id]) {
            set({
              dispatch: hit.id,
              // Inbound work follows it unless somebody had already sent it
              // somewhere else on purpose.
              ...(draft.entry === draft.dispatch ? { entry: hit.id } : {})
            })
          }
        } else {
          const talksTo = link(draft, wire.from, hit.id)
          // Drawing a line to a role is saying this one hands work to that one,
          // and the rules are worked out from what a role may do rather than
          // from the line itself - so a sender holding no capability drew a
          // line that moved no card. Only when it holds nothing that hands work
          // out; a role that already assigns, or speaks, or checks, is left as
          // it was written.
          const roles = handsOut({ ...draft, talksTo }, wire.from)
          const next = { ...draft, talksTo, ...roles }
          setDraft(next)
          void ruleTheLines(next)
        }
      }
    }
    // Only when there was one. Setting state on every pointerup re-rendered the
    // drawing between the press and the release, and a browser does not raise
    // `click` when the element under the pointer has been replaced - so a line
    // could be pressed and released and never counted as clicked.
    if (drag) {
      setDrag(null)
      remember(nodes)
    }
    if (wire) setWire(null)
  }

  /**
 * What a role drawn on the canvas is told until somebody writes it properly.
 *
 * Written to them rather than about them, and in placeholders, because the box
 * has no name yet and the one who assigns it depends on the line that is drawn
 * next.
 */
const STARTING_BRIEF = [
  'You are "{{self.id}}", an agent on a Bullpen floor. {{reportTo}} assigns your work.',
  '',
  'Do the task you were sent and nothing beside it. If it turns out to be bigger than it read,',
  'say so rather than growing it.',
  '',
  'Do not report that something works without the command output that shows it. If a build or a',
  'test is red, say red and paste the line that failed.',
  '',
  'Report to whoever sent you the task - take their id from the message you were sent.',
  '{{reportTo}} is only who to write to when nothing was sent. You write to anyone by putting one',
  'JSON file in $BULLPEN_MAILBOX/outbox; mail for you is in $BULLPEN_MAILBOX/inbox:',
  '',
  '{"from": "{{self.id}}", "to": "{{reportTo}}", "subject": "done: <the task>", "body": "<what you did, and what you ran to check it>"}',
  '',
  'Report the same way when you are blocked, and say what would unblock it. Silence is the one',
  'answer nobody can act on.'
].join('\n')

/** A new role, with enough in it to be a legal one. */
  /**
   * The word for handing work out, given to whoever now hands it out.
   *
   * Returns the patch, or nothing when the role already holds a capability of
   * its own - a checker that also assigns, a boss that speaks to the human,
   * anything somebody wrote on purpose is not overwritten here.
   */
  const handsOut = (
    floor: WorkflowInfo,
    role: string
  ): Partial<WorkflowInfo> | Record<string, never> => {
    const def = floor.roles[role]
    if (!def) return {}
    const capabilities = floor.capabilities.length ? floor.capabilities : HOUSE_CAPABILITIES
    const assigns = capabilities.find((c) => c.kind === 'assigns')?.name
    if (!assigns) return {}
    const kinds = new Set(
      (def.can ?? []).map((c) => capabilities.find((d) => d.name === c)?.kind).filter(Boolean)
    )
    if (kinds.has('assigns') || kinds.has('checks')) {
      return floor.capabilities.length ? {} : { capabilities }
    }
    return {
      capabilities,
      roles: { ...floor.roles, [role]: { ...def, can: [...(def.can ?? []), assigns] } }
    }
  }

  const addRole = (): void => {
    const id = freeRoleId(draft.roles)
    // Whoever does the work on this floor, not whichever capability happens to
    // be listed first. On a floor whose first one is `speaksToHuman`, a role
    // drawn on the canvas answered to the rules about the boss - so reporting
    // in opened a new card instead of moving its own, and the board grew
    // instead of moving.
    // A floor drawn from one that declared no capabilities has no word for
    // doing the work, so a new role held nothing - and `drawnCardRules` reads
    // capabilities, so no line to that role ever became a rule and the board
    // never heard about it. Declare the four before the first role needs one.
    const capabilities = draft.capabilities.length ? draft.capabilities : HOUSE_CAPABILITIES
    const builds =
      buildsCapabilityIn({ ...draft, capabilities }) ?? capabilities.find((c) => c.kind === 'builds')?.name
    set({
      capabilities,
      roles: {
        ...draft.roles,
        [id]: {
          label: 'a new role',
          does: '',
          can: builds ? [builds] : [],
          hireable: true,
          // Something to start on. A role drawn on the canvas came out with an
          // empty brief, and a brief is handed to the CLI once at spawn and
          // never again - so the first agent hired into it started knowing
          // nothing at all, on a floor whose every other role had a page.
          brief: STARTING_BRIEF
        }
      },
      talksTo: { ...draft.talksTo, [id]: [] }
    })
    setNodes([...nodes, { id, label: 'a new role', kind: 'role', x: 40, y: 40 + nodes.length * 20 }])
    setPanel({ kind: 'role', id })
  }

  /**
   * A role's id, changed everywhere at once.
   *
   * The id is the name every other part of the file uses - `talks to:`, the
   * card rules, which role dispatch is, which one work enters at - so changing
   * it in one place and not the rest leaves a floor that names somebody who is
   * not there. The only way to change it used to be typing the file, in every
   * one of those places, without missing one.
   *
   * `.` and `·` are what the file separates fields with, and a space in an id
   * makes `talks to: a b` two roles or one depending on who reads it; anything
   * else becomes an underscore rather than being refused, because the name in
   * the box is the display label and this is the handle under it.
   */
  const renameRole = (from: string, said: string): void => {
    const to = said
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
    if (!to || to === from) return
    const taken =
      to in draft.roles ||
      to === draft.human ||
      to === draft.hire ||
      (draft.capabilities ?? []).some((c) => c.name === to)
    if (taken) return setError(`"${to}" is already a name on this floor.`)
    setError('')
    const swap = (r: string): string => (r === from ? to : r)
    const next: WorkflowInfo = {
      ...draft,
      // Rebuilt in order: the roles are written to the file in the order they
      // are held in, and a rename that moved this one to the end reordered
      // somebody's file for them.
      roles: Object.fromEntries(
        Object.entries(draft.roles).map(([id, def]) => [swap(id), def])
      ),
      talksTo: Object.fromEntries(
        Object.entries(draft.talksTo ?? {}).map(([id, tos]) => [swap(id), tos.map(swap)])
      ),
      cardRules: draft.cardRules.map((r) => ({ ...r, from: swap(r.from), to: swap(r.to) })),
      dispatch: swap(draft.dispatch),
      entry: swap(draft.entry),
      voice: draft.voice ? swap(draft.voice) : draft.voice
    }
    setDraft(next)
    // The rules came with it. Renaming changes the shape the rules are keyed to
    // - same roles, one under another name - so without this the save that
    // follows sends the floor back to the model to have rules written that are
    // already right, and pays for it.
    if (!rulesStale) setRuledAt(shapeKey(next))
    // The box on the canvas is keyed by id, and so is where it was put down.
    setNodes((was) => was.map((n) => (n.id === from ? { ...n, id: to } : n)))
    setPanel({ kind: 'role', id: to })
  }

  const dropRole = (id: string): void => {
    const roles = { ...draft.roles }
    delete roles[id]
    const talksTo = Object.fromEntries(
      Object.entries(draft.talksTo)
        .filter(([from]) => from !== id)
        .map(([from, tos]) => [from, tos.filter((t) => t !== id)])
    )
    // And the rules that named it. A rule about a role the floor no longer has
    // is not a rule that fires later.
    set({ roles, talksTo, cardRules: firing({ ...draft, roles, talksTo }) })
    setNodes(nodes.filter((n) => n.id !== id))
    setPanel(null)
  }

  /**
   * Write the file, and the rules first when the drawing has moved past them.
   *
   * They were two presses in a row, and the first one had to be found: a lit
   * `write the rules` on the bar, a save greyed out beside it, and a tooltip
   * saying why. Nothing is ever saved without its rules being about the floor
   * as drawn, so the save is the press and the rules are part of it - the one
   * question worth asking, that hand-written rules are about to go, is still
   * asked before anything happens.
   */
  const save = async (): Promise<boolean> => {
    setError('')
    setNote('')
    const floor = draft
    const shown = await window.bullpen.previewWorkflow(staffed(floor))
    const res = await window.bullpen.saveWorkflowFile(shown.markdown)
    if (res.error) {
      setError(res.error)
      return false
    }
    setSaved(floor)
    setBased(true)
    setFileEdited(false)
    // Half-drawn still saves; a floor against a law does not, and main says so
    // through `error` above rather than through a note under a file it wrote
    // anyway.
    setNote(running ? 'Saved. The file is written; the floor runs it.' : 'Saved. Press apply to run it.')
    return true
  }

  /**
   * Run this floor, and start the window again on it.
   *
   * Applying changes what every screen is about - the board's columns, who is
   * on the roster, what the router allows - and the renderer keeps whatever it
   * read when it opened. Rather than teach each screen to follow, the window
   * comes back up on the new floor, which is what an operator would have done
   * by hand. The dialog is reopened on the way in, so the floor somebody was
   * halfway through drawing is still in front of them.
   */
  const apply = async (): Promise<void> => {
    if (
      !confirm(
        `Run "${draft.name}"?\n\nThe window starts again on it. Agents already on the floor keep ` +
          `running and keep the shape they were briefed with until they are restarted.`
      )
    ) {
      return
    }
    setError('')
    setNote('')
    setApplying(true)
    try {
      const shown = await window.bullpen.previewWorkflow(staffed(draft))
      const res = await window.bullpen.setWorkflow(shown.markdown)
      if (res.error) {
        setApplying(false)
        return setError(res.error)
      }
      // Read on the way back in, so the dialog is where it was left. In the
      // URL rather than in storage: the packaged app is loaded over `file:`,
      // where reading storage throws.
      window.location.hash = 'floor'
      window.location.reload()
    } catch (err) {
      setApplying(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Where the drawing starts, which is not always 0,0.
   *
   * Boxes drag anywhere, so the extent can begin left of and above the origin.
   * Everything painted is shifted by this much - the SVG cannot draw outside
   * its own box, and negative coordinates fall outside it.
   */
  const off = {
    x: Math.min(0, ...nodes.map((n) => n.x)),
    y: Math.min(0, ...nodes.map((n) => n.y))
  }

  /**
   * Hold the picture still when its origin moves.
   *
   * Dragging one box past the left edge shifts everything that is painted by
   * the same amount, so every other box appeared to jump sideways while one was
   * being moved. Taking the shift back out of the view leaves them where they
   * look like they are.
   */
  /**
   * Who is actually standing in each role right now.
   *
   * A box is a role; a session is a running Claude in one. They are not the
   * same thing and the drawing said nothing about the difference - a floor
   * where nobody has been hired yet looked exactly like one with four agents
   * on it. The dot on the tile is the answer: filled if somebody is there,
   * coloured by what they are doing.
   */
  const live = useStore((st) => st.agents)
  const sessions = (role: string): typeof live =>
    live.filter((a) => a.role === role && a.status === 'running')

  const wasOff = useRef(off)
  useEffect(() => {
    const dx = off.x - wasOff.current.x
    const dy = off.y - wasOff.current.y
    wasOff.current = off
    if (dx || dy) setView((v) => ({ ...v, tx: v.tx + dx * v.k, ty: v.ty + dy * v.k }))
  }, [off.x, off.y])

  /**
   * Take a line off, both ways at once.
   *
   * The dot is the pair rather than one arrow, so removing one direction and
   * leaving the other is not a thing anybody clicking it meant. Work arriving
   * is the exception and cannot go: `edges` puts it back on the next render
   * because no role declares it, which is why pressing delete on it looked
   * like a key that did nothing.
   */
  /**
   * Take a line off. Both directions at once, because the dot is the pair -
   * and if it is the one work arrives on, that arrow moves rather than goes.
   */
  const dropEdge = (from: string, to: string): void => {
    set(takeLineOff(draft, from, to))
    setPanel(null)
  }

  /**
   * Whatever is open is what is selected, so `delete` deletes it.
   *
   * Removing a role meant open the box, scroll past the brief, find a button;
   * removing a line meant open the line and find another. Both are one key now,
   * and the panel that is open says which one it will take.
   */
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      const on = e.target as HTMLElement | null
      if (on && /^(INPUT|TEXTAREA)$/.test(on.tagName)) return
      if (e.key === 'Escape') return setPanel(null)
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (!panel) return
      if (panel.kind === 'role' && panel.id) {
        e.preventDefault()
        dropRole(panel.id)
      }
      if (panel.kind === 'edge' && panel.id && panel.to) {
        e.preventDefault()
        dropEdge(panel.id, panel.to)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const drawn = edges(draft)
  /**
   * One dot per pair, not per direction.
   *
   * Two roles that write to each other are one line on the drawing, and it had
   * two dots on it a few pixels apart opening two near-identical panels. What
   * somebody wants is what these two say to each other - both ways, in one
   * place - so the dot is the pair and the panel has a box per direction.
   */
  const pairs = ((): { from: string; to: string }[] => {
    const seen = new Set<string>()
    return drawn.filter(({ from, to }) => {
      const key = [from, to].sort().join('\u0000')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })()

  /** Where each line's handle sits, in the drawing's own coordinates. */
  const handles = pairs.flatMap(({ from, to }) => {
    const a = at(from)
    const b = at(to)
    if (!a || !b) return []
    const { x1, y1, x2, y2 } = anchor(a, b)
    const mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }
    // A node takes up its tile *and* the two lines of name under it, and a
    // handle that lands there sits in the middle of somebody's label. Try the
    // midpoint, then a few places beside it, and take the first that is clear.
    const busy = (px: number, py: number): boolean =>
      nodes.some(
        (n) =>
          px > n.x - 14 &&
          px < n.x + NODE_W + 14 &&
          py > n.y - 14 &&
          py < n.y + NODE_H + LABEL_H + 6
      )
    const tries = [
      mid,
      { x: mid.x + NODE_W, y: mid.y },
      { x: mid.x - NODE_W, y: mid.y },
      { x: mid.x, y: mid.y + NODE_H + LABEL_H + 16 }
    ]
    const spot = tries.find((t) => !busy(t.x, t.y)) ?? tries[3]
    const { x, y } = spot
    return [{ from, to, x, y }]
  })

  return (
    <div style={S.wrap}>
      <div style={S.bar}>
        {/* What this floor is, said once, where the eye already goes. `running`
            was a button that could not be pressed and `save the floor` a
            greyed-out one on a floor with nothing to save - two controls
            spending their room on a state. The state is a state; it reads as
            one now, and the bar keeps only the presses that do something. */}
        <span
          style={{
            ...S.state,
            color: running ? 'var(--ok)' : dirty ? 'var(--accent-ink)' : 'var(--muted)'
          }}
          title={
            running
              ? 'the app is running this floor'
              : dirty
                ? 'not written down yet'
                : 'written down, but not the floor the app is running'
          }
        >
          <span
            style={{
              ...S.dot,
              background: running ? 'var(--ok)' : 'transparent',
              border: running ? 'none' : '1px solid currentColor',
              // Lit, not merely coloured: the one state worth spotting across
              // the room is the floor being live.
              boxShadow: running ? '0 0 6px var(--ok)' : 'none'
            }}
          />
          <span style={{ color: 'var(--ink)' }}>{draft.name}</span>
          <span style={{ ...LABEL, color: 'inherit', fontSize: 9 }}>
            {running ? 'running' : dirty ? 'unsaved' : 'not running'}
          </span>
        </span>
        {error && <span style={{ color: 'var(--danger)' }}>{error.split('\n')[0]}</span>}
        {note && !dirty && (
          <span style={{ color: note.startsWith('Saved. Still') ? 'var(--muted)' : 'var(--ok)' }}>
            {note}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {/* `settings` stood here and opened a panel over the drawing holding
            two numbers and the board's columns - all of it already written in
            the file one column over. It is in that column now, above the text
            it edits, so there is one place a floor is described rather than
            two that have to agree.

            `?` went with it: four lines of instruction that are read once. */}
        {/* Before the buttons, not after: it is a sentence about the floor, and
            reading it on the far side of the presses it explains put the answer
            after the question. */}
        {readOnly && (
          <span style={{ color: 'var(--faint)' }}>
            ships with Bullpen — rename it in the file to keep changes
          </span>
        )}
        {/* Asked on the way in, not on the way out. Everything in this panel -
            picking one off the list, describing a new one, starting a blank -
            replaces what is on the canvas, so the question belongs to opening
            it. Asking at the pick instead meant reading the whole panel first
            and being stopped at the last click. */}
        <button
          style={{ ...S.btn, ...(panel?.kind === 'floors' ? S.btnOn : {}) }}
          title="open another floor, or start a new one"
          onClick={async () => {
            if (panel?.kind === 'floors') return setPanel(null)
            if (await leaving('Anything opened here replaces the floor on the canvas.')) {
              setPanel({ kind: 'floors' })
            }
          }}
        >
          switch floor
        </button>
        {/* Only on a floor that has a written version to go back to. On a floor
            drawn from blank there is none, and undo threw the drawing away for
            whatever the app happens to be running - a different floor under a
            different name. It was keyed to the name matching, which took the
            button away the moment the floor was renamed - the one edit most
            likely to be wanted back. */}
        {dirty && based && saved && (
          <button
            style={S.btn}
            title={`back to ${saved.name} as it was last written`}
            onClick={() => {
              // Not the three-answer question the other exits ask. `save first`
              // is not an answer to undo - saving is the opposite of it - and
              // offering it beside `leave without saving` asked somebody about
              // losing changes they had just pressed a button to lose.
              if (!confirm(`Undo? ${saved.name} goes back to how it was last written.`)) return
              setDraft(saved)
              relayout(saved)
              setRuledAt(shapeKey(saved))
              setFileEdited(false)
              setPanel(null)
            }}
          >
            undo
          </button>
        )}
        {/* On the bar, lit, and in the way of everything downstream.
            It sat in the file column's heading beside `save`, which put the
            press that reconciles the floor at the far edge of the screen from
            the drawing that had just been changed - and the two buttons a foot
            apart read as a pair of alternatives rather than as an order.
            Everything the router acts on is behind it: move a line, type a
            rule, rename a column, and this is what makes the drawing and the
            file say the same thing again. It says it by writing the rules the
            drawing gives, so a rule typed by hand is answered, not kept. */}
        {rulesStale && !readOnly && (
          <button
            style={{ ...S.btn, ...S.btnGo }}
            disabled={applying || writing}
            title="write every brief, the rules and the summary again to match the drawing"
            onClick={redraft}
          >
            {writing ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Spinner /> writing the floor…
              </span>
            ) : (
              'write it'
            )}
          </button>
        )}
        {/* Two presses, not one. Saving writes the file; this is the one that
            changes what the app is running, and it says so before it does. */}
        {!running && (!dirty || applying) && (
          <button
            style={{ ...S.btn, ...S.btnGo }}
            disabled={applying || writing}
            title={`run ${draft.name}`}
            onClick={apply}
          >
            {applying ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Spinner /> starting the floor…
              </span>
            ) : (
              'apply'
            )}
          </button>
        )}
      </div>

      <div style={S.body}>
        <div
          ref={board}
          style={{ ...S.board, cursor: pan ? 'grabbing' : 'default' }}
          onWheel={zoom}
          onDoubleClick={fit}
          onPointerDown={(e) => {
            if (e.button !== 1) return
            e.preventDefault()
            setPan({ x: e.clientX - view.tx, y: e.clientY - view.ty })
          }}
          onPointerMove={(e) => {
            if (!pan) return
            setView({ ...view, tx: e.clientX - pan.x, ty: e.clientY - pan.y })
          }}
          onPointerUp={() => {
            if (pan) rememberView(view)
            setPan(null)
          }}
          onPointerLeave={() => {
            if (pan) rememberView(view)
            setPan(null)
          }}
          onClick={() => {
            setMenu(null)
            if (!gesture.current) setPanel(null)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            const box = e.currentTarget.getBoundingClientRect()
            setMenu({ x: e.clientX - box.left, y: e.clientY - box.top })
          }}
        >
          <div
            style={{
              transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`,
              transformOrigin: '0 0',
              width: 'max-content'
            }}
          >
          <svg
            ref={svg}
            width={Math.max(700, ...nodes.map((n) => n.x - off.x + NODE_W + 90))}
            height={Math.max(340, ...nodes.map((n) => n.y - off.y + NODE_H + 90))}
            onPointerMove={move}
            onPointerUp={drop}
            onPointerLeave={drop}
            style={{ display: 'block', touchAction: 'none' }}
          >
            <defs>
              <marker
                id="head"
                markerUnits="userSpaceOnUse"
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8 z" fill="var(--faint)" />
              </marker>
              {/* The same head, pointing back the way the line came. A pair who
                  write to each other is one line that means both, and drawn
                  with one arrow it read as a one-way street. */}
              <marker
                id="tail"
                markerUnits="userSpaceOnUse"
                markerWidth="8"
                markerHeight="8"
                refX="1"
                refY="4"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L8,4 L0,8 z" fill="var(--faint)" />
              </marker>
            </defs>
            <g transform={`translate(${30 - off.x},${30 - off.y})`}>
              {pairs.map(({ from, to }) => {
                const a = at(from)
                const b = at(to)
                if (!a || !b) return null
                const { x1, y1, x2, y2 } = anchor(a, b)
                const bend = (x1 + x2) / 2
                const d = `M${x1},${y1} C${bend},${y1} ${bend},${y2} ${x2},${y2}`
                // A line says these two may write to each other; an arrow at
                // each end says which of them actually does.
                const back = drawn.some((e) => e.from === to && e.to === from)
                return (
                  <g key={`${from}->${to}`}>
                    <path
                      d={d}
                      fill="none"
                      stroke="var(--faint)"
                      strokeWidth={1.5}
                      markerEnd="url(#head)"
                      markerStart={back ? 'url(#tail)' : undefined}
                      pointerEvents="none"
                    />
                  </g>
                )
              })}

              {wire &&
                (() => {
                  const a = at(wire.from)
                  if (!a) return null
                  return (
                    <line
                      x1={a.x + NODE_W}
                      y1={a.y + NODE_H / 2}
                      x2={wire.x}
                      y2={wire.y}
                      stroke="var(--accent-ink)"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      pointerEvents="none"
                    />
                  )
                })()}

              {nodes.map((n) => {
                const def = draft.roles[n.id]
                const open = panel?.kind === 'role' && panel.id === n.id
                return (
                  <g key={n.id} transform={`translate(${n.x},${n.y})`}>
                    <rect
                      width={NODE_W}
                      height={NODE_H}
                      rx={10}
                      fill={n.kind === 'role' ? 'var(--panel)' : 'var(--sunk)'}
                      stroke={open ? 'var(--accent-ink)' : 'var(--line)'}
                      strokeWidth={open ? 2 : 1}
                      // `you` and `hire` are addresses, not people: a dashed
                      // outline says the tile is a thing the floor can write
                      // to rather than somebody standing there.
                      strokeDasharray={n.kind === 'role' ? undefined : '4 3'}
                      style={{ cursor: 'grab' }}
                      onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId)
                        const p = point(e)
                        setDrag({ id: n.id, dx: p.x - n.x, dy: p.y - n.y })
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (gesture.current) {
                          gesture.current = false
                          return
                        }
                        // Only people have anything to open. `you` is where
                        // the work comes from on every floor there is.
                        if (n.kind === 'role') {
                          setPanel({ kind: 'role', id: n.id })
                        }
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setMenu({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY, role: n.id })
                      }}
                    />
                    {/* Who is in this role, if anybody: one dot per running
                        session, coloured by what it is doing. Two dots means
                        two Claudes are doing this job right now. */}
                    {n.kind === 'role' &&
                      sessions(n.id)
                        .slice(0, 4)
                        .map((a, i) => (
                          <circle
                            key={a.id}
                            cx={11 + i * 9}
                            cy={10}
                            r={3}
                            fill={
                              a.activity === 'working'
                                ? 'var(--accent-ink)'
                                : a.activity === 'blocked'
                                  ? 'var(--danger)'
                                  : 'var(--ok)'
                            }
                            pointerEvents="none"
                          />
                        ))}
                    {n.kind === 'role' && (
                      <title>
                        {sessions(n.id).length
                          ? sessions(n.id)
                              .map(
                                (a) =>
                                  `${a.name || a.id} · ${a.activity}${a.ctx ? ` · ${a.ctx.pct}%` : ''}`
                              )
                              .join('\n')
                          : 'nobody here yet - somebody is hired when there is work for this role'}
                      </title>
                    )}
                    {/* One letter rather than an icon set: this app draws its
                        own pixels and has no library of glyphs for jobs nobody
                        has invented yet. */}
                    <text
                      x={NODE_W / 2}
                      y={NODE_H / 2 + (n.kind === 'role' ? 8 : 5)}
                      style={n.kind === 'role' ? S.glyph : S.mark}
                      pointerEvents="none"
                    >
                      {n.kind === 'role' ? (n.id[0] ?? '?').toUpperCase() : '☞'}
                    </text>
                    {/* What they are called first, in the words somebody
                        actually says out loud; the id underneath, because it is
                        what a brief writes to and what the file calls them. */}
                    <text x={NODE_W / 2} y={NODE_H + 16} style={S.name} pointerEvents="none">
                      {(def?.label ?? n.label).slice(0, 24)}
                    </text>
                    <text x={NODE_W / 2} y={NODE_H + 30} style={S.what} pointerEvents="none">
                      {n.id}
                    </text>
                    {/* The human had no dot, so the one arrow an operator
                        wants to move - where a task they type goes - was the
                        one arrow they could not draw. */}
                    <circle
                      cx={NODE_W}
                      cy={NODE_H / 2}
                      r={5}
                      fill="var(--accent-ink)"
                      style={{ cursor: 'crosshair' }}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        e.currentTarget.setPointerCapture(e.pointerId)
                        const p = point(e)
                        setWire({ from: n.id, x: p.x, y: p.y })
                      }}
                    >
                      <title>
                        {n.kind === 'human'
                          ? 'drag to whoever a task you type should go to'
                          : 'drag to whoever this one may write to'}
                      </title>
                    </circle>
                    <circle
                      cx={0}
                      cy={NODE_H / 2}
                      r={4}
                      fill="var(--sunk)"
                      stroke="var(--line)"
                      pointerEvents="none"
                    />
                  </g>
                )
              })}
            </g>
          </svg>

          {/* The handles, as buttons over the drawing.
              Inside the SVG they took the pointer and never produced a click -
              press and release both landed, `click` never did - so the one
              thing on this canvas nothing could open was the flow itself. An
              HTML button is not clever, and it works. */}
          {handles.map(({ from, to, x, y }) => (
            <button
              key={`${from}->${to}`}
              title={`${from} → ${to}`}
              style={{
                ...S.handle,
                left: x - off.x + 30 - 9,
                top: y - off.y + 30 - 9,
                borderColor:
                  panel?.kind === 'edge' && panel.id === from && panel.to === to
                    ? 'var(--accent-ink)'
                    : 'var(--line)'
              }}
              onClick={(e) => {
                e.stopPropagation()
                setPanel({ kind: 'edge', id: from, to })
              }}
            />
          ))}

          {/* The role, at the box. Same reason as the line below it: what was
              clicked and what says something about it should not be at
              opposite ends of the screen. */}
          {panel?.kind === 'role' &&
            nodes
              .filter((n) => n.id === panel.id && draft.roles[n.id])
              .map((n) => (
                <div
                  key={`${n.id}:panel`}
                  style={{
                    ...S.pop,
                    width: 320,
                    left: n.x - off.x + 30 + NODE_W + 14,
                    top: n.y - off.y + 30,
                    transform: `scale(${1 / view.k})`
                  }}
                  onWheel={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onContextMenu={(e) => e.stopPropagation()}
                >
                  <RoleInspector
                    floor={draft}
                    role={n.id}
                    onChange={set}
                    onRename={renameRole}
                    onClose={() => setPanel(null)}
                  />
                </div>
              ))}

          {/* The line, said at the line.
              It opened a column beside the drawing, so clicking a dot meant
              looking away from the thing clicked to read two sentences about
              it - and the drawing scrolled sideways to make room. Counter-
              scaled so the words stay the size words are at any zoom. */}
          {panel?.kind === 'edge' &&
            handles
              .filter((h) => h.from === panel.id && h.to === panel.to)
              .map(({ from, to, x, y }) => (
                <div
                  key={`${from}->${to}:panel`}
                  style={{
                    ...S.pop,
                    left: x - off.x + 30 + 14,
                    top: y - off.y + 30 - 9,
                    transform: `scale(${1 / view.k})`
                  }}
                  onWheel={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onContextMenu={(e) => e.stopPropagation()}
                >
                  <TalkInspector
                    floor={draft}
                    from={from}
                    to={to}
                    onDelete={() => dropEdge(from, to)}
                    onClose={() => setPanel(null)}
                  />
                </div>
              ))}
          </div>

          {menu && (
            <div
              style={{ ...S.menu, left: menu.x, top: menu.y }}
              onWheel={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {menu.role ? (
                <>
                  <button
                    style={S.menuItem}
                    onClick={() => {
                      setPanel({ kind: 'role', id: menu.role })
                      setMenu(null)
                    }}
                  >
                    what this one does…
                  </button>
                  <button
                    style={S.menuItem}
                    onClick={() => {
                      dropRole(menu.role as string)
                      setMenu(null)
                    }}
                  >
                    remove it
                  </button>
                </>
              ) : (
                <>
                  <button
                    style={S.menuItem}
                    onClick={() => {
                      addRole()
                      setMenu(null)
                    }}
                  >
                    add a role
                  </button>
                  <button
                    style={S.menuItem}
                    onClick={() => {
                      const fresh = layout(draft)
                      setNodes(fresh)
                      remember(fresh)
                      setMenu(null)
                    }}
                  >
                    tidy up
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* One column beside the drawing, and the file is what is in it.
            Anything about the whole floor - the words it uses, which floor is
            running - opens over the top of it rather than beside it: a third
            column took its width from the drawing, which is the thing all of
            them are about. */}
        <div
          style={S.side}
          onWheel={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
        >
          {/* The save sits with the thing it writes. On the bar it was one of
              five presses about the floor in general; the file is what goes to
              disk, and this is its heading. */}
          <div style={S.sideHead}>
            <span style={{ ...LABEL, color: 'var(--faint)', flex: 1 }}>the whole file</span>
            {dirty && !rulesStale && !readOnly && (
              <button
                style={{ ...S.btn, ...S.btnGo, height: 18, padding: '0 8px', fontSize: 11 }}
                disabled={applying || writing}
                title={error ? 'the file does not read as a floor yet' : 'write the file'}
                onClick={save}
              >
                save
              </button>
            )}
          </div>
          <div style={{ ...S.sideBody, ...S.sideTall }}>
            <FilePanel
              floor={staffed(draft)}
              onChange={set}
              onText={fromText}
              onEdited={setFileEdited}
            />
          </div>

          {panel && panel.kind !== 'edge' && panel.kind !== 'role' && (
            <div style={S.over}>
              <div style={S.sideHead}>
                <span style={{ ...LABEL, color: 'var(--faint)', flex: 1 }}>
                  {PANEL_TITLE[panel.kind]}
                </span>
              </div>
              <div style={S.sideBody}>
                {panel.kind === 'floors' ? (
                  <FloorsPanel
                    running={workflow?.name ?? ''}
                    onPick={(w, written) => {
                      setDraft(w)
                      // One off the list is already a file. Only a floor that
                      // has never been written - a blank one, or one the model
                      // has just drawn - opens with something to save, which is
                      // what the save button should be saying.
                      if (written) setSaved(w)
                      setBased(written)
                      // Its rules are about it. `ruledAt` was left holding the
                      // shape of the floor this one replaced, so a floor the
                      // model had just written - rules and all - read as stale
                      // the moment it landed: `write it` lit on the bar over a
                      // drawing nobody had touched, `save` hidden behind it,
                      // and the one press offered was a paid round-trip to have
                      // the same rules written again. Staleness starts at the
                      // first edit, not at the open.
                      setRuledAt(shapeKey(w))
                      relayout(w)
                      setPanel(null)
                    }}
                  />
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}


/**
 * One role: a name, and what it does. Nothing else.
 *
 * The panel here had eleven controls - capabilities to tick, who fills it, the
 * command it runs, tools it may not touch, two questions and a brief. Every one
 * of them was a decision somebody had to make before they could draw the second
 * box, and none of them is the thing they came to say, which is "this one
 * writes the piece" and "this one reads it".
 *
 * So: two boxes of text. Everything the router still needs is worked out when
 * the floor is saved - a role the human writes to needs an agent standing at
 * it, and everything else is hired - and anything past that is in the file for
 * whoever wants to open it.
 */
function RoleInspector({
  floor,
  role,
  onChange,
  onRename,
  onClose
}: {
  floor: WorkflowInfo
  role: string
  onChange: (patch: Partial<WorkflowInfo>) => void
  /** The id, which everything else in the file refers to this role by. */
  onRename: (from: string, to: string) => void
  onClose: () => void
}) {
  const def = floor.roles[role]
  /** What is in the id box, which is only the role's id once it is committed. */
  const [id, setId] = useState(role)
  /** The sentence the brief is written from, and how that is going. */
  const [want, setWant] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [briefError, setBriefError] = useState('')
  useEffect(() => {
    setId(role)
    setWant('')
    setBriefError('')
  }, [role])

  const write = async (): Promise<void> => {
    setBriefError('')
    setDrafting(true)
    try {
      const res = await window.bullpen.roleBrief(floor, role, want)
      if (res.error) return setBriefError(res.error)
      // Over the top of whatever was there. Nothing is written to disk by this
      // - the box is what changes - and the floor is not saved until the save
      // on the file column is pressed, so the way back is not to press it.
      if (res.brief) set({ brief: res.brief })
    } finally {
      setDrafting(false)
    }
  }
  const set = (patch: Partial<typeof def>): void =>
    onChange({ roles: { ...floor.roles, [role]: { ...def, ...patch } } })

  /**
   * Who this one answers to: of everybody it has a line with, whoever stands
   * nearest the person running the floor. `you` is nearest of all, so the role
   * work is dispatched to reports to the human and nobody reports to the human
   * through anybody else.
   *
   * Read off the lines rather than typed on the role: a rank in the file is a
   * second opinion about the drawing, and the two disagree the first time an
   * arrow moves.
   */
  const rank = ranks(floor)
  const mine = rank.get(role) ?? 99
  const linked = (r: string): boolean =>
    (floor.talksTo[role] ?? []).includes(r) ||
    (floor.talksTo[r] ?? []).includes(role) ||
    (r === floor.human && role === floor.dispatch)
  const above = [...Object.keys(floor.roles), floor.human]
    .filter((r) => r !== role && linked(r) && (rank.get(r) ?? 99) < mine)
    .sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99))[0]
  const name = (r: string): string => (r === floor.human ? 'you' : (floor.roles[r]?.label ?? r))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ ...LABEL, color: 'var(--accent-ink)', flex: 1 }}>{role}</span>
        <button style={S.close} title="close" onClick={onClose}>
          ×
        </button>
      </div>
      <div style={{ color: 'var(--faint)', lineHeight: 1.6, margin: '2px 0 6px' }}>
        {above ? (
          <>
            Reports the work back to <b>{name(above)}</b>.
          </>
        ) : (
          'Reports to nobody - draw a line to whoever this one answers to.'
        )}
      </div>

      <Row label="called">
        <input
          style={S.field}
          value={def.label}
          placeholder="a writer"
          onChange={(e) => set({ label: e.target.value })}
        />
      </Row>

      {/* Committed when it is left, not as it is typed: a rename rewrites every
          mention of this role in the file, and doing that per keystroke renamed
          it to `r`, then `ro`, then `rol`. */}
      <Row label="id">
        <input
          style={S.field}
          value={id}
          spellCheck={false}
          title="what the rest of the file calls this role - lines, card rules, dispatch"
          placeholder="writer"
          onChange={(e) => setId(e.target.value)}
          onBlur={() => onRename(role, id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setId(role)
          }}
        />
      </Row>

      {/* A tick stood here for "somebody at this desk from launch, otherwise
          hired when there is work". Every floor there is answers it the same
          way - dispatch stands, everybody else is hired - and `staffed` writes
          that on save whether or not anybody ticked anything. A second standing
          agent is still a floor that can be written; it is `- agent: id · Name`
          in the file, which is where the rest of what the drawing cannot show
          already lives. */}

      <div style={{ ...LABEL, marginTop: 8 }}>what this one does</div>
      <div style={{ color: 'var(--faint)', lineHeight: 1.6, margin: '2px 0 4px' }}>
        Written to them, not about them: what they are for, what they must not do, what they send
        when a task is finished, and who they send it to. The first line is what the floor shows
        everywhere else.
      </div>

      {/* A page of brief from a sentence about the job.
          Writing one by hand means knowing the placeholders, the ids of
          everybody else on the floor, and what a report has to look like for
          the router to move a card - which is a lot to know before the first
          role is on the floor at all. The model is given the floor as it
          stands, so what comes back names the people who are actually there.

          It fills the box rather than saving anything: what is written is
          read before it is kept, and the box is where it is edited. */}
      <div style={S.gen}>
        <div style={{ ...LABEL, color: 'var(--accent-ink)', marginBottom: 5 }}>
          ✦ write it with the model
        </div>
        {/* A box, not a line. What the job is takes a sentence or three - what
            they do, what they must not touch, who they answer to - and a
            single-line input showed the last forty characters of it. */}
        <textarea
          style={{ ...S.area, height: 64, fontSize: 12.5, background: 'var(--panel)' }}
          value={want}
          spellCheck={false}
          placeholder="reads the docs and answers questions about them, and never edits code"
          title="what this role is for - the model writes the brief from it"
          onChange={(e) => setWant(e.target.value)}
          onKeyDown={(e) => {
            // Enter is a newline in a box this size; the shortcut takes a
            // modifier, the way every other multi-line send does.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && want.trim() && !drafting) {
              void write()
            }
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <span style={{ color: 'var(--faint)', flex: 1, lineHeight: 1.4 }}>
            what this one is for
          </span>
          <button
            style={{
              ...S.btn,
              ...(want.trim() && !drafting ? S.btnGo : S.btnOff),
              flex: '0 0 auto'
            }}
            disabled={!want.trim() || drafting}
            title="write the brief from that line"
            onClick={write}
          >
            {drafting ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Spinner /> writing…
              </span>
            ) : (
              'write it'
            )}
          </button>
        </div>
      </div>
      {briefError && (
        <div style={{ color: 'var(--danger)', lineHeight: 1.6, marginBottom: 6 }}>{briefError}</div>
      )}
      <textarea
        style={{ ...S.area, flex: 1, minHeight: 168, fontSize: 12 }}
        value={def.brief}
        spellCheck={false}
        placeholder={
          'You write the piece the editor asks for.\n\n' +
          'One at a time: finish the one you were given, say so, and stop.\n\n' +
          'When it is done: {"from": "{{self.id}}", "to": "editor", "subject": "done: <the piece>", "body": "<what you wrote>"}\n\n' +
          'Say the same when you are stuck, and why.'
        }
        // The brief only. It also wrote `- does:` from this box's first line,
        // which is the one line the hire dialog shows to say what a role is
        // for - and a brief opens "You are {{self.name}}, and you stand in for
        // the person running this floor", so the summary became the greeting,
        // placeholders and all, the moment anybody touched the brief. It is
        // its own sentence or it is nothing.
        onChange={(e) => set({ brief: e.target.value })}
      />
      <div style={{ color: 'var(--faint)', marginTop: 8 }}>
        <kbd>delete</kbd> takes this one off the floor.
      </div>
    </div>
  )
}

/**
 * The floor at a glance, above the file it is written in.
 *
 * The chain first: who runs the floor, then whoever they dispatch to, then
 * whoever that one hands work to. Nobody types it - it is read off the same
 * `- talks to:` lines the drawing is - so it cannot disagree with the file.
 *
 * Then the two numbers that decide who gets the next task, and the board's
 * stages. Those had a panel of their own over the drawing, holding fields for
 * things the file already says; this is the same floor said once. Only what a
 * field is better at than a line of text is a field here: two numbers, and a
 * colour nobody can type from memory. Naming a stage, adding one, taking one
 * off - that is typing, and the file is right there.
 */
/**
 * The one sentence a role is described by.
 *
 * `does:` when the floor wrote one. Otherwise the brief's opening sentence,
 * with the placeholders put back into words - `{{self.name}}` in a summary is
 * the template showing through, and the reader is not the agent it is filled in
 * for. Cut rather than wrapped: this is a line to skim, and the whole brief is
 * in the file underneath.
 */
const said = (def: { does?: string; brief?: string }): string => {
  if (def.does?.trim()) return def.does.trim()
  const first = (def.brief ?? '').replace(/\{\{[^}]*\}\}/g, '…').trim().split(/(?<=\.)\s/)[0] ?? ''
  return first.length > 180 ? `${first.slice(0, 177)}…` : first
}

function Summary({
  floor,
  onChange
}: {
  floor: WorkflowInfo
  onChange: (patch: Partial<WorkflowInfo>) => void
}) {
  const rank = ranks(floor)
  const levels = new Map<number, string[]>()
  for (const [who, at] of rank) levels.set(at, [...(levels.get(at) ?? []), who])
  const name = (r: string): string => (r === floor.human ? 'you' : (floor.roles[r]?.label ?? r))

  /**
   * The chain, and the report back up it.
   *
   * A rung with two roles on it is two names on one step - they are handed work
   * by the same person and neither waits on the other. The last step is the
   * human again when whoever reports may write to them, which is the half of
   * the loop a top-down list never shows.
   */
  const rungs = [...levels.keys()].sort((a, b) => a - b)
  const flow = rungs.map((at) => (levels.get(at) ?? []).map(name).join(' · '))
  // Only when the last rung is the one that speaks to the human. It used to be
  // added whenever anybody on the floor could - which on a chain of three drew
  // `you → the boss → marketing & sale → you` over a floor where the worker
  // writes to nobody but the boss. Who reports to the human is on that role's
  // own row; the chain is the chain.
  const last = levels.get(rungs[rungs.length - 1]) ?? []
  const reports = last.some(
    (who) => who !== floor.human && (floor.talksTo?.[who] ?? []).includes(floor.human)
  )
  if (reports && flow.length > 1) flow.push(name(floor.human))

  const num = (
    label: string,
    key: 'hireAbovePct',
    hint: string
  ): React.ReactElement => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }} title={hint}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <input
        type="number"
        style={{ ...S.field, flex: '0 0 auto', width: 48, textAlign: 'right' }}
        value={floor[key]}
        onChange={(e) => onChange({ [key]: Number(e.target.value) })}
      />
      <span style={{ color: 'var(--faint)' }}>%</span>
    </span>
  )

  return (
    <div style={S.ladder}>
      {/* Where a task goes, in one line.

          The rows below say who is on the floor and what each may do; neither
          answers the first question anybody has, which is what happens after
          they type something. Read off the same ranks the rows are, so it
          cannot drift from them: down the chain, and back to whoever reports. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 7 }}>
        {flow.map((step, i) => (
          <span key={`${step}-${i}`} style={{ display: 'inline-flex', gap: 6 }}>
            {i > 0 && <span style={{ color: 'var(--faint)' }}>→</span>}
            <span style={{ color: i === 0 ? 'var(--accent-ink)' : 'var(--ink)' }}>{step}</span>
          </span>
        ))}
      </div>

      {/* One row per role, not one per rung. The rungs were the whole summary
          and said only who is above whom - the floor's own file answers three
          more questions on every role in two lines, and reading them meant
          scrolling the file underneath. Rung, who, what they may do, who they
          may write to. */}
      {[...levels.keys()]
        .sort((a, b) => a - b)
        .flatMap((at) =>
          (levels.get(at) ?? []).map((who, i) => {
            const def = floor.roles[who]
            const can = (def?.can ?? []).join(', ')
            const to = (floor.talksTo?.[who] ?? []).map(name).join(' · ')
            return (
              <div key={`${at}-${who}`} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ color: 'var(--faint)', width: 14, flex: '0 0 auto' }}>
                  {i === 0 ? at : ''}
                </span>
                <span
                  style={{
                    ...CLIP,
                    flex: '1 1 34%',
                    color: at === 0 ? 'var(--accent-ink)' : 'var(--ink)'
                  }}
                  title={def?.does ?? ''}
                >
                  {name(who)}
                </span>
                <span style={{ ...CLIP, flex: '1 1 30%', color: 'var(--muted)' }} title={can}>
                  {can}
                </span>
                <span style={{ ...CLIP, flex: '1 1 36%', color: 'var(--faint)' }} title={to}>
                  {to && `\u2192 ${to}`}
                </span>
              </div>
            )
          })
        )}

      <div style={S.rule} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
        {num(
          'hire past',
          'hireAbovePct',
          'how much of its window an agent may already have used and still take work. Below it, work goes to whoever is in the role - idle first, and one mid-turn joins their board rather than being interrupted. At or over it, what is left is too little to work in and somebody new is hired'
        )}
      </div>

      {/* What the briefs say, one line each, folded away.

          A brief is the longest thing on a floor - a page of instruction per
          role - and it is also the thing that decides what an agent actually
          does, so a summary that leaves it out summarises the small half. The
          floor's own `does:` sentence is that line where there is one; where
          there is not, the brief's first sentence is what the agent is told
          first, which is the closest thing to a summary nobody has to write. */}
      <div style={S.rule} />
      <div style={{ ...LABEL, marginBottom: 4 }}>what each one is told</div>
      {Object.entries(floor.roles).map(([id, def]) => (
        <div key={id} style={{ display: 'flex', gap: 8, marginTop: 3 }}>
          <span style={{ ...CLIP, flex: '0 0 34%', color: 'var(--ink)' }}>{def.label}</span>
          <span style={{ flex: 1, minWidth: 0, color: 'var(--muted)', lineHeight: 1.5 }}>
            {said(def)}
          </span>
        </div>
      ))}

      {/* The rules, as the router will take them: the same lines the file lists
          under `## card rules`, said short. A floor that writes none is moved
          by who does what, and that is a state worth reading rather than an
          empty stretch of column. */}
      <div style={S.rule} />
      {floor.cardRules.length === 0 ? (
        <div style={{ color: 'var(--faint)' }}>
          no rule written - a card moves by who does what
        </div>
      ) : (
        floor.cardRules.map((r, i) => (
          <div
            key={`${r.from}-${r.to}-${i}`}
            style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}
            title={r.when ? `${floor.says?.when?.trim() || 'when'} ${r.when}` : undefined}
          >
            <span style={{ ...CLIP, flex: 1, color: 'var(--muted)' }}>
              {r.from} → {r.to}
            </span>
            <span style={{ color: 'var(--accent-ink)', flex: '0 0 auto' }}>
              {r.status === 'open'
                ? floor.says?.open?.trim() || 'opens a card'
                : r.status === 'closes'
                  ? floor.says?.closes?.trim() || 'closes it'
                  : (floor.columns.find((c) => c.key === r.status)?.label ?? r.status)}
              {r.whose === 'to' && (
                <span style={{ color: 'var(--faint)' }}>
                  {' '}
                  ({floor.says?.theirs?.trim() || 'their card'})
                </span>
              )}
            </span>
          </div>
        ))
      )}

      <div style={S.rule} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
        {floor.columns.map((c, i) => (
          <label
            key={c.key}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
            title={`the colour of "${c.label}" on the board - the name is the file's to change`}
          >
            <input
              type="color"
              style={S.swatch}
              value={c.bar}
              onChange={(e) =>
                onChange({
                  columns: floor.columns.map((col, at) =>
                    at === i ? { ...col, bar: e.target.value } : col
                  )
                })
              }
            />
            <span style={{ color: 'var(--muted)' }}>{c.label}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

/**
 * The floor as the file it is.
 *
 * Everything the drawing does not show - what the work is called, what the
 * columns are, what a message does to a card - lives here rather than in a
 * panel of dropdowns beside the picture. Somebody who wants to change it can
 * read the whole floor in one place, and everybody else never opens it.
 */
function FilePanel({
  floor,
  onChange,
  onText,
  onEdited
}: {
  floor: WorkflowInfo
  onChange: (patch: Partial<WorkflowInfo>) => void
  onText: (markdown: string, said: (ok: boolean, problems: string[]) => void) => void
  /**
   * Whether the box no longer says what the floor says.
   *
   * The bar's save button watched the drawing, and the parser drops what it
   * does not recognise rather than refusing it - so a line typed in here that
   * means nothing to it changed the text, changed no floor, and left a save
   * button that would not light in front of a file that plainly had been
   * edited. What is in the box is a thing that can be saved, whether or not it
   * survives the read.
   */
  onEdited: (differs: boolean) => void
}) {
  const [text, setText] = useState('')
  /** The floor as the file writes it, which is what `onEdited` is against. */
  const [canon, setCanon] = useState('')
  const [problems, setProblems] = useState<string[]>([])
  /**
   * Whether they are typing in here right now.
   *
   * Both directions are live, which is two writers on one string: re-rendering
   * the file under somebody mid-word moves their cursor to the end. So the box
   * follows the drawing whenever it is not the thing being typed in, and the
   * drawing follows the box whenever it is.
   */
  const [writing, setWriting] = useState(false)
  /**
   * Whether the last thing typed here parsed.
   *
   * It must not be thrown away when it does not: half a file is what somebody
   * typing a file has, and re-rendering the drawing over it on blur would
   * delete the work and say nothing.
   */
  const [bad, setBad] = useState(false)

  useEffect(() => {
    if (writing || bad) return
    let live = true
    window.bullpen.previewWorkflow(floor).then((r) => {
      if (!live) return
      setText(r.markdown)
      setCanon(r.markdown)
      setProblems(r.problems ?? [])
      onEdited(false)
    })
    return () => {
      live = false
    }
  }, [floor, writing, bad])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* One save, on the bar, where the apply is. There was a second one at
          the bottom of this column: two buttons for one act, on a box that
          already redraws the floor as it is typed in. */}
      <div style={{ color: 'var(--faint)', lineHeight: 1.6, margin: '0 0 6px' }}>
        The drawing, as it reads. Type in it and the drawing changes with it.
      </div>
      <Summary floor={floor} onChange={onChange} />
      {/* Above the box, not under it.
          `save the file` used to sit at the bottom of this column with the
          problems above it, and the box between them is as tall as the column -
          so somebody who typed a line the parser cannot read had the save
          button refuse to light with the reason two screens down. */}
      {bad ? (
        <div style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
          {problems[0] ?? 'Not a floor yet - the drawing is waiting for this to read.'}
        </div>
      ) : problems.length ? (
        <div style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
          {problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      ) : null}
      <textarea
        style={{ ...S.area, flex: 1, minHeight: 300 }}
        value={text}
        spellCheck={false}
        onFocus={() => setWriting(true)}
        onBlur={() => setWriting(false)}
        onChange={(e) => {
          setText(e.target.value)
          onEdited(e.target.value !== canon)
          onText(e.target.value, (ok, said) => {
            setBad(!ok)
            setProblems(said)
          })
        }}
      />
    </div>
  )
}

/** The floors you have, and which one is running. */
function FloorsPanel({
  running,
  onPick
}: {
  running: string
  /** Draw it. Running it is a second press, on the bar. */
  onPick: (w: WorkflowInfo, written: boolean) => void
}) {
  const [saved, setSaved] = useState<
    { name: string; description: string; markdown: string; builtin: boolean }[]
  >([])
  /** Each floor as a floor, not as a filename: what it looks like drawn. */
  const [shape, setShape] = useState<Record<string, WorkflowInfo>>({})
  const [said, setSaid] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  /** What the last press did, said where it was pressed. */
  const [note, setNote] = useState('')
  /**
   * Which way a new floor is being made, if one is.
   *
   * `pick` is the two ways offered; `ai` is the box you say it in. Both were
   * one step - a textarea with `a blank one` beside it - and a blank floor,
   * which is the faster of the two and the one that needs nothing typed, sat
   * behind a box asking you to type.
   */
  const [making, setMaking] = useState<'' | 'pick' | 'ai'>('')
  /** Which way is under the pointer. Inline styles have no `:hover`. */
  const [hover, setHover] = useState('')

  const list = (): void => {
    window.bullpen.workflowList().then(async (all) => {
      setSaved(all)
      const read = await Promise.all(
        all.map(async (w) => [w.name, (await window.bullpen.lintWorkflow(w.markdown)).preview] as const)
      )
      setShape(Object.fromEntries(read.filter(([, w]) => w)) as Record<string, WorkflowInfo>)
    })
  }
  useEffect(list, [])

  /**
   * Put one on the canvas. It used to be running by the time the click
   * finished - every screen in the app changed, agents were retired, and the
   * only way to look at a floor was to be on it. Picking is picking; `apply`
   * on the bar is what changes what the app runs.
   */
  const run = async (markdown: string, written = true): Promise<void> => {
    setError('')
    setNote('')
    const res = await window.bullpen.lintWorkflow(markdown)
    if (!res.preview) return setError(res.problems?.[0] ?? 'That floor could not be read.')
    onPick(res.preview, written)
    setNote('Drawn. Nothing is running it yet - press apply on the bar.')
  }

  /** A chart with the two parties every floor has, and nothing else. */
  const blank = async (): Promise<void> => {
    setBusy('new')
    await run(await window.bullpen.workflowBlank(), false)
    setBusy('')
    setMaking('')
  }

  /**
   * Say what the floor does and let the model draw it.
   *
   * A real model turn, so it is slow and it can come back unfinished - the
   * problems are shown and the floor is applied anyway, because a drawing with
   * something missing is still faster to fix than a blank canvas.
   */
  const describe = async (): Promise<void> => {
    const want = said.trim()
    if (!want) return
    setBusy('describe')
    setError('')
    const res = await window.bullpen.generateWorkflow(want)
    setBusy('')
    if (res.error) return setError(res.error)
    if (res.markdown) {
      await run(res.markdown, false)
      setSaid('')
      setMaking('')
      list()
      if (res.problems?.length) setError(`Drawn, with something left: ${res.problems[0]}`)
    }
  }

  return (
    <div>
      <div style={{ color: 'var(--faint)', lineHeight: 1.6, margin: '0 0 6px' }}>
        Switching changes what the app runs. Agents already up keep the shape they started on
        until they are restarted.
      </div>

      {/* Folded until it is wanted. This panel is opened to switch floors far
          more often than to write one, and the box for writing one sat above
          the list every time - three lines of controls in front of the thing
          that was actually being looked for. */}
      {!making ? (
        <button style={{ ...S.btn, margin: '0 0 10px' }} onClick={() => setMaking('pick')}>
          + new floor
        </button>
      ) : making === 'pick' ? (
        <div style={{ margin: '0 0 10px' }}>
          {(
            [
              [
                'ai',
                'describe it',
                'say what the floor does and the model draws it - roles, lines and briefs',
                true,
                () => setMaking('ai')
              ],
              [
                'new',
                'a blank floor',
                'you, a boss and a worker, with the lines between them - you draw the rest',
                false,
                blank
              ]
            ] as const
          ).map(([key, title, what, rec, go]) => (
            <button
              key={key}
              style={{
                ...S.btn,
                ...S.choice,
                ...(rec ? S.choiceRec : {}),
                ...(hover === key ? S.choiceHot : {})
              }}
              disabled={busy !== ''}
              onMouseEnter={() => setHover(key)}
              onMouseLeave={() => setHover('')}
              onClick={go}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                <span style={{ color: rec ? 'var(--accent-ink)' : 'var(--muted)' }}>
                  {rec ? '✦' : '▢'}
                </span>
                <span style={{ color: 'var(--ink)' }}>
                  {busy === 'new' && key === 'new' ? 'starting…' : title}
                </span>
                {rec && <span style={S.tag}>recommended</span>}
              </span>
              <span style={{ color: 'var(--faint)', lineHeight: 1.5, paddingLeft: 18 }}>
                {what}
              </span>
            </button>
          ))}
          <div style={{ display: 'flex' }}>
            <span style={{ flex: 1 }} />
            <button style={S.btn} disabled={busy !== ''} onClick={() => setMaking('')}>
              cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ margin: '0 0 10px' }}>
          <div style={{ ...LABEL, marginBottom: 4 }}>say what the floor does</div>
          <textarea
            style={{ ...S.area, height: 108, fontSize: 12.5 }}
            value={said}
            autoFocus
            spellCheck={false}
            placeholder={
              'an editor who hands pieces to a writer, and a proofreader who lets them through'
            }
            onChange={(e) => setSaid(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button
              style={{ ...S.btn, ...(said.trim() ? S.btnGo : S.btnOff) }}
              disabled={!said.trim() || busy !== ''}
              onClick={describe}
            >
              {busy === 'describe' ? 'drawing it…' : 'draw it'}
            </button>
            <span style={{ flex: 1 }} />
            <button style={S.btn} disabled={busy !== ''} onClick={() => setMaking('pick')}>
              back
            </button>
          </div>
        </div>
      )}

      {/* Two lists, not one.
          They were one, sorted by nothing, with `remove` in red beside every
          row - and `remove` meant two different things depending on which row
          it was on: a floor you wrote is a file and goes for good, one that
          ships with Bullpen only comes off the list. Same word, same colour,
          two outcomes, and nothing on the row saying which kind it was. */}
      {(
        [
          ['the ones you wrote', saved.filter((w) => !w.builtin)],
          ['the ones that ship', saved.filter((w) => w.builtin)]
        ] as const
      ).map(([title, group]) =>
        group.length === 0 ? null : (
          <div key={title}>
            <div style={{ ...LABEL, marginTop: 10, marginBottom: 4 }}>{title}</div>
            {group.map((w) => {
              const here = w.name === running
              return (
                <div
                  key={w.name}
                  role="button"
                  title={here ? 'this is the floor running' : `run ${w.name}`}
                  style={{
                    ...S.card,
                    ...(here ? S.cardOn : {}),
                    cursor: here ? 'default' : 'pointer'
                  }}
                  onClick={() => !here && run(w.markdown)}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ color: here ? 'var(--ok)' : 'var(--ink)', flex: 1 }}>
                      {w.name}
                    </span>
                    {here && <span style={{ color: 'var(--ok)' }}>running</span>}
                    {!here && !w.builtin && (
                      <button
                        style={S.btn}
                        title="delete the file, with nothing that brings it back"
                        onClick={async (e) => {
                          e.stopPropagation()
                          // A file, deleted outright, with nothing anywhere
                          // that restores it - and it sits one unguarded click
                          // from a card you click to switch floors.
                          if (
                            !confirm(
                              `Delete "${w.name}"? The file is removed and there is no way back to it.`
                            )
                          ) {
                            return
                          }
                          setError('')
                          setNote('')
                          const res = await window.bullpen.deleteWorkflow(w.name)
                          if (res.error) return setError(res.error)
                          setNote(`${w.name} is deleted.`)
                          list()
                        }}
                      >
                        delete
                      </button>
                    )}
                  </div>
                  <div style={{ color: 'var(--faint)', lineHeight: 1.5 }}>{w.description}</div>
                  <Shape floor={shape[w.name]} />
                </div>
              )
            })}
          </div>
        )
      )}
      {note && <div style={{ color: 'var(--ok)', marginTop: 6 }}>{note}</div>}
      {error && <div style={{ color: 'var(--danger)' }}>{error.split('\n')[0]}</div>}
    </div>
  )
}

/** A capability name nobody has taken. */
const freeName = (floor: WorkflowInfo): string => {
  for (let n = 1; ; n++) {
    const name = `work_${n}`
    if (!floor.capabilities.some((c) => c.name === name)) return name
  }
}


/**
 * A floor in one line: who it goes through, in the order work moves.
 *
 * The list used to be a name and 34 characters of description, which is the
 * same amount somebody can learn about a floor by reading its filename. This is
 * the drawing, flattened - the same columns `layout` puts the boxes in.
 */
function Shape({ floor }: { floor?: WorkflowInfo }) {
  if (!floor) return null
  const placed = layout(floor)
  const columns = new Map<number, string[]>()
  for (const n of placed) {
    const label = n.kind === 'role' ? (floor.roles[n.id]?.label ?? n.id) : 'you'
    columns.set(n.x, [...(columns.get(n.x) ?? []), label])
  }
  const order = [...columns.keys()].sort((a, b) => a - b)

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 6 }}>
      {order.map((x, i) => (
        <span key={x} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {i > 0 && <span style={{ color: 'var(--faint)' }}>→</span>}
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {(columns.get(x) ?? []).map((label) => (
              <span key={label} style={S.step}>
                {label}
              </span>
            ))}
          </span>
        </span>
      ))}
      <span style={{ color: 'var(--faint)', marginLeft: 4 }}>
        {Object.keys(floor.roles).length} roles
      </span>
    </div>
  )
}

/**
 * What a line is, said where the line is.
 *
 * It carried the card rules for the pair - two boxes of `- from → to: opens a
 * card · when work is handed over` - on the reasoning that the arrow is what
 * people draw first, so the rule should live on it. But an arrow already says
 * the whole of what it means: these two work together, either may write to the
 * other, and whichever of them stands further from the person running the
 * floor reports to the other. Everything else in those boxes was a sentence
 * describing the arrow back to whoever had just drawn it.
 *
 * The rules themselves are not gone, they are where the rest of the floor's
 * machinery is: in the file, under `## card rules`, which `read it` opens. A
 * floor that writes none gets the ones `defaultCardRules` works out from who
 * does what.
 */
function TalkInspector({
  floor,
  from,
  to,
  onDelete,
  onClose
}: {
  floor: WorkflowInfo
  from: string
  to: string
  onDelete: () => void
  onClose: () => void
}) {
  const name = (r: string): string => (r === floor.human ? 'you' : (floor.roles[r]?.label ?? r))

  // Who stands nearer the person running the floor. That one is reported to;
  // level with each other, neither is.
  const rank = ranks(floor)
  const above =
    (rank.get(from) ?? 99) === (rank.get(to) ?? 99)
      ? null
      : (rank.get(from) ?? 99) < (rank.get(to) ?? 99)
        ? from
        : to
  const below = above === from ? to : from

  /**
   * Whether this pair is also where a task typed at the floor lands. It is
   * drawn and not declared, so taking it off moves it to somebody else rather
   * than leaving a floor nothing can be dispatched to.
   */
  const arriving =
    (from === floor.human && to === floor.dispatch) ||
    (to === floor.human && from === floor.dispatch)
  const elsewhere = Object.keys(floor.roles).some((r) => r !== floor.dispatch)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ ...LABEL, color: 'var(--accent-ink)', flex: 1 }}>
          {name(from)} ⇄ {name(to)}
        </span>
        <button style={S.close} title="close" onClick={onClose}>
          ×
        </button>
      </div>
      <div style={{ color: 'var(--faint)', lineHeight: 1.6, marginTop: 4 }}>
        {above
          ? `${name(below)} reports the work back to ${name(above)}.`
          : 'Level with each other - neither reports to the other.'}
      </div>
      {/* A line the board does not follow. Only worth saying on a floor that
          wrote its own rules - one that wrote none is moved by the rules worked
          out from the drawing, which is every line on it. */}
      {floor.cardRules.length > 0 && !ruled(floor, from, to) && (
        <div style={{ color: 'var(--muted)', lineHeight: 1.6, marginTop: 6 }}>
          No rule moves a card between these two, so the board will not follow this line. Write one
          under <b>the whole file</b>, or let the drawing write them all under <b>the company</b>.
        </div>
      )}
      {arriving && (
        <div style={{ color: 'var(--faint)', lineHeight: 1.6, marginTop: 6 }}>
          {elsewhere
            ? 'A task you type lands here. Taking the line off hands that to somebody else.'
            : 'A task you type lands here, and there is nobody else to hand it to.'}
        </div>
      )}
      {(!arriving || elsewhere) && (
        <button style={{ ...S.btn, marginTop: 8, width: '100%' }} onClick={onDelete}>
          take the line off · <kbd>backspace</kbd>
        </button>
      )}
    </div>
  )
}

/**
 * Something turning while the window is on its way down.
 *
 * Drawn rather than animated in CSS: this file has no stylesheet to put a
 * `@keyframes` in, and a rotating border is one element and one rule.
 */
function Spinner() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 9,
        height: 9,
        border: '1px solid var(--line)',
        borderTopColor: 'var(--accent-ink)',
        borderRadius: '50%',
        animation: 'bp-spin 0.7s linear infinite'
      }}
    />
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={S.line}>
      <span style={{ color: 'var(--muted)', width: 96, flex: '0 0 auto' }}>{label}</span>
      {children}
    </div>
  )
}

/** The floating panel's box, which two places have to agree on. */
/** What the column is showing, said once at the top of it. */
/** One line, cut with an ellipsis rather than wrapped. */
const CLIP: React.CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

const PANEL_TITLE: Record<string, string> = {
  role: 'this role',
  edge: 'this line',
  floors: 'switch floor',
  file: 'the whole file'
}

const S: Record<string, React.CSSProperties> = {
  wrap: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden' },
  bar: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    flex: '0 0 auto',
    boxSizing: 'border-box',
    padding: '5px 8px',
    border: '1px solid var(--line)',
    background: 'var(--panel)'
  },
  state: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    flex: '0 0 auto',
    boxSizing: 'border-box',
    height: 24,
    // No box of its own. The bar is the box; a bordered chip inside a bordered
    // strip is two frames around one word, and the inner one never lined up
    // with the buttons opposite it.
    padding: 0
  },
  dot: { width: 7, height: 7, borderRadius: 7, display: 'inline-block', flex: '0 0 auto' },
  group: { display: 'flex', flex: '0 0 auto' },
  /** One of the ways to make a floor: what it is called, and what it does. */
  choice: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 3,
    width: '100%',
    height: 'auto',
    textAlign: 'left',
    background: 'var(--sunk)',
    borderLeftWidth: 2,
    padding: '8px 10px',
    marginBottom: 6
  },
  /** The one to take when you have no reason to take the other. */
  choiceRec: { borderColor: 'var(--accent-ink)' },
  choiceHot: { background: 'var(--panel)', borderColor: 'var(--ink)' },
  tag: {
    ...LABEL,
    fontSize: 9,
    color: 'var(--accent-ink)',
    border: '1px solid var(--accent-ink)',
    padding: '0 4px',
    marginLeft: 'auto'
  },
  /** The model's corner of the role panel: say the job, get the brief. */
  gen: {
    boxSizing: 'border-box',
    padding: '8px 9px',
    marginBottom: 8,
    background: 'var(--sunk)',
    border: '1px solid var(--line)',
    borderLeft: '2px solid var(--accent-ink)'
  },
  /** A hairline between the three things the summary says. */
  rule: { height: 1, background: 'var(--line)', margin: '7px 0' },
  swatch: {
    width: 14,
    height: 14,
    flex: '0 0 auto',
    padding: 0,
    border: '1px solid var(--line)',
    background: 'none',
    cursor: 'pointer'
  },
  sideHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flex: '0 0 auto',
    // Tall enough for the save that sometimes stands in it, always. Sized to
    // its contents, the heading moved down the moment the floor was touched
    // and back up when it was written - the whole column stepping about
    // because one button had appeared.
    minHeight: 20,
    marginBottom: 6
  },
  /** The one thing that scrolls, and it is as tall as the dialog. */
  sideBody: { flex: 1, minHeight: 0, overflow: 'auto', paddingRight: 2 },
  body: { flex: 1, display: 'flex', gap: 10, minHeight: 0 },
  side: {
    flex: '0 0 420px',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    // So what opens about the whole floor can cover it.
    position: 'relative',
    // The header stays where it is and `sideBody` is what moves: a title that
    // scrolls away leaves a column of controls with nothing saying what they
    // are about.
    minHeight: 0,
    padding: 10,
    border: '1px solid var(--line)',
    background: 'var(--panel)'
  },
  /** Who answers to whom, said in the order it is answered in. */
  ladder: {
    flex: '0 0 auto',
    padding: '6px 8px',
    marginBottom: 6,
    border: '1px solid var(--line)',
    background: 'var(--sunk)',
    lineHeight: 1.7
  },
  /** So what is in the column can be as tall as it is, rather than 300px of it. */
  sideTall: { display: 'flex', flexDirection: 'column' },
  board: {
    flex: 1,
    position: 'relative',
    // Not `auto`: the drawing is dragged and zoomed, and a scrollbar beside a
    // canvas that pans is two ways to do the same thing that disagree.
    overflow: 'hidden',
    border: '1px solid var(--line)',
    // The dotted ground belongs to the canvas, not to the drawing on it. As a
    // rect inside the SVG it stopped where the drawing did - the grid covered
    // the corner the boxes happened to be in and nothing else.
    background: 'var(--sunk)',
    backgroundImage: 'radial-gradient(var(--line) 1px, transparent 1px)',
    backgroundSize: '16px 16px',
    backgroundPosition: '30px 30px'
  },
  handle: {
    position: 'absolute',
    zIndex: 1,
    width: 18,
    height: 18,
    padding: 0,
    borderRadius: 9,
    border: '1px solid var(--line)',
    background: 'var(--panel)',
    cursor: 'pointer'
  },
  /** Over the file rather than beside it: same column, one at a time. */
  over: {
    position: 'absolute',
    inset: 0,
    zIndex: 3,
    display: 'flex',
    flexDirection: 'column',
    padding: 10,
    background: 'var(--panel)'
  },
  /** A panel at the thing it is about, rather than beside the drawing. */
  pop: {
    position: 'absolute',
    zIndex: 5,
    width: 300,
    // The canvas does not scroll, so a panel taller than it would have its
    // bottom clipped by the board and no way to reach it.
    maxHeight: 600,
    // A column, so the one part of a panel that is long - the brief - takes
    // what room is left rather than pushing the panel past its own height.
    // Two scrollbars side by side, the panel's and the brief's, were one
    // scrollbar too many and neither said what it moved.
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
    transformOrigin: 'top left',
    padding: 10,
    border: '1px solid var(--line)',
    background: 'var(--panel)',
    boxShadow: '0 2px 8px rgba(0,0,0,0.18)'
  },
  menu: {
    position: 'absolute',
    zIndex: 6,
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 156
  },
  menuItem: {
    background: 'none',
    border: 0,
    color: 'var(--ink)',
    font: 'inherit',
    textAlign: 'left',
    padding: '5px 10px',
    cursor: 'pointer'
  },
  /** Over the drawing, near what was clicked - not a column that is always there. */
  close: {
    background: 'none',
    border: 0,
    color: 'var(--faint)',
    cursor: 'pointer',
    font: 'inherit'
  },
  line: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 },
  /** A word you can turn on, for the ones a floor names itself. */
  card: {
    border: '1px solid',
    borderColor: 'var(--line)',
    background: 'var(--sunk)',
    padding: '6px 8px',
    marginBottom: 6
  },
  cardOn: { borderColor: 'var(--ok)' },
  step: {
    border: '1px solid var(--line)',
    background: 'var(--panel)',
    padding: '0 5px',
    color: 'var(--muted)',
    whiteSpace: 'nowrap'
  },
  field: {
    flex: 1,
    minWidth: 0,
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    color: 'var(--ink)',
    font: 'inherit',
    padding: '3px 5px'
  },
  area: {
    width: '100%',
    boxSizing: 'border-box',
    resize: 'none',
    background: 'var(--sunk)',
    border: '1px solid var(--line)',
    color: 'var(--ink)',
    font: `11px ${MONO}`,
    lineHeight: 1.5,
    padding: 6
  },
  colour: { width: 30, height: 22, padding: 0, border: '1px solid var(--line)', cursor: 'pointer' },
  chips: { display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 },
  /**
   * `border` as longhands, not the shorthand.
   *
   * The `*On` beside every one of these overrides `borderColor`, and React
   * clears a longhand it set last render without rewriting the shorthand that
   * is still in the object - so switching a thing *off* left border-color at
   * `currentcolor`, a white box around whatever had last been on. Base colour
   * as a longhand too, and the two states overwrite each other cleanly.
   */
  chip: {
    padding: '2px 7px',
    border: '1px solid',
    borderColor: 'var(--line)',
    color: 'var(--muted)',
    cursor: 'pointer'
  },
  chipOn: { borderColor: 'var(--accent-ink)', color: 'var(--accent-ink)', background: 'var(--panel)' },
  x: { background: 'none', border: 0, color: 'var(--faint)', cursor: 'pointer', font: 'inherit' },
  mark: {
    fill: 'var(--muted)',
    font: `18px ${MONO}`,
    textAnchor: 'middle' as const
  },
  glyph: {
    fill: 'var(--accent-ink)',
    font: `20px ${MONO}`,
    textAnchor: 'middle' as const,
    fontWeight: 700
  },
  name: { fill: 'var(--ink)', font: `12px ${MONO}`, textAnchor: 'middle' as const },
  what: { fill: 'var(--faint)', font: `11px ${MONO}`, textAnchor: 'middle' as const },
  /** The one that is open, so a pressed button looks pressed. */
  btnOn: { borderColor: 'var(--accent-ink)', color: 'var(--accent-ink)' },
  /**
   * Off, and that is a look of its own.
   *
   * It was `--ink`, which is the colour of everything that is on: a row of
   * buttons nobody had pressed read as a row of pressed buttons, and the one
   * that *was* on had to be told apart from four that only looked it. Two
   * states on this floor and nowhere else: quiet, or the app's own yellow.
   */
  btn: {
    background: 'var(--panel)',
    border: '1px solid',
    borderColor: 'var(--line)',
    color: 'var(--muted)',
    font: 'inherit',
    boxSizing: 'border-box',
    height: 24,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 9px',
    cursor: 'pointer'
  },
  btnGo: { borderColor: 'var(--accent-ink)', color: 'var(--accent-ink)' },
  btnOff: { opacity: 0.7, cursor: 'default' },
  linkBtn: {
    background: 'none',
    border: 0,
    color: 'var(--danger)',
    cursor: 'pointer',
    font: 'inherit',
    padding: 0
  }
}
