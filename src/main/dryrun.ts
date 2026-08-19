import { routeCard, type CardMove } from './cards.ts'
import { columnFor, refuseMail, rolesWith, type Workflow } from './workflow.ts'

/**
 * One task, walked through a floor without spending anything.
 *
 * A workflow is prose and a routing table, and the only way to know what it
 * actually does was to run it - which means real agents, real model turns, and
 * several minutes before the first sign that the analyst was never allowed to
 * write to the tester in the first place.
 *
 * This walks the same task through the same two functions the live floor uses -
 * `refuseMail` for who may write to whom, `routeCard` for what that does to the
 * board - and reports what would happen. Nothing here calls a model, touches
 * the disk or spawns anything: it is the workflow read out loud.
 *
 * It is a typical path, not a prediction. Agents decide what to send; this
 * assumes each one does the obvious thing, which is what a floor is for.
 */
export type Step = {
  /** Role names, or the human's address. */
  from: string
  to: string
  /**
   * The same two, as somebody would say them out loud: an agent's name where
   * the role has one, and what the role is called where it does not. `dev` is
   * a key in a file; "a developer" is who is being written to.
   */
  fromName: string
  toName: string
  /** What this message is, in the operator's words. */
  says: string
  /** What it does to the board, already resolved to a column name. */
  card: string
  /** Set when the router would refuse it: the floor is broken here. */
  refused?: string
}

export type DryRun = { steps: Step[]; ends: string }

export function dryRun(w: Workflow, task: string): DryRun {
  const what = task.trim() || 'a task'
  const steps: Step[] = []

  const dispatch = w.dispatch
  const assigner = rolesWith(w, 'assigns').find((r) => r !== dispatch) ?? rolesWith(w, 'assigns')[0]
  const builder = rolesWith(w, 'builds')[0]
  const checker = rolesWith(w, 'checks')[0]
  const voice = rolesWith(w, 'speaksToHuman')[0]

  const named = (party: string): string =>
    party === w.human ? 'you' : (w.roles[party]?.fixed?.name ?? w.roles[party]?.label ?? party)

  const label = (move: CardMove): string => {
    if (!move) return ''
    if (move.kind === 'open') return `opens a card for ${named(move.agent)}`
    if (move.kind === 'checked') return `closes it, and the work it was checking`
    const column = w.columns.find((c) => c.key === move.status)
    return `${named(move.agent)}'s card → ${column?.label ?? move.status}`
  }

  /** Send one message, if this floor allows it. Returns whether it went. */
  const send = (from: string, to: string, says: string): boolean => {
    const refused = refuseMail(w, from, to)
    const move = refused ? null : routeCard(w, { from, to, subject: what, body: '' }, (id) => id, w.human)
    steps.push({
      from,
      to,
      fromName: named(from),
      toName: named(to),
      says,
      card: label(move),
      ...(refused ? { refused } : {})
    })
    return !refused
  }

  // The operator hands it over. That is not a message between roles - it is
  // typed at an agent's own terminal - so it opens a card without a rule.
  steps.push({
    from: w.human,
    to: dispatch,
    fromName: 'you',
    toName: named(dispatch),
    says: `you dispatch "${what}"`,
    card: `opens a card for ${named(dispatch)}, in ${
      w.columns.find((c) => c.key === columnFor(w, 'start'))?.label ?? 'the first column'
    }`
  })

  if (!builder) return { steps, ends: 'Nobody on this floor builds anything, so it stops here.' }

  // Down: dispatch hands to whoever assigns, who puts it on whoever builds.
  let holder = dispatch
  if (assigner && assigner !== dispatch) {
    if (!send(dispatch, assigner, `hands it to ${assigner}`)) {
      return { steps, ends: 'It cannot leave the first desk: that message is refused.' }
    }
    holder = assigner
  }
  if (holder !== builder && !send(holder, builder, `puts ${builder} on it`)) {
    return { steps, ends: 'Nobody can reach whoever does the work, so it stops there.' }
  }

  // Up: built, checked if anybody checks, and reported.
  if (checker) {
    send(builder, holder, 'says the work is built')
    send(holder, checker, `asks ${checker} to check it`)
    send(checker, builder, 'sends a problem straight back')
    send(builder, checker, 'says it is fixed')
    send(checker, holder, 'passes it')
  } else {
    send(builder, holder, 'says the work is built')
  }

  if (voice && voice !== holder) send(holder, voice, 'reports it up')
  if (voice) send(voice, w.human, `tells you where it stands`)

  const broke = steps.find((s) => s.refused)
  if (broke) {
    return {
      steps,
      ends: `One step is refused by the router, so the task stops at ${broke.fromName}.`
    }
  }
  if (!voice) return { steps, ends: 'Nobody here may write to you, so you are never told.' }
  const closes = named(checker ?? builder)
  return { steps, ends: `${closes} decides it is finished, and ${named(voice)} is who tells you.` }
}

