import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { Mode } from './theme'

/**
 * One xterm instance per agent, kept alive across tab switches: re-creating it
 * on every select would throw away scrollback, which is the whole point of
 * watching an agent work.
 */
const terms = new Map<string, { term: Xterm; fit: FitAddon }>()
let mode: Mode = 'light'

const THEMES: Record<Mode, { background: string; foreground: string; cursor: string; selectionBackground: string }> = {
  light: { background: '#ffffff', foreground: '#2a2a26', cursor: '#2a2a26', selectionBackground: '#f0e2b0' },
  dark: { background: '#0c0d13', foreground: '#d9dce2', cursor: '#d9dce2', selectionBackground: '#31364a' }
}

function get(id: string): { term: Xterm; fit: FitAddon } {
  const existing = terms.get(id)
  if (existing) return existing
  const term = new Xterm({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12.5,
    cursorBlink: true,
    scrollback: 10_000,
    theme: THEMES[mode]
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.onData((data) => window.bullpen.write(id, data))
  const entry = { term, fit }
  terms.set(id, entry)
  return entry
}

/** Recolour every live terminal, including ones whose tab is hidden. */
export function setTerminalTheme(next: Mode): void {
  mode = next
  for (const { term } of terms.values()) term.options.theme = THEMES[next]
}

/** Feed PTY output into the right buffer even while its tab is hidden. */
export function writeToTerminal(id: string, chunk: string): void {
  get(id).term.write(chunk)
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

function TerminalHost({ id, visible }: { id: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const { term, fit } = get(id)
    if (!el.hasChildNodes()) term.open(el)

    const resize = () => {
      try {
        fit.fit()
        window.bullpen.resize(id, term.cols, term.rows)
      } catch {
        // Fires while the pane is display:none and has no size yet.
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
