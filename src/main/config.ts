import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Settings that outlive a run. Small on purpose: only what a person actually
 * has to change, and only what cannot be derived from the floor itself.
 */
export type Config = {
  /**
   * Where Michael lives. `~/.bullpen/michael` is a default, not a decision -
   * one machine's home directory is not another's, and the operator may want
   * his workspace on a different disk entirely.
   */
  godCwd?: string
  /**
   * Panel order and visibility. Stored opaquely: the renderer owns the shape
   * and repairs whatever it reads, so main has no second copy of those rules
   * to keep in step.
   */
  layout?: unknown
  /**
   * Light or dark. Persisted because an agent's CLI is told the same thing
   * when it spawns - the terminal chrome it draws itself has to match the
   * terminal it is drawn into.
   */
  mode?: 'light' | 'dark'
  /**
   * Where the window was last, so resizing it survives a restart. Position is
   * optional: a window saved on a monitor that is now unplugged has to fall
   * back to centred rather than open off-screen.
   */
  window?: { width: number; height: number; x?: number; y?: number; maximized?: boolean }
  /**
   * The inbound door, off unless it was turned on here.
   *
   * The token is persisted so a caller set up once keeps working across
   * restarts; rotating it is a deliberate act in the UI. Nothing else in
   * Bullpen listens for anything, which is why this is the one setting that
   * says exactly what it opens.
   */
  webhook?: { enabled: boolean; port: number; token: string }
  /**
   * Desktop notifications. On unless turned off - the whole point of a floor
   * that works while you are elsewhere is being told when it needs you.
   */
  notify?: boolean
  /**
   * How the app itself is drawn: the size text is set at in an agent's
   * terminal, and which colours the office floor is painted in.
   *
   * Kept here rather than in the workflow because it is about this machine and
   * this pair of eyes - the same floor on a different screen wants a different
   * font size, and the workflow is the thing you would hand to somebody else.
   */
  ui?: {
    fontSize?: number
    floor?: string
    /**
     * Where the boxes sit on the chart, per floor: `chart[floorName][role]`.
     *
     * Here rather than in the workflow because a position means nothing to the
     * router - it reads roles, never coordinates - and a document describing an
     * organisation should not carry one screen's idea of where the boxes are.
     * This machine's opinion about this floor lives on this machine.
     */
    chart?: Record<string, Record<string, { x: number; y: number }>>
    /** How the chart is being looked at, per floor: zoom, and the corner. */
    view?: Record<string, { k: number; tx: number; ty: number }>
    /**
     * Shipped floors the operator has taken off the list.
     *
     * A preset has no file to delete - it is in the source - so "remove" on one
     * is a note here saying not to offer it. Kept rather than actually deleted
     * because the presets are the only worked examples of the format, and a
     * fresh install should still have them.
     */
    hidden?: string[]
  }
  /**
   * The floor's shape: roles, who writes to whom, and what each is told.
   *
   * Stored opaquely, the same way `layout` is - main parses and repairs what it
   * reads, so there is no second copy of those rules here to keep in step. A
   * floor that has never chosen one runs the default chain.
   */
  workflow?: unknown
}

/** Smaller than this and the four panels have nowhere to go. */
const MIN_SIZE = 600

/** A hand-edited or stale config must not be able to open an unusable window. */
export function readWindow(raw: unknown): Config['window'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const w = raw as Record<string, unknown>
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined
  const width = num(w.width)
  const height = num(w.height)
  if (width === undefined || height === undefined) return undefined
  if (width < MIN_SIZE || height < MIN_SIZE) return undefined
  const x = num(w.x)
  const y = num(w.y)
  return {
    width,
    height,
    ...(x !== undefined && y !== undefined ? { x, y } : {}),
    ...(w.maximized === true ? { maximized: true } : {})
  }
}

export const configPath = (home: string): string => join(home, 'config.json')

