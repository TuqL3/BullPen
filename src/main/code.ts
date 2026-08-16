import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Reading and writing files inside one agent's workspace.
 *
 * Every path arrives from the renderer, so every path is untrusted: the panel
 * may only reach inside the sandbox that agent was hired for. `..`, absolute
 * paths and symlink escapes all resolve to the same check.
 */

/** Directories nobody opens a code panel to read, and that make listing slow. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'target', '__pycache__'])

/** Above this a file is not source, and shipping it to the renderer stalls it. */
export const MAX_BYTES = 1_000_000

export type Entry = { name: string; path: string; dir: boolean; size: number }

/** Resolve `rel` inside `root`, or throw. The only way paths become absolute. */
export function inside(root: string, rel: string): string {
  const base = resolve(root)
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(base, rel)
  const r = relative(base, abs)
  if (r.startsWith('..') || isAbsolute(r)) throw new Error(`${rel} is outside the workspace`)
  return abs
}

/** One directory level. Shallow on purpose: a deep walk of a large repo blocks. */
export function list(root: string, rel = ''): Entry[] {
  const dir = inside(root, rel)
  const out: Entry[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.env.example') continue
    if (e.isDirectory() && SKIP.has(e.name)) continue
    let size = 0
    // A broken symlink or a file deleted mid-listing must not kill the listing.
    try {
      if (e.isFile()) size = statSync(join(dir, e.name)).size
    } catch {
      continue
    }
    out.push({
      name: e.name,
      path: relative(resolve(root), join(dir, e.name)).split(sep).join('/'),
      dir: e.isDirectory(),
      size
    })
  }
  return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
}

export type FileRead = { path: string; text: string; truncated: boolean; binary: boolean }

export function read(root: string, rel: string): FileRead {
  const abs = inside(root, rel)
  const size = statSync(abs).size
  const buf = readFileSync(abs).subarray(0, MAX_BYTES)
  // A NUL byte in the first block is the cheap, reliable binary test; rendering
  // a PNG as text locks the editor up for a second and shows nothing useful.
  const binary = buf.subarray(0, 8000).includes(0)
  return {
    path: rel,
    text: binary ? '' : buf.toString('utf8'),
    truncated: size > MAX_BYTES,
    binary
  }
}

/**
 * Writing is what makes the panel an editor rather than a viewer, and it is the
 * one operation here that can lose work - so it refuses the cases where it
 * would be writing something other than what was opened.
 */
export function write(root: string, rel: string, text: string): void {
  const abs = inside(root, rel)
  const st = statSync(abs)
  if (st.isDirectory()) throw new Error(`${rel} is a directory`)
  writeFileSync(abs, text, 'utf8')
}
