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
    '--term-fg': '#2a2a26'
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
    '--term-fg': '#d9dce2'
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