export function readConfig(home: string): Config {
  try {
    const raw = JSON.parse(readFileSync(configPath(home), 'utf8')) as Config
    const out: Config = {}
    // A path written by hand can be anything; only a non-empty string is usable.
    if (typeof raw.godCwd === 'string' && raw.godCwd.trim()) out.godCwd = raw.godCwd
    if (raw.layout !== undefined) out.layout = raw.layout
    if (raw.mode === 'light' || raw.mode === 'dark') out.mode = raw.mode
    const win = readWindow(raw.window)
    if (win) out.window = win
    if (typeof raw.notify === 'boolean') out.notify = raw.notify
    // Opaque, the same way `layout` is: main parses and repairs it, and a
    // second copy of those rules here is a second place to keep in step.
    //
    // This line was missing, which is not a small thing: the applied workflow
    // was written to this file and then dropped on the way back in, so a floor
    // survived a reload and not a restart - it came back as the default chain
    // with no error anywhere, looking like the apply had never happened.
    if (raw.workflow !== undefined) out.workflow = raw.workflow
    const ui = raw.ui
    if (ui && typeof ui === 'object') {
      const size = typeof ui.fontSize === 'number' && Number.isFinite(ui.fontSize) ? ui.fontSize : undefined
      const floor = typeof ui.floor === 'string' && ui.floor.trim() ? ui.floor : undefined
      const chart = ui.chart && typeof ui.chart === 'object' ? ui.chart : undefined
      const view = ui.view && typeof ui.view === 'object' ? ui.view : undefined
      const hidden = Array.isArray(ui.hidden)
        ? ui.hidden.filter((n): n is string => typeof n === 'string' && n.trim() !== '')
        : undefined
      if (size !== undefined || floor || chart || view || hidden) {
        out.ui = {
          ...(size !== undefined ? { fontSize: size } : {}),
          ...(floor ? { floor } : {}),
          ...(chart ? { chart } : {}),
          ...(view ? { view } : {}),
          ...(hidden ? { hidden } : {})
        }
      }
    }
    const hook = raw.webhook
    if (
      hook &&
      typeof hook.token === 'string' &&
      hook.token.length >= 16 &&
      typeof hook.port === 'number' &&
      Number.isFinite(hook.port) &&
      hook.port >= 0 &&
      hook.port <= 65535
    ) {
      out.webhook = { enabled: hook.enabled === true, port: Math.floor(hook.port), token: hook.token }
    }
    return out
  } catch {
    return {}
  }
}

/** Write-then-rename: a half-written config would silently lose the setting. */
export function writeConfig(home: string, next: Config): void {
  mkdirSync(home, { recursive: true })
  const tmp = `${configPath(home)}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, configPath(home))
}

/**
 * Reject the directories that would make the sandbox meaningless, and anything
 * that is not a directory we can actually use. Returns an error string, or null.
 */
export function checkWorkspace(dir: string, home: string): string | null {
  const path = resolve(dir)
  if (path === resolve('/') || path === home) {
    return `refusing to put an agent at ${path} - pick a directory of its own`
  }
  const parent = join(path, '..')
  if (!existsSync(path) && !existsSync(parent)) return `${parent} does not exist`
  return null
}

/**
 * Fold a partial UI preference into the one on disk.
 *
 * Here rather than inline in the handler because the handler rebuilt the whole
 * `ui` object from the four fields it knew about, and `hidden` was not one of
 * them - so changing the font size, or dragging one box on the chart, silently
 * put every floor the operator had removed back on the list. Anything this does
 * not name is carried through untouched, which is the only version of this that
 * stays right when a fifth field is added.
 */
export function mergeUi(current: Config['ui'], next: NonNullable<Config['ui']>): NonNullable<Config['ui']> {
  return {
    ...current,
    ...next,
    fontSize: Math.min(24, Math.max(9, Number(next.fontSize ?? current?.fontSize ?? 12.5))),
    floor: (next.floor ?? current?.floor ?? 'green').trim() || 'green',
    // Per floor, so saving one chart does not wipe the others.
    chart: { ...(current?.chart ?? {}), ...(next.chart ?? {}) },
    view: { ...(current?.view ?? {}), ...(next.view ?? {}) }
  }
}
