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
}

export const configPath = (home: string): string => join(home, 'config.json')

export function readConfig(home: string): Config {
  try {
    const raw = JSON.parse(readFileSync(configPath(home), 'utf8')) as Config
    // A path written by hand can be anything; only a non-empty string is usable.
    return typeof raw.godCwd === 'string' && raw.godCwd.trim() ? { godCwd: raw.godCwd } : {}
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
