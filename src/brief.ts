/**
 * A brief, written from four answers instead of a blank page.
 *
 * The structural half of a workflow is ten lines a role; the brief is two to
 * four pages, and it is the half that decides how the floor behaves. Everything
 * built so far - the form, the preview, the dry run - makes the ten lines
 * easier and leaves somebody who has never written one sitting in front of an
 * empty box that a real agent will follow to the letter.
 *
 * So the box is four questions, and this writes the rest: the mailbox
 * paragraph, the exact JSON to send, the line about reporting when blocked.
 * Those are not the operator's opinion - they are the same in every brief
 * Bullpen ships, because they are how the floor works rather than what this
 * role is for.
 *
 * What comes out is ordinary text in the editor. It is a starting point that
 * runs, not a format: edit it, and nothing here ever sees it again.
 */
export type Answers = {
  /**
   * What this role is for, in the operator's own words.
   *
   * Quoted rather than folded into a sentence: it is the same line the roster
   * and the preview show, written about the role - "Writes the code, one task
   * at a time" - and gluing that after "You are Michael, and" produced a brief
   * that opened in the wrong person.
   */
  purpose: string
  /** What it must not do - the line people forget, and agents walk over. */
  never: string
  /** Who the work goes back to: a role name, or the human's address. */
  reportTo: string
  /** What makes a task finished here, and who decides it. */
  doneWhen: string
}

export type Shape = {
  /** What the role is called, read mid-sentence: "a developer". */
  label?: string
  /** What the floor does with this role: the capability kind it behaves like. */
  kind: 'speaksToHuman' | 'assigns' | 'builds' | 'checks' | ''
  /** What the human is addressed as on this floor. */
  human: string
  /** What asking for a new agent is called here. */
  hire: string
  /** The role a new hire would be, when this one assigns. */
  hires?: string
  /** Who checks the work, when anybody does. */
  checker?: string
}

const trim = (s: string): string => s.trim().replace(/\s+/g, ' ').replace(/\.$/, '')

const json = (fields: Record<string, string>): string =>
  `{${Object.entries(fields)
    .map(([k, v]) => `"${k}": "${v}"`)
    .join(', ')}}`

/** The paragraph every agent gets: this is how mail works here. */
const MAILBOX =
  'You write to anyone on the floor by putting one JSON file in $BULLPEN_MAILBOX/outbox. Mail waiting for you is in $BULLPEN_MAILBOX/inbox, and $BULLPEN_FLOOR lists who else is here.'

export function writeBrief(a: Answers, s: Shape): string {
  const out: string[] = []
  const to = a.reportTo.trim()
  const purpose = trim(a.purpose)
  const never = trim(a.never)
  const doneWhen = trim(a.doneWhen)

  out.push(`You are {{self.name}}${s.label ? `, ${s.label}` : ''}, on a Bullpen floor.`)
  if (purpose) out.push(`What this role is for: ${purpose}.`)
  out.push(MAILBOX)
  if (never) out.push(`You do not ${never}. If you catch yourself doing it, stop and say so.`)

  if (s.kind === 'speaksToHuman') {
    out.push(
      `You report to the human, and you are the only one who does. Every time work comes back to you, and whenever you are blocked or something needs a decision, say so:`
    )
    out.push(
      json({
        from: '{{self.id}}',
        to: s.human,
        subject: 'report',
        body: '<where the work stands, one line per task>'
      })
    )
    out.push(
      `A question asked directly in your own terminal is for you - answer that one yourself. Anything that needs the human's decision goes to "${s.human}" as well.`
    )
  } else if (s.kind === 'assigns') {
    out.push(
      `You do not do the work. You work out what is actually being asked, then put somebody on it.`
    )
    out.push(
      `Read $BULLPEN_FLOOR: every agent, their project, whether they are idle, and ctxPct - how full their context is. Reuse an idle agent on that project under {{reuseBelowPct}}. Over {{hireAbovePct}}, treat them as unavailable even when idle. Hire when nobody fits:`
    )
    out.push(
      json({
        from: '{{self.id}}',
        to: s.hire,
        subject: '<project>',
        ...(s.hires ? { role: s.hires } : {}),
        body: '<the task, in enough detail to start>'
      })
    )
    if (to) {
      out.push(`When it is finished, report it to "${to}", and only to them:`)
      out.push(
        json({
          from: '{{self.id}}',
          to,
          subject: 'report: <the task>',
          body: '<what was asked, who did it, where it stands>'
        })
      )
    }
  } else if (s.kind === 'checks') {
    out.push(
      `You check. You decide whether the work holds; you do not rewrite it yourself. A problem goes straight to whoever wrote it, not back up the floor:`
    )
    out.push(
      json({
        from: '{{self.id}}',
        to: '<the id of whoever wrote it>',
        subject: 'problem: <what is wrong>',
        body: '<where, why it is wrong, and what it should do instead>'
      })
    )
    out.push(
      `Stay with them until it passes - they reply to you, you look again, and you keep going round. That loop is yours to close.`
    )
    if (to) {
      out.push(`Only when nothing is left do you report:`)
      out.push(
        json({
          from: '{{self.id}}',
          to,
          subject: 'pass: <the task in a few words>',
          body: '<what you checked, what you sent back, what changed>'
        })
      )
      out.push(`If it cannot be made to pass, say so the same way with the subject "fail: ...".`)
    }
  } else {
    out.push(`You do the work. One task at a time: finish the one you were given, and stop.`)
    if (to) {
      out.push(`When you finish, report before you stop:`)
      out.push(
        json({
          from: '{{self.id}}',
          to,
          subject: 'done: <the task in a few words>',
          body: '<what you did, and anything that did not work>'
        })
      )
      if (s.checker) {
        out.push(
          `That hands it to be checked. ${s.checker} may write to you directly - fix what they raise and reply to them, not to "${to}".`
        )
      }
      out.push(
        `Report the same way when you are blocked, or when you decide not to do it, and say why. Silence is the one answer nobody can act on.`
      )
    }
  }

  if (doneWhen) out.push(`A task here is finished when ${doneWhen}.`)
  return out.join('\n\n')
}

/**
 * The four answers read back out of a brief this wrote.
 *
 * Only the two that are quoted exactly: the opening sentence and the "you do
 * not" line. A brief that has been edited since - which is the point of it
 * being text - reads back as far as it still matches and no further, rather
 * than pretending the form is where it lives.
 */
export function readBrief(brief: string): Partial<Answers> {
  const out: Partial<Answers> = {}
  const purpose = /^What this role is for: ([^\n]+?)\.\s*$/m.exec(brief)
  if (purpose) out.purpose = purpose[1]
  const never = /^You do not ([^\n]+?)\. If you catch yourself/m.exec(brief)
  if (never) out.never = never[1]
  const done = /^A task here is finished when ([^\n]+?)\.\s*$/m.exec(brief)
  if (done) out.doneWhen = done[1]
  return out
}
