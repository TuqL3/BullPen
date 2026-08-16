import { writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Michael - the operator's own clone. Not something you hire: he is the floor's
 * starting state, spawned on launch, and the only agent that sees everyone else.
 *
 * The id is fixed rather than slugged from a name, because dispatch, the graph
 * centre and the mail router all address him by it.
 */
export const GOD_ID = 'michael'
export const GOD_NAME = 'Michael'

export type FloorAgent = {
  id: string
  name: string
  project: string
  cwd: string
  status: string
  activity: string
  pid: number
  ctxPct?: number
  model?: string
  costUsd?: number
}

export type Floor = { updated: number; you: string; agents: FloorAgent[] }

export const godCwd = (home: string): string => join(home, GOD_ID)
export const floorPath = (home: string): string => join(home, 'floor.json')

/**
 * What Michael is told about himself, written into his workspace once.
 *
 * Written only when absent: after the first launch this file is the operator's
 * to edit, and rewriting it every start would silently discard those edits.
 */
export function writeBriefing(cwd: string, floor: string): string {
  const path = join(cwd, 'CLAUDE.md')
  if (existsSync(path)) return path
  writeFileSync(
    path,
    `# Michael

You are Michael, and you stand in for the person running this floor. When
someone addresses "the boss", that is you. You do not do the work yourself
unless it is small - you decide who does, and you say so.

## Seeing the floor

\`${floor}\` (also \`$BULLPEN_FLOOR\`) is a JSON snapshot of every agent
currently hired: id, display name, project, working directory, whether it is
idle or working, and how full its context is. It is rewritten whenever anything
changes, so read it again rather than trusting what you read a turn ago.

\`\`\`bash
cat "$BULLPEN_FLOOR"
\`\`\`

## Talking to them

\`$BULLPEN_MAILBOX/outbox/<anything>.json\` is how you write to an agent:

\`\`\`json
{ "from": "${GOD_ID}", "to": "<agent id>", "subject": "...", "body": "..." }
\`\`\`

\`"to": "*"\` reaches everyone. \`"to": "you"\` is a question for the human -
it surfaces in their ask-me queue and the answer comes back to your inbox.
Mail waiting for you is in \`$BULLPEN_MAILBOX/inbox\`.

Ask the human when the decision is theirs to make: what to build, what to
spend, anything hard to undo. Decide the rest yourself - that is the point
of you.
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
export function publishFloor(home: string, agents: FloorAgent[], now: number): boolean {
  const path = floorPath(home)
  const next: Floor = { updated: now, you: GOD_ID, agents }
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
