import type { Agent } from './store'

export type OpenFile = {
  agentId: string
  root: string
  path: string
  /** Line to jump to, when the file was opened from a search hit. */
  line?: number
  /** Where the match sits inside that line, as offsets from its first column. */
  col?: [number, number]
  text: string
  truncated: boolean
  binary: boolean
  /** Unified diff against HEAD, when the workspace is a git repository. */
  diff?: string
}

/**
 * Ask main for a file, in the form the editor panel wants it.
 *
 * Lives here rather than in either panel because the tree opens files and the
 * editor displays them, and they are separate panels the operator can put in
 * different columns.
 */
export async function openFile(
  agent: Agent,
  path: string,
  line?: number,
  col?: [number, number]
): Promise<OpenFile | string> {
  // Both at once: the panel offers file and diff side by side, and fetching the
  // diff only when that tab is clicked makes the first click feel broken.
  const [res, d] = await Promise.all([
    window.bullpen.codeRead(agent.cwd, path),
    window.bullpen.gitDiff(agent.cwd, path)
  ])
  if (res.error) return res.error
  return {
    agentId: agent.id,
    root: agent.cwd,
    path,
    line,
    col,
    text: res.text ?? '',
    truncated: !!res.truncated,
    binary: !!res.binary,
    diff: d.error ? undefined : d.text
  }
}
