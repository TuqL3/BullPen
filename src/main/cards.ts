import { can, rolesWith, type Workflow } from './workflow.ts'

/**
 * What one message does to the board.
 *
 * Pulled out of the router as a pure function because this is what the operator
 * watches. Every branch here was a real failure first: a card that never opened,
 * one that never closed, one that read as live work while the agent behind it
 * had exited. None of them show up as an error - they show up as a board that
 * quietly disagrees with the floor, which is worse than no board.
 *
 * Read as capabilities, not names: "a builder reported to whoever assigns it"
 * moves a card the same way whether the roles are called dev/analyst or
 * engineer/lead.
 */
export type CardMove =
  /** Give `agent` a new card, unless it already has that exact one. */
  | { kind: 'open'; agent: string; text: string; by: string }
  /** Move `agent`'s open card. */
  | { kind: 'move'; agent: string; status: 'todo' | 'doing' | 'wait_test' | 'blocked' | 'done' }
  /** A checker has spoken: close its own card and the work it was checking. */
  | { kind: 'checked'; agent: string; subject: string }
  | null

export function routeCard(
  w: Workflow,
  msg: { from: string; to: string; subject: string; body: string },
  roleOf: (id: string) => string,
  /** The human's address, which is not an agent. */
  human: string
): CardMove {
  const fromRole = roleOf(msg.from)
  const toRole = roleOf(msg.to)
  const is = (role: string, cap: Parameters<typeof can>[2]): boolean => can(w, role, cap)

  // Reaching the operator is the last step of anything on this floor.
  if (msg.to === human) {
    return is(fromRole, 'speaksToHuman') ? { kind: 'move', agent: msg.from, status: 'done' } : null
  }

  const hands = is(fromRole, 'assigns') || is(fromRole, 'speaksToHuman')
  // Anyone who is not the floor's voice can be given work - including whoever
  // assigns it onward. A request handed to the analyst is a thing she now owns,
  // and it was invisible: her board was empty by construction while she was the
  // busiest agent on the floor.
  const staff = !is(toRole, 'speaksToHuman')
  // Nobody checks work here, so a builder reporting in is as far as a task
  // goes. Parking it in wait_test on such a floor leaves it there forever.
  const checked = rolesWith(w, 'checks').length > 0

  if (hands && staff && fromRole !== toRole) {
    return {
      kind: 'open',
      agent: msg.to,
      text: [msg.subject, msg.body].filter(Boolean).join(' — '),
      by: msg.from
    }
  }
  if (is(fromRole, 'builds') && is(toRole, 'assigns')) {
    return { kind: 'move', agent: msg.from, status: checked ? 'wait_test' : 'done' }
  }
  // A problem went straight back to whoever wrote it; that is work again.
  if (is(fromRole, 'checks') && is(toRole, 'builds')) {
    return { kind: 'move', agent: msg.to, status: 'doing' }
  }
  // "Fixed, look again" - back in front of the checker, not the assigner.
  // Without this the card sat in doing for the rest of the loop and the pass at
  // the end closed nothing.
  if (is(fromRole, 'builds') && is(toRole, 'checks')) {
    return { kind: 'move', agent: msg.from, status: 'wait_test' }
  }
  if (is(fromRole, 'checks') && is(toRole, 'assigns')) {
    return { kind: 'checked', agent: msg.from, subject: msg.subject }
  }
  // Reporting up is what finishing looks like for whoever assigns: the work came
  // in, went out, came back checked, and has been passed on.
  if (is(fromRole, 'assigns') && is(toRole, 'speaksToHuman')) {
    return { kind: 'move', agent: msg.from, status: 'done' }
  }
  return null
}
