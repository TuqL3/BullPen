import { create } from 'zustand'

export type Agent = {
  id: string
  /**
   * What this agent is for.
   *
   * The god agent is the operator's own clone: one per floor, pinned above the
   * projects. It is what dispatch routes through, what sits at the centre of
   * the graph, and what the activity log means by "god". The analyst sits
   * beside it, above the projects too: she is who work is handed to, and every
   * dev and tester below is hired by her.
   *
   * 'worker' is what everyone below used to be, kept so an agent made by the
   * wizard before roles existed still loads as somebody who builds.
   */
  role: string
  /** Which project this agent belongs to. God agents belong to none. */
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
   * Its hiring brief, or the last message Michael sent it. The monitor answers
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

/**
 * The roles that cannot be fired: they have a fixed agent and no re-hire path.
 *
 * Set from the running workflow at startup rather than written here - somebody
 * else's floor does not have a "god" and a "ba" on it. The default is the
 * default workflow's, so a floor that never sets one is still protected.
 */
let coreRoles: ReadonlySet<string> = new Set(['god', 'ba'])
export const setCoreRoles = (roles: string[]): void => {
  coreRoles = new Set(roles)
}
export const isCore = (role: string): boolean => coreRoles.has(role)

export type Approval = {
  id: string
  agentId: string
  toolName: string
  detail: string
  reason: string
  createdAt: number
}

export type MailEvent = { to: string; from: string; subject: string; ts: number }

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
  removeAgent: (id: string) => void
  setApprovals: (a: Approval[]) => void
  addApproval: (a: Approval) => void
  removeApproval: (id: string) => void
  addMail: (m: MailEvent) => void
  setSteers: (agentId: string, notes: string[]) => void
  touch: (agentId: string, ts: number) => void
}

/**
 * Single source of truth for the UI. Phase 2's office floor renders straight
 * off this - avatar pose from `activity`, envelopes from `mail` - so it needs
 * no new plumbing in main.
 */
export const useStore = create<State>((set, get) => ({
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
          role: 'dev',
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
   * Fired, not merely stopped. `agent:kill` only ends the process - the row it
   * left behind had no way off the roster, which is what "I cannot dismiss
   * anyone" was. Nothing about an agent survives a restart, so dropping it
   * here is the whole of it; no file to clean up.
   */
  removeAgent: (id) =>
    set((s) => {
      // Michael and the analyst are the floor, not staff on it: dispatch routes
      // through him, every hire below reports to her, and nothing in the UI
      // brings either one back. Enforced here rather than only in the row that
      // hides the button, so no later caller can route around it.
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
  addMail: (m) => set((s) => ({ mail: [...s.mail.slice(-199), m] })),


  setSteers: (agentId, notes) => set((s) => ({ steers: { ...s.steers, [agentId]: notes } })),

  // Throttled by the caller: pty output arrives dozens of times a second and
  // every write here would re-render the whole tree.
  touch: (agentId, ts) => set((s) => ({ lastSeen: { ...s.lastSeen, [agentId]: ts } }))
}))
