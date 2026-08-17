import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { inside } from './code.ts'
import { blockPatch, blocks, parseDiff } from '../diff.ts'

const run = promisify(execFile)

/**
 * What has changed in an agent's workspace, according to git.
 *
 * The PostToolUse hook already reports what an agent wrote this session, but
 * that is not the same question: it misses everything changed before Bullpen
 * started, everything a Bash command touched, and it says nothing about what
 * the change actually was. git answers all three.
 *
 * Arguments are passed as an argv array, never a shell string - a path from the
 * renderer must not be able to become part of a command.
 */
const MAX_DIFF = 400_000

export type Change = {
  path: string
  /** Two-letter porcelain code, e.g. ` M`, `A `, `??`, `R `. */
  code: string
  staged: boolean
  untracked: boolean
}

export type Changes = { repo: boolean; changes: Change[]; branch?: string; error?: string }

const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

/**
 * The same, for a command that reads a patch on stdin.
 *
 * Spawned rather than execFile'd: execFile has no way to write to the child, so
 * `git apply -` sat waiting for input that never came and the call hung.
 */
const gitStdin = (cwd: string, args: string[], input: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `git ${args[0]} exited ${code}`))
    )
    child.stdin.end(input)
  })

export async function isRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch {
    return false
  }
}

/**
 * `--porcelain=v1 -z` because it is the documented stable format and NUL
 * separation is the only way a path containing a newline or a quote survives.
 */
