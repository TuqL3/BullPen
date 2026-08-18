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
