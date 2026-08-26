import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as Xterm, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { Mode } from './theme'
import { getPrefs } from './prefs'

/**
 * One xterm instance per agent, kept alive across tab switches: re-creating it
 * on every select would throw away scrollback, which is the whole point of
 * watching an agent work.
 */
const terms = new Map<string, { term: Xterm; fit: FitAddon; queued?: string[] }>()
let mode: Mode = 'light'

/**
 * Background, foreground AND the 16 ANSI colours.
 *
 * Setting only the first two was the bug: xterm's stock palette is drawn for a
 * dark terminal, so on the light background the CLI's yellows, cyans and its
 * dim grey - which is `brightBlack`, and which it uses for most of its own
 * chrome - came out too pale to read. Each mode gets colours picked against its
 * own background instead.
 */
const THEMES: Record<Mode, ITheme> = {
  light: {
    background: '#ffffff',
    foreground: '#2a2a26',
    cursor: '#2a2a26',
    selectionBackground: '#f0e2b0',
    black: '#2a2a26',
    red: '#b23b3b',
    green: '#2f7a3f',
    yellow: '#8a6200',
    blue: '#1f5fa8',
    magenta: '#8a3f8a',
    cyan: '#12706e',
    white: '#c9c6bc',
    brightBlack: '#6b6a60',
    brightRed: '#d64c4c',
    brightGreen: '#3f8f57',
    brightYellow: '#a67c00',
    brightBlue: '#2b6ca3',
    brightMagenta: '#9c4c9c',
    brightCyan: '#1a8481',
    brightWhite: '#8c8b80'
  },
  dark: {
    background: '#0c0d13',
    foreground: '#d9dce2',
    cursor: '#d9dce2',
    selectionBackground: '#31364a',
    // Not #000: an agent printing black text would otherwise be invisible.
    black: '#3a3f4b',
    red: '#e05a5a',
    green: '#4caf6d',
    yellow: '#e0a800',
    blue: '#6fb8f0',
    magenta: '#c3a0f5',
    cyan: '#5fc9bd',
    white: '#d9dce2',
    brightBlack: '#7c8290',
    brightRed: '#ff8080',
    brightGreen: '#79d99a',
    brightYellow: '#f0c95a',
    brightBlue: '#8fd0ff',
    brightMagenta: '#d8b6ff',
    brightCyan: '#86e0d5',
    brightWhite: '#ffffff'
  }
}

