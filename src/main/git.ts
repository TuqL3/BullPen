import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { inside } from './code.ts'

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
