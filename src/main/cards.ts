import {
  can,
  columnFor,
  defaultCardRules,
  hasCapability,
  hasColumn,
  rolesWith,
  type Workflow
} from './workflow.ts'

/**
 * What one message does to the board.
 *
 * Pulled out of the router as a pure function because this is what the operator
 * watches. Every branch here was a real failure first: a card that never opened,
 * one that never closed, one that read as live work while the agent behind it
 * had exited. None of them show up as an error - they show up as a board that
 * quietly disagrees with the floor, which is worse than no board.
 *
 * The branches are gone. They were the same list read in the one order that
 * mattered, so the list is `w.cardRules` and this walks it - which is what lets
 * a floor of writers say `drafts → edits: in review` and have it mean something,
 * rather than having to call its editor a tester to get the card to move.
 */
export type CardMove =
  /** Give `agent` a new card, unless it already has that exact one. */
  | { kind: 'open'; agent: string; text: string; by: string }
  /** Move `agent`'s open card. */
  | { kind: 'move'; agent: string; status: string }
  /** A checker has spoken: close its own card and the work it was checking. */
  | { kind: 'checked'; agent: string; subject: string }
  | null

/**
 * Whether `role` answers to a word in a rule.
 *
 * Four things a rule may name, in the order somebody writing one would expect:
 * the role itself, a capability by the name this floor gave it, one of the four
 * kinds, and the two crowds - `anyone`, and `staff` for anyone who is not the
 * floor's voice.
 */
function matches(w: Workflow, role: string, word: string): boolean {
  if (word === 'anyone') return true
  if (word === 'staff') return !can(w, role, 'speaksToHuman')
  if (word === role) return true
  // By the name the floor gave it, and nothing else. A rule that said `builds`
  // used to match twice - once as a capability, once as a category the app
  // inferred - and the second reading swept in whoever the app had decided was
  // a builder, which on a floor where the tester is also hireable was both.
  return hasCapability(w, role, word)
}

export function routeCard(
  w: Workflow,
  msg: { from: string; to: string; subject: string; body: string },
  roleOf: (id: string) => string,
  /** The human's address, which is not an agent. */
  human: string
): CardMove {
  const fromRole = roleOf(msg.from)
  const toRole = roleOf(msg.to)
  // Nobody checks work here, so a builder reporting in is as far as a task
  // goes. Parking it in wait_test on such a floor leaves it there forever.
  const checked = rolesWith(w, 'checks').length > 0

  // What the floor wrote, or - when it wrote nothing - what the roles and the
  // board already imply. A drawing with boxes and arrows on it moves cards
  // without anybody writing a rule; writing one takes over completely.
  for (const rule of defaultCardRules(w)) {
    // The operator is a party to the floor without being an agent on it: they
    // hand work over and they are reported to. Their side of a rule is matched
    // by address, because they have no role to match by - and a rule about
    // anybody else must not fire on something they sent.
    if (rule.from === human ? msg.from !== human : msg.from === human) continue
    if (rule.from !== human && !matches(w, fromRole, rule.from)) continue

    // Reaching the operator is the last step of anything on this floor, and the
    // human is not an agent - no role to match, and no card of their own.
    if (rule.to === human) {
      if (msg.to !== human) continue
      if (!w.columns.some((c) => c.key === rule.status)) continue
      return { kind: 'move', agent: msg.from, status: rule.status }
    }
    if (msg.to === human) continue
    if (!matches(w, toRole, rule.to)) continue

    if (rule.status === 'open') {
      // Handing work to yourself is not a hand-off; it is the same agent still
      // holding it, and opening a second card for it says otherwise.
      if (fromRole === toRole) continue
      return {
        kind: 'open',
        agent: msg.to,
        text: [msg.subject, msg.body].filter(Boolean).join(' — '),
        by: msg.from
      }
    }
    if (rule.status === 'closes') return { kind: 'checked', agent: msg.from, subject: msg.subject }
    // Whose card the line moves: the sender's, or the one being written to.
    const agent = rule.whose === 'to' ? msg.to : msg.from
    // The one place a rule is overruled: the column work waits in to be
    // checked is not somewhere to leave a card on a floor where nobody checks.
    if (hasColumn(w, 'waiting') && rule.status === columnFor(w, 'waiting') && !checked) {
      return { kind: 'move', agent, status: columnFor(w, 'done') }
    }
    if (!w.columns.some((c) => c.key === rule.status)) continue
    return { kind: 'move', agent, status: rule.status }
  }
  return null
}