export async function changes(cwd: string): Promise<Changes> {
  if (!(await isRepo(cwd))) return { repo: false, changes: [] }
  try {
    const [raw, branch] = await Promise.all([
      git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')
    ])
    const out: Change[] = []
    const parts = raw.split('\0')
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]
      if (entry.length < 4) continue
      const code = entry.slice(0, 2)
      const path = entry.slice(3)
      // A rename is reported as `R  new\0old`, so the following field is the
      // old name and is not a change of its own.
      if (code[0] === 'R' || code[0] === 'C') i++
      out.push({
        path,
        code,
        staged: code[0] !== ' ' && code[0] !== '?',
        untracked: code === '??'
      })
    }
    out.sort((a, b) => a.path.localeCompare(b.path))
    return { repo: true, changes: out, branch: branch.trim() || undefined }
  } catch (err) {
    return { repo: true, changes: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The unified diff for one path: worktree and index together, so a partially
 * staged file shows everything that differs from HEAD rather than half of it.
 *
 * An untracked file has nothing to diff against, so it is rendered as an
 * all-added patch - the alternative is an empty panel for the case that matters
 * most, a file the agent just created.
 */
export async function diff(cwd: string, rel: string): Promise<{ text: string; error?: string }> {
  try {
    // Throws if the path escapes the workspace; the renderer never picks the cwd.
    inside(cwd, rel)
    if (!(await isRepo(cwd))) return { text: '', error: 'not a git repository' }

    const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', rel])
      .then(() => true)
      .catch(() => false)

    const text = tracked
      ? await git(cwd, ['diff', 'HEAD', '--', rel]).catch(() => git(cwd, ['diff', '--', rel]))
      : await git(cwd, ['diff', '--no-index', '--', '/dev/null', rel]).catch((e) =>
          // --no-index exits 1 when the files differ, which is the normal case.
          typeof e?.stdout === 'string' ? e.stdout : ''
        )

    if (text.length > MAX_DIFF) {
      return { text: text.slice(0, MAX_DIFF), error: 'diff truncated at 400 KB' }
    }
    return { text }
  } catch (err) {
    return { text: '', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * How many lines each tracked file has added and deleted, in one call.
 *
 * A cheap way to notice that a file's content moved: re-reading every open
 * diff on a timer is one `git diff` per file per tick, and comparing counts is
 * one `git diff --numstat` for the whole workspace.
 */
export async function stats(cwd: string): Promise<Record<string, string>> {
  try {
    if (!(await isRepo(cwd))) return {}
    const raw = await git(cwd, ['diff', 'HEAD', '--numstat', '-z'])
    const out: Record<string, string> = {}
    // -z: `adds\tdels\t\0path\0`, and a rename adds two more NUL fields.
    const parts = raw.split('\0')
    for (let i = 0; i < parts.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i])
      if (!m) continue
      const path = m[3] || parts[++i] || ''
      if (path) out[path] = `${m[1]}-${m[2]}`
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Throw away the changes to one path.
 *
 * Irreversible, and two different operations wearing one name: a tracked file
 * goes back to HEAD, an untracked one is deleted. Nothing here can recover
 * either, so the caller is expected to have asked a human first - main only
 * refuses what it can prove is wrong.
 */
export async function discard(cwd: string, rel: string): Promise<{ ok?: true; error?: string }> {
  try {
    // Throws if the path escapes the workspace; the renderer never picks the cwd.
    inside(cwd, rel)
    if (!(await isRepo(cwd))) return { error: 'not a git repository' }

    const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', rel])
      .then(() => true)
      .catch(() => false)

    if (!tracked) {
      // -f because git refuses to delete without it, and never -x: an ignored
      // file is not a change under review and must not be swept up with one.
      await git(cwd, ['clean', '-f', '--', rel])
      return { ok: true }
    }

    // Staged and unstaged together: restoring only the worktree on a staged
    // file leaves the change sitting in the index, which reads as "discarded"
    // in the panel and commits anyway.
    await git(cwd, ['restore', '--staged', '--worktree', '--', rel]).catch(async () => {
      // git older than 2.23 has no `restore`.
      await git(cwd, ['reset', '-q', 'HEAD', '--', rel]).catch(() => '')
      await git(cwd, ['checkout', '--', rel])
    })
    return { ok: true }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Throw away one block of changed lines, leaving everything else alone.
 *
 * A block is a run of touching +/- lines. Git's hunks are wider than that - it
 * merges anything less than six lines apart - so reverting a hunk on a file
 * whose edits are close together throws away the lot, which is exactly what it
 * looked like when it happened.
 *
 * The diff is re-read here rather than taken from the panel: the panel's copy
 * can be seconds old, and a patch built on stale text lands on the wrong lines.
 * `marker` is the `@@` line the panel showed, and nothing is applied unless the
 * hunk at that index still starts with it.
 */
export async function discardBlock(
  cwd: string,
  rel: string,
  hunkIndex: number,
  blockIndex: number,
  marker: string
): Promise<{ ok?: true; error?: string }> {
  try {
    inside(cwd, rel)
    if (!(await isRepo(cwd))) return { error: 'not a git repository' }
    const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', rel])
      .then(() => true)
      .catch(() => false)
    if (!tracked) return { error: 'this file is not tracked - discard it whole, or delete it' }

    const parsed = parseDiff(await git(cwd, ['diff', 'HEAD', '--', rel]))
    const hunk = parsed.hunks[hunkIndex]
    if (!hunk) return { error: 'that block is gone - the file changed' }
    if (hunk.marker !== marker) return { error: 'the file changed under the panel - reopen it' }

    const inHunk = blocks(parsed).filter((b) => b.hunk === hunkIndex)
    const block = inHunk[blockIndex]
    if (!block) return { error: 'that block is gone - the file changed' }

    const patch = blockPatch(parsed, block, rel)
    if (!patch) return { error: 'nothing to revert in that block' }

    // Applied forwards, because the patch is written against the file as it is.
    // --index keeps a staged copy in step; worktree-only is the fallback when
    // the index holds something the patch cannot be applied to.
    await gitStdin(cwd, ['apply', '--index', '--unidiff-zero', '-'], patch).catch(() =>
      gitStdin(cwd, ['apply', '--unidiff-zero', '-'], patch)
    )
    return { ok: true }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Throw away one hunk, leaving the rest of the file's changes alone.
 *
 * A file is rarely one change. Discarding all of it to get rid of one wrong
 * edit is why people copy the good parts out to a scratch file first.
 *
 * The patch is rebuilt here from a fresh `git diff` rather than sent in from
 * the renderer: the panel's copy can be seconds old, and a patch built from
 * stale text applies cleanly to the wrong lines. `marker` is the `@@` line the
 * panel showed - if the hunk at that index no longer starts with it, the file
 * moved under the panel and nothing is reverted.
 */
export async function discardHunk(
  cwd: string,
  rel: string,
  index: number,
  marker: string
): Promise<{ ok?: true; error?: string }> {
  try {
    inside(cwd, rel)
    if (!(await isRepo(cwd))) return { error: 'not a git repository' }

    const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', rel])
      .then(() => true)
      .catch(() => false)
    if (!tracked) return { error: 'this file is not tracked - discard it whole, or delete it' }

    const text = await git(cwd, ['diff', 'HEAD', '--', rel])
    const at = text.indexOf('\n@@')
    if (at === -1) return { error: 'nothing to discard' }
    const header = text.slice(0, at + 1)
    const hunks = text
      .slice(at + 1)
      .split(/\n(?=@@ )/)
      .map((h) => (h.endsWith('\n') ? h : h + '\n'))

    const hunk = hunks[index]
    if (!hunk) return { error: 'that hunk is gone - the file changed' }
    if (!hunk.startsWith(marker)) return { error: 'the file changed under the panel - reopen it' }

    // --index reverses the change in the index as well, so a partially staged
    // file does not keep the discarded hunk staged and commit it anyway. It
    // needs the patch to apply to both; worktree-only is the fallback.
    const patch = header + hunk
    await gitStdin(cwd, ['apply', '--reverse', '--index', '-'], patch).catch(() =>
      gitStdin(cwd, ['apply', '--reverse', '-'], patch)
    )
    return { ok: true }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