function get(id: string): { term: Xterm; fit: FitAddon; queued?: string[] } {
  const existing = terms.get(id)
  if (existing) return existing
  const term = new Xterm({
    fontFamily: FONT,
    fontSize: FONT_SIZE,
    cursorBlink: true,
    scrollback: 10_000,
    theme: THEMES[mode]
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.onData((data) => window.bullpen.write(id, data))
  /**
   * A new buffer for an agent that has been running for a while.
   *
   * Applying a floor reloads the window, and an agent whose role is on the new
   * floor is not restarted with it - so this opens onto a pty that has already
   * printed everything it had to say. Nothing replayed it, and an idle agent
   * prints nothing more, so the pane stayed black while the agent behind it was
   * up and well.
   *
   * Live output is held until the replay lands rather than written straight
   * through: the fetch is a round trip to main, and a chunk that arrives during
   * it would otherwise be painted before the history it comes after.
   */
  const entry: { term: Xterm; fit: FitAddon; queued?: string[] } = { term, fit, queued: [] }
  terms.set(id, entry)
  window.bullpen
    .backlog(id)
    .then((past) => {
      if (past) term.write(past)
    })
    .catch(() => {
      // An older main with no such handler. A blank terminal is what this was
      // before; it is not worth failing the pane over.
    })
    .finally(() => {
      for (const chunk of entry.queued ?? []) term.write(chunk)
      entry.queued = undefined
    })
  return entry
}

/**
 * Resize the text in every live terminal, and tell each pty what it now fits.
 *
 * The cell measurement is thrown away with it: it is what a spawn size is
 * computed from, and a 12.5px cell would have the next agent's CLI drawing its
 * welcome box at the wrong width.
 */
export function setTerminalFontSize(px: number): void {
  FONT_SIZE = px
  cell = null
  for (const [id, { term, fit }] of terms) {
    term.options.fontSize = px
    try {
      fit.fit()
      window.bullpen.resize(id, term.cols, term.rows)
    } catch {
      // A terminal whose element is not on screen cannot be fitted; the deck
      // fits it again when its tab comes back.
    }
  }
}

/** Recolour every live terminal, including ones whose tab is hidden. */
export function setTerminalTheme(next: Mode): void {
  mode = next
  for (const { term } of terms.values()) term.options.theme = THEMES[next]
}

/**
 * The stack every terminal is drawn in, agents and the shell alike.
 *
 * The Nerd Font entries are first because of what runs inside these panes: the
 * CLI draws its chrome in box glyphs, and anything a human starts in the shell
 * - nvim, lazygit, eza - draws icons out of the private use area. None of the
 * system monospace faces have those codepoints, and a missing codepoint is a
 * tofu box, not a fallback.
 *
 * `Symbols Nerd Font Mono` is last on purpose. Fallback in CSS is per glyph, so
 * it never supplies a letter - it only catches the icons when the faces above
 * it have none, which is the case on a machine with only the symbols font
 * installed. A machine with no Nerd Font at all falls through to exactly the
 * stack this had before, tofu included; there is nothing here to break.
 *
 * The `Mono` variants, not the bare families: the others are proportional or
 * `Propo`-spaced, and a double-width glyph in a grid xterm measured from one
 * cell smears the line it is on.
 */
const FONT =
  "'JetBrainsMono Nerd Font Mono', 'Hack Nerd Font Mono', ui-monospace, SFMono-Regular, " +
  "Menlo, Consolas, 'Symbols Nerd Font Mono', monospace"

/**
 * The size text is set at, in every terminal at once.
 *
 * A module variable rather than a prop: terminals are kept alive outside the
 * React tree so a tab switch does not lose scrollback, and the cell measurement
 * below - which decides what size a pty is spawned at - has no component to
 * read a prop from.
 */
let FONT_SIZE = getPrefs().fontSize

/**
 * Cell size for the terminal font, measured once from a real glyph.
 *
 * Needed before any terminal exists: an agent's pty is spawned with the size
 * the pane will actually be, so the CLI's first paint - its welcome box - is
 * drawn at the right width. Spawning at node-pty's default and resizing a beat
 * later leaves that first box wrapped at the wrong width in the scrollback,
 * where nothing can redraw it.
 */
let cell: { w: number; h: number } | null = null

function measureCell(): { w: number; h: number } {
  if (cell) return cell
  const probe = document.createElement('span')
  probe.textContent = 'W'.repeat(100)
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${FONT_SIZE}px ${FONT}`
  document.body.appendChild(probe)
  const rect = probe.getBoundingClientRect()
  probe.remove()
  cell = { w: rect.width / 100 || 7.5, h: rect.height || Math.ceil(FONT_SIZE * 1.2) }
  return cell
}

/**
 * The pane a terminal actually lives in.
 *
 * Not `document.querySelector('section')`, which is what every spawn used to
 * measure: each panel is wrapped in a `<section data-pane>`, so the first one
 * in the document is whichever panel the operator dragged left - the roster, at
 * about 230px, which is 30 columns. The CLI then drew its whole first screen
 * 30 columns wide and nothing corrected it, because the *element* never
 * changed size and the ResizeObserver had nothing to fire on. Switching tabs
 * fixed it, which is the reveal path below.
 */
export const termPane = (): Element | null =>
  document.querySelector('[data-term-pane]') ?? document.querySelector('section')

/**
 * The dimensions a new agent's pty should start at, taken from the pane it will
 * live in. Falls back to a conventional 80x24 rather than to a guess that could
 * be absurd - a wrong size here is exactly what garbles the CLI's first paint.
 */
export function paneSize(el: Element | null): { cols: number; rows: number } {
  const box = el?.getBoundingClientRect()
  if (!box || box.width < 40 || box.height < 40) return { cols: 80, rows: 24 }
  const { w, h } = measureCell()
  return {
    cols: Math.max(20, Math.floor((box.width - 20) / w)),
    rows: Math.max(6, Math.floor(box.height / h))
  }
}

/**
 * The modes a terminal must not still be in when a new process arrives.
 *
 * The terminal outlives the process on purpose - the scrollback is what an
 * operator reads after a restart - but its *modes* belong to the process that
 * turned them on. Mouse reporting is the one that shows: the old CLI asked for
 * motion events, the new one has not started reading yet, and the pty echoes
 * every mouse move back as text, so moving the pointer over a just-restarted
 * agent typed `^[[<35;122;42M` into it.
 *
 * Written into the terminal rather than reset with `term.reset()`, which would
 * also throw away the scrollback this map exists to keep.
 */
const RESET_MODES =
  // Back to the main screen, if the old process left the alternate one up.
  '\u001b[?1049l' +
  // Mouse: click, click+drag, any-motion, and the three coordinate encodings.
  '\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1005l\u001b[?1006l\u001b[?1015l' +
  // Bracketed paste, application cursor keys, application keypad.
  '\u001b[?2004l\u001b[?1l\u001b>' +
  // Autowrap on, cursor visible, colours back to plain.
  '\u001b[?7h\u001b[?25h\u001b[0m'

/**
 * Drop the modes the outgoing process turned on. Call before it is replaced.
 *
 * Before, not after: between the old process dying and the new one taking the
 * terminal over, the pty is in its default line discipline and echoes whatever
 * arrives - which, with mouse reporting still on, is every movement of the
 * pointer sitting over the pane the operator just clicked in.
 */
export function forgetModes(id: string): void {
  if (terms.has(id)) writeToTerminal(id, RESET_MODES)
}

/**
 * Measure again, for a pty that was replaced.
 *
 * A restart - a new model, a new directory - hands the same host element a
 * brand new process, which starts at whatever size it was spawned with and is
 * never told otherwise: the element did not move, so nothing here fires. This
 * is the one call that says "the thing on the other end is new".
 */
export function refit(id: string): void {
  const entry = terms.get(id)
  if (!entry) return
  try {
    entry.fit.fit()
    window.bullpen.resize(id, entry.term.cols, entry.term.rows)
  } catch {
    // Not laid out yet. The reveal effect fits it when its tab comes back.
  }
}

/** Feed PTY output into the right buffer even while its tab is hidden. */
export function writeToTerminal(id: string, chunk: string): void {
  const entry = get(id)
  // Still waiting on the replay of what came before it. Held, not dropped.
  if (entry.queued) entry.queued.push(chunk)
  else entry.term.write(chunk)
}

export function disposeTerminal(id: string): void {
  terms.get(id)?.term.dispose()
  terms.delete(id)
}

/**
 * One host element per agent, all mounted, only the selected one visible.
 *
 * The obvious version - a single <Terminal id={selected}/> - is wrong: xterm's
 * open() APPENDS to the host, so switching agents stacked every terminal into
 * the same div and you saw whichever painted last, not the one you picked.
 */
export function TerminalDeck({ ids, selected }: { ids: string[]; selected: string | null }) {
  return (
    <>
      {ids.map((id) => (
        <TerminalHost key={id} id={id} visible={id === selected} />
      ))}
    </>
  )
}

/**
 * One terminal bound to one pty id. Exported for the shell tab, which is a
 * single terminal rather than a deck of them.
 */
export function TerminalHost({ id, visible }: { id: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const { term, fit } = get(id)
    // open() only works once: xterm keeps the element it was given, and calling
    // it again on a terminal that already has one does nothing. A remount hands
    // us a fresh host, so the terminal has to be moved into it - re-creating it
    // instead would throw away the scrollback this map exists to preserve.
    if (!term.element) term.open(el)
    else if (term.element.parentElement !== el) el.appendChild(term.element)

    const resize = () => {
      // A hidden or unlaid-out pane measures near zero. Fitting to that sends
      // the pty a nonsense width, and every later CLI paint is drawn to it.
      if (el.clientWidth < 40 || el.clientHeight < 40) return
      try {
        fit.fit()
        window.bullpen.resize(id, term.cols, term.rows)
      } catch (err) {
        console.warn(`[bullpen] fit failed for ${id}:`, err)
      }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    return () => ro.disconnect()
  }, [id])

  // A hidden pane has no size, so its fit() was a no-op; redo it on reveal or
  // the agent keeps writing at whatever dimensions it started with.
  useEffect(() => {
    if (!visible) return
    const entry = terms.get(id)
    if (!entry) return
    try {
      entry.fit.fit()
      window.bullpen.resize(id, entry.term.cols, entry.term.rows)
    } catch {
      /* still laying out */
    }
  }, [visible, id])

  return <div ref={host} style={{ width: '100%', height: '100%', display: visible ? 'block' : 'none' }} />
}
