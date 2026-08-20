import type { WorkflowInfo } from '../../preload/index'

/**
 * The floor's shape, as the renderer reads it.
 *
 * Main enforces the workflow - who may write to whom, what a message does to
 * the board - and the UI has to agree with it without holding a second copy of
 * the same opinion. It used to hold one: `role === 'god'` put an agent at the
 * centre of the graph, `role === 'ba'` hid a project column, and a wizard step
 * said "reports to Iris" out loud. All of that is one workflow's answer written
 * into the source, so a floor running any other one was described wrongly by
 * its own UI.
 *
 * So the questions the UI asks - who sits in the corner office, who cannot be
 * fired, who is work handed to, does anybody check it - are answered from the
 * running workflow. Module state rather than context: it is set once at
 * startup and again when a workflow is applied, and everything from a canvas
 * frame to a zustand action needs it without threading a prop through.
 */
let wf: WorkflowInfo | null = null

export const setShape = (w: WorkflowInfo | null): void => {
  wf = w
}

export const shape = (): WorkflowInfo | null => wf

/** Whether a role answers to a word: its own name, or a capability it holds. */
const holds = (w: WorkflowInfo | null, role: string, word: string): boolean =>
  word === role || (w?.roles[role]?.can ?? []).includes(word)

/**
 * The four questions the UI asks about a floor, answered the way main answers
 * them: from what the workflow already says.
 *
 * Capabilities used to carry a label saying which of four things the app should
 * treat them as. It was a second copy of what `talks to` and the card rules
 * already said, and a floor could contradict itself between them.
 */
/**
 * The same four questions, asked of a floor that is not the running one.
 *
 * The canvas needs them about the drawing in front of somebody, which is a
 * different floor from the one the app is on until they press save - and
 * answering them twice, once here and once there, is how the drawing comes to
 * disagree with what it will become.
 */
export const rolesWithIn = (w: WorkflowInfo | null, kind: string): string[] => {
  const names = Object.keys(w?.roles ?? {})
  // The rules when there are any, and what each word was declared to behave
  // like when there are none - the same fallback main uses, and for the same
  // reason: both answers come from the rules, so a floor with none could not be
  // asked either of them.
  const declared = (kind: string): string[] =>
    names.filter((r) =>
      (w?.roles[r]?.can ?? []).some(
        (c) => (w?.capabilities ?? []).find((d) => d.name === c)?.kind === kind
      )
    )

  // Both, not one or the other: a floor can write rules and still never write a
  // `closes` one, and taking the rules as the whole answer said nobody here
  // decides anything passes while the file declared a capability `(checks)`.
  const fromRules = (status: string): string[] => {
    const kind = status === 'open' ? 'assigns' : 'checks'
    const written = (w?.cardRules ?? []).length
      ? names.filter((r) =>
          (w?.cardRules ?? []).some((rule) => rule.status === status && holds(w, r, rule.from))
        )
      : []
    return [...new Set([...written, ...declared(kind)])]
  }

  if (kind === 'speaksToHuman') {
    if (w?.voice && w.roles[w.voice]) return [w.voice]
    return names.filter((r) => (w?.talksTo[r] ?? []).includes(w?.human ?? 'you'))
  }
  if (kind === 'assigns') return fromRules('open')
  if (kind === 'checks') return fromRules('closes')

  // Said outright when a capability declares itself `(builds)`. The other three
  // are read off the lines and the rules, and this was whatever they did not
  // claim - so an analyst holding a word of its own counted as a builder.
  const builders = declared('builds')
  if (builders.length) return builders

  if (w?.hires && w.roles[w.hires]) return [w.hires]
  const taken = new Set([
    ...rolesWithIn(w, 'speaksToHuman'),
    ...rolesWithIn(w, 'assigns'),
    ...rolesWithIn(w, 'checks')
  ])
  const rest = names.filter((r) => !taken.has(r))
  return rest.length ? rest : names.filter((r) => w?.roles[r].hireable)
}

export const rolesWith = (kind: string): string[] => rolesWithIn(wf, kind)

/**
 * The word this floor uses for the work itself.
 *
 * A capability is whatever the floor called it - `nghien-cuu`, `viet-kich-ban`
 * - so "what does a new box do" cannot be answered from a list in the source.
 * It is answered by asking who already does the work here and taking their
 * word for it.
 */
