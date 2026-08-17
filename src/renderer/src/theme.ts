export type Mode = 'light' | 'dark'

/**
 * One place for every colour. Components reference `var(--x)` rather than
 * importing anything, so switching mode is a single style object on the root -
 * no context, no prop drilling, no re-render of the tree.
 */
export const VARS: Record<Mode, Record<string, string>> = {
  light: {
    '--bg': '#faf9f5',
    '--panel': '#ffffff',
    '--sunk': '#f3f1ea',
    '--ink': '#1b1b19',
    '--muted': '#8c8b80',
    '--faint': '#b5b3a7',
    '--line': '#e6e3da',
    '--accent': '#e0a800',
    '--accent-ink': '#7a5c00',
    '--ok': '#3f9e63',
    '--warn': '#e08a2e',
    '--danger': '#d64c4c',
    '--term-bg': '#ffffff',
    '--term-fg': '#2a2a26',
    // Syntax. Kept here with everything else so the editor switches mode with
    // the rest of the app instead of carrying a second palette of its own.
    '--code-key': '#9b2c5f',
    '--code-str': '#3f7a3f',
    '--code-num': '#b4632a',
    '--code-fn': '#2b6ca3',
    '--code-type': '#7a5cc0',
    '--code-prop': '#2f6f6a',
    '--code-comment': '#a8a496',
    '--code-punct': '#8c8b80',
    '--code-heading': '#7a5c00'
  },
  dark: {
    '--bg': '#101119',
    '--panel': '#161822',
    '--sunk': '#0c0d13',
    '--ink': '#d9dce2',
    '--muted': '#7c8290',
    '--faint': '#565c6b',
    '--line': '#242733',
    '--accent': '#e0a800',
    '--accent-ink': '#f0c95a',
    '--ok': '#4caf6d',
    '--warn': '#e0a03c',
    '--danger': '#e05a5a',
    '--term-bg': '#0c0d13',
    '--term-fg': '#d9dce2',
    '--code-key': '#e07aa8',
    '--code-str': '#8fcf85',
    '--code-num': '#e8a45c',
    '--code-fn': '#6fb8f0',
    '--code-type': '#c3a0f5',
    '--code-prop': '#5fc9bd',
    '--code-comment': '#5e6472',
    '--code-punct': '#7c8290',
    '--code-heading': '#f0c95a'
  }
}

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace'

/** Uppercase, letterspaced label - the retro chrome in one place. */
export const LABEL: React.CSSProperties = {
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  fontSize: 10,
  color: 'var(--muted)'
}
