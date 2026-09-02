import {
  can,
  columnFor,
  defaultCardRules,
  hasColumn,
  matches,
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
/**
 * A subject that is about work already handed over, rather than work being
 * handed over.
 *
 * Everything two agents say to each other goes down the same wire as the
 * hand-off did, and every one of those used to open a card. One task came to
 * fifty-four of them: `re:`, `answer:`, `correction:`, `question:`, `done:` -
 * a conversation, drawn on the board as if each turn of it were a new job, on
 * the one screen the operator reads to know what the floor is doing.
 *
 * Anchored on the colon rather than the word. Every brief on every floor here
 * writes `done: <what>` and `re: <what>`, so the colon is what people actually
 * type - and without it "update the pricing page" is a piece of work that
 * reads as a status line. A false negative is a card too many, which is what
 * this has always been; a false positive is work that never appears at all.
 */
export const REPLY =
  /^\s*(re|reply|answer|answered|correction|corrected|clarification|question|note|fyi|ack|update|status|done|pass|passed|fail|failed|bug|bugs|blocked|stuck|error|finished|shipped|delivered|confirmed)\s*:/i

/** Whether this subject is talk about a card rather than a new one. */
export const isReply = (subject: string): boolean => REPLY.test(subject)

/**
 * The two words a report starts with, as the board reads them.
 *
 * Every brief on every floor is handed the same sentence - start a report with
 * `done: ` when it is finished and `fail: ` when it is not - and these are what
 * that sentence is worth. `said` reads them when no rule matched, and
 * `isReport` reads them to tell an outcome from a progress line.
 *
 * Every word is spelled out with the endings people actually type. `\b` binds
 * to the end of the word it follows, so `pass\b` never matched "passed" and
 * `bug\b` never matched "bugs" - and "bugs: ..." is the subject the shipped
 * tester brief tells a tester to send its bug list under. Read as neither
 * outcome, a whole round of bugs was taken for a pass and closed the build it
 * was reporting against.
 */
export const DONE_SAID = /^\s*(done|pass|passes|passed|finished|shipped|ok)\b/i
export const FAILED_SAID =
  /^\s*(fail|fails|failed|bug|bugs|broke|broken|block|blocked|stuck|error|errors)\b/i

/**
 * Whether a subject reports an outcome at all, rather than progress.
 *
 * `report`, `update` and `status` are a floor saying where it stands, and the
 * app asks for one by name every time the floor goes quiet. Moving a card on
 * those closes work that is still being done - so a rule about a pair is
 * honoured only once somebody says which way it went.
 */
export const isReport = (subject: string): boolean =>
  DONE_SAID.test(subject) || FAILED_SAID.test(subject)

/**
 * A subject that reports a failure, as opposed to describing one.
 *
 * The same words, anchored on the colon. `said` and `testerReported` read a
 * report that has already been identified as one, and there the bare word is
 * the safer reading. `stuckInstead` is asked about *every* message a rule
 * matches - the work being handed over as well as the news coming back - and
 * "error handling for the parser" is a task somebody was given, not a task that
 * broke. The colon is what every brief on every floor actually writes.
 */
export const REPORTED_FAIL =
  /^\s*(fail|fails|failed|bug|bugs|broke|broken|block|blocked|stuck|error|errors)\s*:/i

export type CardMove =
  /** Give `agent` a new card, unless it already has that exact one. */
  | { kind: 'open'; agent: string; text: string; by: string }
  /** Move `agent`'s open card. */
  | { kind: 'move'; agent: string; status: string }
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
  // Nobody checks work here, so a builder reporting in is as far as a task
  // goes. Parking it in wait_test on such a floor leaves it there forever.
  const checked = rolesWith(w, 'checks').length > 0

  /**
   * Somebody saying they are stuck has not finished.
   *
   * A rule is about a pair and nothing else, so one line carries every message
   * between those two - and a worker reporting to whoever handed the task out
   * sends "done: ..." and "blocked: ..." down exactly the same line. The rule
   * says `done`, so both landed in the finished column: the board read as work
   * delivered while the agent behind it was waiting on an answer, which is the
   * one failure a board exists to prevent.
   *
   * `said` already knows these words - it is what moves a card on a floor that
   * wrote no rules at all - but it only runs when nothing matched. The rule
   * still decides which column work goes to; this decides that this particular
   * message was not that.
   *
   * Hoisted out of the loop body because the one line it did not cover was the
   * last one: reporting to the human returns before the loop body gets this
   * far, so a boss writing "blocked: the human has to decide this" closed its
   * own card as shipped - on the one hand-off the operator actually reads.
   *
   * Any column, not only the finished one. It asked `status === done` first,
   * which reads as "a failure must not be mistaken for delivery" and is only
   * half of it: a floor whose builder reports to its boss on a line drawn to
   * `in review` had a build that failed verify three times sitting in the
   * column that means somebody is about to check it. A `fail:` never moves a
   * card *forward*, whichever column forward happens to be called.
   *
   * Two things pay for the wider reach. The colon, because without it every
   * line also carries the work itself and "error handling for the parser" is a
   * task, not a report - the same call `isReply` makes, for the same reason.
   * And `whose`, because "checks → builds: doing (their card)" moves the card
   * of the agent being written *to*, and the sender's bad news is not a
   * statement about the reader: the developer a bug list goes back to is not
   * the one who is stuck.
   */
  const stuckInstead = (status: string, whose?: 'from' | 'to'): string | null => {
    if (whose === 'to' || !hasColumn(w, 'stuck')) return null
    if (status === columnFor(w, 'stuck')) return null
    return REPORTED_FAIL.test(msg.subject) ? columnFor(w, 'stuck') : null
  }

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
      // A pass told to the human is still a pass. `closes it` was read only on
      // the way to another agent, so a floor whose reviewer is the one that
      // decides - and reports that to the operator, because the operator is who
      // commits - wrote the rule that says so and it never fired: the reviewer's
      // own card closed on the `done:` fallback and the build it had just passed
      // stayed open forever.
      if (rule.status === 'closes') {
        return { kind: 'checked', agent: msg.from, subject: msg.subject }
      }
      const where = stuckInstead(rule.status, rule.whose) ?? rule.status
      if (!w.columns.some((c) => c.key === where)) continue
      return { kind: 'move', agent: msg.from, status: where }
    }
    if (msg.to === human) continue
    if (!matches(w, toRole, rule.to)) continue

    if (rule.status === 'open') {
      // Handing work to yourself is not a hand-off; it is the same agent still
      // holding it, and opening a second card for it says otherwise.
      if (fromRole === toRole) continue
      // Neither is answering one. The rule is about a pair, and a pair that
      // hands work over also talks about it - so the same line carried
      // "build this" and "re: your question about it", and drew both.
      // Nothing rather than a move: a `done:` or a `fail:` down this line is
      // still worth reading, and that is what the caller's fallback is for.
      if (isReply(msg.subject)) return null
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

    const held = stuckInstead(rule.status, rule.whose)
    if (held) return { kind: 'move', agent, status: held }
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