/**
 * The four words a floor gets when it declares none of its own.
 *
 * The same four main ships, written again here rather than imported: main is
 * node - fs, child_process, the pty - and pulling `workflow.ts` into the window
 * pulls all of it. Four names and what each behaves like is a smaller thing to
 * keep in step than that.
 */
export const HOUSE_CAPABILITIES: WorkflowInfo['capabilities'] = [
  { name: 'speaksToHuman', kind: 'speaksToHuman', what: 'may write to "you"' },
  { name: 'assigns', kind: 'assigns', what: 'hands work out and may hire' },
  { name: 'builds', kind: 'builds', what: 'does the work and reports when done' },
  { name: 'checks', kind: 'checks', what: 'decides whether it passes' }
]

export const buildsCapabilityIn = (w: WorkflowInfo | null): string | undefined =>
  // Whatever this floor declared as the doing of the work, then whoever already
  // does it, then anything at all. A new box does the work; it does not hand it
  // out, which is what taking the first capability in the list used to make it.
  (w?.capabilities ?? []).find((c) => c.kind === 'builds')?.name ??
  w?.roles[rolesWithIn(w, 'builds')[0] ?? '']?.can[0] ??
  (w?.capabilities ?? [])[0]?.name

export const roleCan = (role: string, kind: string): boolean => rolesWith(kind).includes(role)

/**
 * A role with a fixed agent is part of the floor rather than staff on it: the
 * app spawns it, the roster pins it, and nothing in the UI fires it.
 */
export const isCore = (role: string): boolean => Boolean(wf?.roles[role]?.fixed)

/** The role a task typed at the floor goes to. Empty until the workflow lands. */
export const dispatchRole = (): string => wf?.dispatch ?? ''

/** The role inbound work - webhooks, schedules - arrives at. */
export const entryRole = (): string => wf?.entry ?? dispatchRole()

/**
 * Who work is handed to once it is in the door.
 *
 * The one who assigns and is not the one it was dispatched to, because that is
 * the hand-off worth naming. On a floor where the boss assigns directly there
 * is no second party and this is dispatch itself - the same agent, said once.
 */
export const assignerRole = (): string =>
  rolesWith('assigns').find((r) => r !== dispatchRole()) ?? rolesWith('assigns')[0] ?? dispatchRole()

/** What a hire is, when nothing said which kind. */
export const buildRole = (): string => rolesWith('builds')[0] ?? dispatchRole()

/**
 * The board's columns, as this floor names them.
 *
 * A column nobody can ever reach is not shown: on a floor where nothing checks
 * work, `wait_test` is a step that does not exist here, and an empty column
 * describes a process the workflow does not have.
 */
export const columns = (): { key: string; label: string; bar: string; kind?: string }[] => {
  const all = wf?.columns ?? []
  return all.filter((c) => c.kind !== 'waiting' || anyoneChecks())
}

/** Whether anyone here decides that work passes. Nobody → "built" is done. */
export const anyoneChecks = (): boolean => rolesWith('checks').length > 0

/** How the workflow names a role mid-sentence: "the boss", "a tester". */
export const roleLabel = (role: string): string => wf?.roles[role]?.label ?? role

/**
 * What to call whoever fills a role in a sentence: their name if the workflow
 * gives the role a fixed agent, and its label otherwise - a hired role has no
 * one name, and "a tester" is the true answer there.
 */
export const roleName = (role: string): string => wf?.roles[role]?.fixed?.name ?? roleLabel(role)

/**
 * The tag beside a name on the roster, or null for no tag.
 *
 * The label is written to be read mid-sentence ("the boss does not write to a
 * tester"), so the article comes off before it goes on a row. Whoever builds is
 * the unremarkable case and gets none - tagging every row tags none.
 */
export const roleTag = (role: string): string | null => {
  const def = wf?.roles[role]
  if (!def || roleCan(role, 'builds')) return null
  return def.label.replace(/^(the|a|an) /i, '')
}

/** The agent filling a role, if one is on the floor. */
export const withRole = <T extends { role: string }>(agents: T[], role: string): T | undefined =>
  role ? agents.find((a) => a.role === role) : undefined

/** The agent a dispatched task is typed at. */
export const dispatchAgent = <T extends { role: string }>(agents: T[]): T | undefined =>
  withRole(agents, dispatchRole())

/** The agent work is handed to, when that is somebody other than dispatch. */
export const assignerAgent = <T extends { role: string }>(agents: T[]): T | undefined =>
  assignerRole() === dispatchRole() ? undefined : withRole(agents, assignerRole())
