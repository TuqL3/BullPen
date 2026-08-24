import { writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixedId, renderBrief, type Workflow } from './workflow.ts'

/**
 * What the floor is shaped like - who exists, who writes to whom, what each of
 * them is told - moved to `workflow.ts` and `presets.ts`, because it is the
 * operator's to change and a `Role` union in a source file is not.
 *
 * What is left here is the part that is the same on any floor: the snapshot
 * agents read to see each other, and the file the dispatch agent is given to
 * describe itself.
 */

export type FloorAgent = {
  id: string
  name: string
  project: string
  cwd: string
  status: string
  activity: string
  /** What they are for: a role name from the running workflow. */
  role?: string
  pid: number
  ctxPct?: number
  model?: string
  costUsd?: number
}

export type Floor = { updated: number; you: string; agents: FloorAgent[] }

/**
 * One card, as an agent reads it.
 *
 * A projection, not the store. `board.json` also holds the schedules and the
 * context rules, which are the operator's machinery and say nothing about the
 * work - publishing the file itself would put two things nobody on the floor
 * can act on in front of everybody who reads it.
 */
export type BoardTask = {
  id: string
  text: string
  status: string
  /** Who holds it. Empty means nobody has taken it yet. */
  agent: string
  /** What kind of agent it is work for, when it was opened for a role. */
  role?: string
  /** Who handed it over, and who is waiting on it. */
  by?: string
  /** The card this one is a check of, when it is one. */
  checks?: string
  createdAt: number
}

export type BoardView = { updated: number; columns: string[]; tasks: BoardTask[] }

export const tasksPath = (home: string): string => join(home, 'tasks.json')

/**
 * Publish the task list where agents can read it.
 *
 * Same shape as `publishFloor` and for the same reasons: write-then-rename, so
 * nobody reads half a file, and skipped when nothing changed, so a floor that
 * is thinking rather than moving does not rewrite this every second.
 *
 * Read-only from the agents' side. Everything that changes a card goes through
 * the router, where the floor's own rules are - a list agents wrote to directly
 * would be two agents claiming one card on a good day, and a way around
 * `talksTo` on a bad one.
 */
export function publishTasks(home: string, view: BoardView): boolean {
  const path = tasksPath(home)
  if (existsSync(path)) {
    try {
      const prev = JSON.parse(readFileSync(path, 'utf8')) as BoardView
      if (JSON.stringify(prev.tasks) === JSON.stringify(view.tasks)) return false
    } catch {
      // Unreadable or truncated - fall through and replace it.
    }
  }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(view, null, 2), 'utf8')
  renameSync(tmp, path)
  return true
}

/** Where the dispatch agent works. Named for its id, so two workflows with
 *  different bosses do not share one directory. */
export const godCwd = (home: string, id: string): string => join(home, id)
export const floorPath = (home: string): string => join(home, 'floor.json')

/**
 * What the dispatch agent is told about itself, written into its workspace once.
 *
 * Generated from the running workflow rather than written out here: the two
 * used to say the same thing in two places, and a floor running anything but
 * the default chain would have been handed a file describing a floor it is not
 * on. The brief is the source; this file is that brief plus how to read the
 * roster.
 *
 * Written only when absent: after the first launch this file is the operator's
 * to edit, and rewriting it every start would silently discard those edits.
 */
export function writeBriefing(cwd: string, floor: string, w: Workflow, file = 'CLAUDE.md'): string {
  const path = join(cwd, file)
  if (existsSync(path)) return path
  const role = w.roles[w.dispatch]
  const id = fixedId(w, w.dispatch) ?? w.dispatch
  const name = role?.fixed?.name ?? id
  writeFileSync(
    path,
    `# ${name}

${renderBrief(w, w.dispatch, { id, name })}

## Seeing the floor

\`${floor}\` (also \`$BULLPEN_FLOOR\`) is a JSON snapshot of every agent
currently hired: id, display name, role, project, working directory, whether it
is idle or working, and how full its context is. It is rewritten whenever
anything changes, so read it again rather than trusting what you read a turn
ago.

\`\`\`bash
cat "$BULLPEN_FLOOR"
\`\`\`

## Mail

You write to anyone on the floor by putting one JSON file in
\`$BULLPEN_MAILBOX/outbox/<anything>.json\`:

\`\`\`json
{ "from": "${id}", "to": "<agent id>", "subject": "...", "body": "..." }
\`\`\`

\`"to": "you"\` is a question for the human - it surfaces in their ask-me queue
and the answer comes back to your inbox. Mail waiting for you is in
\`$BULLPEN_MAILBOX/inbox\`.

This floor runs the "${w.name}" workflow. Who you may write to is enforced by
the router, not by this file: a message that does not belong is handed back to
you with somewhere else to send it.
`,
    'utf8'
  )
  return path
}

/**
 * Publish the roster where agents can read it.
 *
 * Write-then-rename, because an agent reading halfway through a write gets
 * truncated JSON and no error. Unchanged snapshots are skipped so an idle floor
 * does not rewrite the file every second.
 */
export function publishFloor(
  home: string,
  agents: FloorAgent[],
  now: number,
  you: string
): boolean {
  const path = floorPath(home)
  const next: Floor = { updated: now, you, agents }
  if (existsSync(path)) {
    try {
      const prev = JSON.parse(readFileSync(path, 'utf8')) as Floor
      if (JSON.stringify(prev.agents) === JSON.stringify(agents)) return false
    } catch {
      // Unreadable or truncated - fall through and replace it.
    }
  }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, path)
  return true
}

/**
 * A hired agent's brief, as a file in its own workspace.
 *
 * `claude` is handed it as `--append-system-prompt`, where nobody can see it
 * and nobody can correct it. Every other CLI is handed nothing at all - those
 * flags are claude's - so for them this is the brief: a real markdown file, in
 * the directory they were started in, under the name that CLI already reads.
 *
 * Written only when absent, for the same reason `writeBriefing` is: once it is
 * on disk it is the operator's, and rewriting it on every restart would be
 * Bullpen quietly undoing an edit somebody made on purpose.
 *
 * Returns the path when it wrote one, null when a file was already there.
 */
export function dropBrief(cwd: string, file: string, title: string, brief: string): string | null {
  const path = join(cwd, file)
  if (existsSync(path)) return null
  writeFileSync(path, `# ${title}\n\n${brief}\n`)
  return path
}
