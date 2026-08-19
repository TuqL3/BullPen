import { create } from 'zustand'
// Explicit extension: the node test runner loads this file directly, and
// bundler-style extensionless resolution is Vite's, not node's.
import { buildRole, isCore } from './shape.ts'

export type Agent = {
  id: string
  /**
   * What this agent is for: a role name out of the running workflow.
   *
   * The roles with a fixed agent are the floor itself - pinned above the
   * projects, never fired - and the rest are staff hired onto a project. Which
   * is which is the workflow's answer, read through `shape.ts`; nothing in the
   * UI knows a role by name.
   *
   * 'worker' is what everyone below used to be, kept so an agent made by the
   * wizard before roles existed still loads as somebody who builds.
   */
  role: string
  /** Which project this agent belongs to. The floor's own agents belong to none. */
  project: string
  /** What the human typed in the wizard; `id` is its slug. */
  name: string
  cwd: string
  /**
   * The CLI this agent runs - `claude` today, something else once another one
   * is wired up. What you can type at it depends on this, not on Bullpen.
   */
  cli?: string
  pid: number
  status: 'running' | 'exited'
  /** Set when a mail or approval arrives; drives the badge, and later the avatar. */
  activity: 'idle' | 'working' | 'blocked'
  /** The last tool it finished, so a working agent can say what it is doing. */
  doing?: { tool: string; detail: string; at: number }
  /**
   * What it was last asked to do, in the words it was asked in.
   *
   * Its hiring brief, or the last message it was sent. The monitor answers
   * "what is everyone doing" with a tool call, which says what an agent is
   * touching this second and nothing about what it was sent for.
   */
  task?: { text: string; at: number }
  /**
   * The question the agent is stopped on inside its own terminal, if any.
   * Distinct from an approval: Bullpen has nothing to decide here, the CLI is
   * waiting on a keystroke and all the UI can do is say so.
   */
  asked?: string | null
  /** Avatar seed - the preset the human picked, not the id. */
  face: string
  /** Shirt colour override, so two agents sharing a face stay distinguishable. */
  color?: string
  /** Epoch ms the pty was spawned; drives uptime in monitor and workers. */
  startedAt?: number
  /** Live pty dimensions, so a mismatch with the terminal is visible. */
  cols?: number
  rows?: number
  /** Context window usage from the agent's own transcript. */
  ctx?: { used: number; limit: number; pct: number; model: string }
  /** Token totals and API-equivalent cost, accumulated from the transcript. */
  cost?: import('../../preload/index').AgentCost
  exitCode?: number
}


export type Approval = {
  id: string
  agentId: string
  toolName: string
  detail: string
  reason: string
  createdAt: number
}

/**
 * `seq` is what the office floor animates off: the list is a sliding window of
 * the last 200, so its length stops growing and an index into it stops moving.
 * A number that only ever goes up is the one thing a window cannot invalidate.
 */
export type MailEvent = { to: string; from: string; subject: string; ts: number; seq: number }

type State = {
  agents: Agent[]
  approvals: Approval[]
  mail: MailEvent[]
  /** agentId -> epoch ms of the last pty output, throttled. */
  lastSeen: Record<string, number>
  /** agentId -> steer notes accepted by main but not yet delivered. */
  steers: Record<string, string[]>
  selected: string | null
  select: (id: string) => void
  upsertAgent: (a: Partial<Agent> & { id: string }) => void
  patchAgent: (a: Partial<Agent> & { id: string }) => void
  removeAgent: (id: string) => void
  setApprovals: (a: Approval[]) => void
  addApproval: (a: Approval) => void
  removeApproval: (id: string) => void
  addMail: (m: Omit<MailEvent, 'seq'>) => void
  setSteers: (agentId: string, notes: string[]) => void
  touch: (agentId: string, ts: number) => void
}

/**
 * Single source of truth for the UI. Phase 2's office floor renders straight
 * off this - avatar pose from `activity`, envelopes from `mail` - so it needs
 * no new plumbing in main.
 */
