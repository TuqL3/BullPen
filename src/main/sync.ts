import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configPath, readConfig, writeConfig, type Config } from './config.ts'

/**
 * The same floors on the other machine.
 *
 * Two things live in `~/.bullpen`: the floors, which are text about how work
 * moves and mean the same thing anywhere, and everything else, which is about
 * this machine - where Michael's workspace is, how big the window was, which
 * port the webhook listens on. Sending the second across is how an agent ends
 * up spawned into a directory that does not exist on the machine it woke up in,
 * so the split is the feature and the transport is a detail.
 *
 * Last write wins, by the clock on whichever machine pressed save. Not because
 * it is the right answer to two people editing one floor - it is not, it loses
 * one of them - but because it is the answer that can be explained in a
 * sentence, and a merge nobody asked for is worse than a loss they can see.
 */

/** Every floor, by file name. */
export type Floors = Record<string, string>

export type Bundle = {
  /** When the machine that wrote this last changed anything, in ms. */
  at: number
  /** Which machine wrote it, so the other one can say whose version won. */
  from: string
  floors: Floors
  shared: Shared
}

/**
 * The settings that mean the same thing on any machine.
 *
 * Everything not named here stays where it is: `godCwd` and the project paths
 * are this disk's, `window`, `layout` and `ui.view` are this screen's,
 * `webhook.token` is a secret with no business in a gist, and `workflow` - the
 * floor being run right now - is deliberately left out. Syncing that would
 * switch the floor under agents already standing on the other machine, and
 * nobody pressing "sync" is asking for that.
 */
export type Shared = {
  mode?: Config['mode']
  notify?: Config['notify']
  ui?: Pick<NonNullable<Config['ui']>, 'fontSize' | 'floor' | 'chart'>
}

export const sharedOf = (c: Config): Shared => ({
  ...(c.mode ? { mode: c.mode } : {}),
  ...(typeof c.notify === 'boolean' ? { notify: c.notify } : {}),
  ...(c.ui
    ? {
        ui: {
          ...(c.ui.fontSize !== undefined ? { fontSize: c.ui.fontSize } : {}),
          ...(c.ui.floor ? { floor: c.ui.floor } : {}),
          ...(c.ui.chart ? { chart: c.ui.chart } : {})
        }
      }
    : {})
})

/**
 * The shared half folded back in, with this machine's half untouched.
 *
 * `ui` is merged rather than replaced: `view` is where this screen was last
 * looking, it is not in the bundle at all, and replacing the object would take
 * it away on every pull.
 */
export const withShared = (c: Config, s: Shared): Config => ({
  ...c,
  ...(s.mode ? { mode: s.mode } : {}),
  ...(typeof s.notify === 'boolean' ? { notify: s.notify } : {}),
  ...(s.ui ? { ui: { ...c.ui, ...s.ui } } : {})
})

/** Where the floors are, made if it is not there yet. */
const floorDir = (home: string): string => {
  const dir = join(home, 'workflows')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** A file name that is a floor and nothing else. Names come off the wire. */
const isFloorFile = (name: string): boolean => /^[\w-]+\.md$/.test(name)

/** When a file last changed, or 0 when it is not there. */
const changedAt = (path: string): number => {
  try {
    return Math.round(statSync(path).mtimeMs)
  } catch {
    return 0
  }
}

/** Every floor on this machine, by file name. */
export function readFloors(home: string): Floors {
  const dir = floorDir(home)
  const out: Floors = {}
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue
    out[f] = readFileSync(join(dir, f), 'utf8')
  }
  return out
}

/**
 * What this machine would send.
 *
 * `at` is the newest thing it has: a floor written a minute ago beats a config
 * touched last week, and a machine that has changed nothing since the last sync
 * sends the same number it received - which is what stops an idle laptop from
 * winning over the one somebody is actually working on.
 */
export function bundle(home: string, from: string): Bundle {
  const dir = floorDir(home)
  const times = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => changedAt(join(dir, f)))
  return {
    at: Math.max(0, changedAt(configPath(home)), ...times),
    from,
    floors: readFloors(home),
    shared: sharedOf(readConfig(home))
  }
}

/**
 * Which of the two is the one to keep.
 *
 * Ties go to what is already here: pulling a bundle written in the same
 * millisecond and rewriting every floor with an identical copy is work that can
 * only be wrong.
 */
export const newer = (here: Bundle, there: Bundle): 'here' | 'there' =>
  there.at > here.at ? 'there' : 'here'

/**
 * Take the other machine's version.
 *
 * Floors are replaced wholesale, the ones this machine has and the bundle does
 * not included - "last write wins" is about the whole set, or a floor deleted
 * on one machine would never go away on the other. Config keeps every key this
 * bundle says nothing about.
 */
export function adopt(home: string, b: Bundle): { floors: number; dropped: string[] } {
  const dir = floorDir(home)
  const dropped: string[] = []
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.md') && !(f in b.floors)) {
      rmSync(join(dir, f))
      dropped.push(f)
    }
  }
  let floors = 0
  for (const [name, text] of Object.entries(b.floors)) {
    // A floor called `../../.ssh/authorized_keys` is a write anywhere on the
    // disk, and this text arrived over the network.
    if (!isFloorFile(name) || typeof text !== 'string') continue
    writeFileSync(join(dir, name), text, 'utf8')
    floors++
  }
  writeConfig(home, withShared(readConfig(home), b.shared))
  return { floors, dropped }
}

/** Whether what came back over the wire is a bundle at all. */
export function isBundle(raw: unknown): raw is Bundle {
  if (!raw || typeof raw !== 'object') return false
  const b = raw as Record<string, unknown>
  if (typeof b.at !== 'number' || !Number.isFinite(b.at)) return false
  if (typeof b.from !== 'string') return false
  if (!b.floors || typeof b.floors !== 'object') return false
  if (!b.shared || typeof b.shared !== 'object') return false
  return Object.values(b.floors as Record<string, unknown>).every((v) => typeof v === 'string')
}
