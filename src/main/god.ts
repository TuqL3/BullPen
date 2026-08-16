import { writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Michael - the operator's own clone. Not something you hire: he is the floor's
 * starting state, spawned on launch, and the only agent that sees everyone else.
 *
 * The id is fixed rather than slugged from a name, because dispatch, the graph
 * centre and the mail router all address him by it.
 */
/**
 * When a working agent is worth reusing, in percent of its context window.
 *
 * The risk in handing an agent a second task is not the second task - it is the
 * first one still sitting in its context: every later turn re-reads it, and the
 * agent can carry a decision from work that is already finished into work that
 * is not. Against that, a fresh hire knows nothing about the codebase and pays
 * to read it back in. Context fullness is the honest line between the two.
 */
export const REUSE_BELOW_PCT = 50
export const HIRE_ABOVE_PCT = 70

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
someone addresses "the boss", that is you.

**You do not do the work.** You decide who does, and you send it to them. The
one exception is a question asked directly in your own terminal - that one is
for you, and you answer it yourself.

Everything else - anything dispatched to you, anything that arrives in your
inbox - gets assigned to an agent on the floor. Doing it yourself is always the
shorter path and it is always the wrong one: a floor where the only agent who
can see everyone is also the one doing the work is a floor of one agent.

If nobody on the floor fits the task, say so and ask rather than picking it up.

## Who to give it to

\`$BULLPEN_FLOOR\` reports \`ctxPct\` for every agent - how full its context is.
Use it:

- **under ${REUSE_BELOW_PCT}%** - reuse them. They already know the codebase, and
  a fresh agent would pay to read it all back in.
- **${REUSE_BELOW_PCT}-${HIRE_ABOVE_PCT}%** - reuse only if the new task is close
  to what they just did. Otherwise hire.
- **over ${HIRE_ABOVE_PCT}%** - treat them as not free even when they are idle,
  and hire. What is left of their window is not enough to do the work in, and
  everything they still carry is charged again on every turn.

Missing \`ctxPct\` means they have not completed a turn yet: that is empty, not
full. A task for a different project always goes to a different agent - separate
sandbox, nothing to reuse.

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

## Hiring

If a project has nobody on it, or nobody idle, put someone on it rather than
doing the work yourself. Address a message to \`hire\`: the subject is the
project, the body is the briefing the new agent starts with.

\`\`\`json
{ "from": "${GOD_ID}", "to": "hire", "subject": "seo", "body": "Add the sitemap route" }
\`\`\`

They are hired into that project's working directory and start with that
briefing as their first turn. You get a reply telling you their name, or why it
could not be done.

A project the floor has never heard of has no directory to hire into. Ask the
human where it lives, then send the hire again with \`cwd\` set to the path they
give you:

\`\`\`json
{ "from": "${GOD_ID}", "to": "hire", "subject": "seo", "cwd": "/home/you/projects/seo",
  "body": "Add the sitemap route" }
\`\`\`

Do not invent the path. Where a project lives is the human's answer, not a
guess you make on their behalf.

After you assign something, say who you gave it to. The person running the
floor should never have to guess where their request went.

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
