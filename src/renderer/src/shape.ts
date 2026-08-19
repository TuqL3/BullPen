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
const holds = (role: string, word: string): boolean =>
  word === role || (wf?.roles[role]?.can ?? []).includes(word)

/**
 * The four questions the UI asks about a floor, answered the way main answers
 * them: from what the workflow already says.
 *
 * Capabilities used to carry a label saying which of four things the app should
 * treat them as. It was a second copy of what `talks to` and the card rules
 * already said, and a floor could contradict itself between them.
 */
export const rolesWith = (kind: string): string[] => {
  const names = Object.keys(wf?.roles ?? {})
  const fromRules = (status: string): string[] =>
    names.filter((r) =>
      (wf?.cardRules ?? []).some((rule) => rule.status === status && holds(r, rule.from))
    )

  if (kind === 'speaksToHuman') {
    if (wf?.voice && wf.roles[wf.voice]) return [wf.voice]
    return names.filter((r) => (wf?.talksTo[r] ?? []).includes(wf?.human ?? 'you'))
  }
  if (kind === 'assigns') return fromRules('open')
  if (kind === 'checks') return fromRules('closes')
  if (wf?.hires && wf.roles[wf.hires]) return [wf.hires]
  const taken = new Set([
    ...rolesWith('speaksToHuman'),
    ...rolesWith('assigns'),
    ...rolesWith('checks')
  ])
  const rest = names.filter((r) => !taken.has(r))
  return rest.length ? rest : names.filter((r) => wf?.roles[r].hireable)
}

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