export const useStore = create<State>((set) => ({
  agents: [],
  approvals: [],
  mail: [],
  lastSeen: {},
  steers: {},
  selected: null,

  select: (id) => set({ selected: id }),

  upsertAgent: (a) =>
    set((s) => {
      const i = s.agents.findIndex((x) => x.id === a.id)
      if (i === -1) {
        const fresh: Agent = {
          // Whoever builds on this floor, rather than a name from one workflow.
          role: buildRole(),
          project: '',
          name: a.id,
          cwd: '',
          pid: 0,
          status: 'running',
          activity: 'idle',
          face: a.id,
          ...a
        }
        return { agents: [...s.agents, fresh], selected: s.selected ?? a.id }
      }
      const agents = [...s.agents]
      agents[i] = { ...agents[i], ...a }
      return { agents }
    }),

  /**
   * Update somebody already on the roster, and nobody else.
   *
   * Main goes on talking about an agent for a moment after it is fired: `kill`
   * returns when the signal is sent, the `exit` event arrives after that, and a
   * late status or cost reading can be in flight too. Every one of those is a
   * partial patch, and `upsertAgent` treats a partial for an unknown id as a
   * new agent - so firing a running agent put the row straight back on the
   * roster, nameless, with no workspace and whatever the default role is.
   */
  patchAgent: (a) =>
    set((s) => {
      const i = s.agents.findIndex((x) => x.id === a.id)
      if (i === -1) return s
      const agents = [...s.agents]
      agents[i] = { ...agents[i], ...a }
      return { agents }
    }),

  /**
   * Fired, not merely stopped. `agent:kill` only ends the process - the row it
   * left behind had no way off the roster, which is what "I cannot dismiss
   * anyone" was. Nothing about an agent survives a restart, so dropping it
   * here is the whole of it; no file to clean up.
   */
  removeAgent: (id) =>
    set((s) => {
      // A role with a fixed agent is the floor, not staff on it: the app spawns
      // it and nothing in the UI brings it back. Enforced here rather than only
      // in the row that hides the button, so no later caller routes around it.
      if (isCore(s.agents.find((a) => a.id === id)?.role ?? '')) return s
      const agents = s.agents.filter((a) => a.id !== id)
      return {
        agents,
        // Selecting nobody leaves the command centre pointed at a ghost, so
        // the floor's next occupant takes the seat.
        selected: s.selected === id ? (agents[0]?.id ?? null) : s.selected,
        approvals: s.approvals.filter((p) => p.agentId !== id)
      }
    }),

  setApprovals: (approvals) => set({ approvals }),

  addApproval: (a) =>
    set((s) => ({
      approvals: [...s.approvals, a],
      agents: s.agents.map((x) => (x.id === a.agentId ? { ...x, activity: 'blocked' } : x))
    })),

  removeApproval: (id) =>
    set((s) => {
      const gone = s.approvals.find((a) => a.id === id)
      const approvals = s.approvals.filter((a) => a.id !== id)
      const stillBlocked = (agentId: string) => approvals.some((a) => a.agentId === agentId)
      return {
        approvals,
        agents: s.agents.map((x) =>
          gone && x.id === gone.agentId && !stillBlocked(x.id) ? { ...x, activity: 'working' } : x
        )
      }
    }),

  // Bounded: an idle overnight run must not grow this array forever.
  addMail: (m) =>
    set((s) => ({ mail: [...s.mail.slice(-199), { ...m, seq: (s.mail.at(-1)?.seq ?? 0) + 1 }] })),


  setSteers: (agentId, notes) => set((s) => ({ steers: { ...s.steers, [agentId]: notes } })),

  // Throttled by the caller: pty output arrives dozens of times a second and
  // every write here would re-render the whole tree.
  touch: (agentId, ts) => set((s) => ({ lastSeen: { ...s.lastSeen, [agentId]: ts } }))
}))
