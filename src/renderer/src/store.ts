import { create } from 'zustand'

export type Agent = {
  id: string
  /**
   * The god agent is the operator's own clone: one per floor, pinned above the
   * projects. It is what dispatch routes through, what sits at the centre of
   * the graph, and what the activity log means by "god".
   */
  role: 'god' | 'worker'
  /** Which project this agent belongs to. God agents belong to none. */
  project: string
  /** What the human typed in the wizard; `id` is its slug. */
  name: string
  cwd: string
  pid: number
  status: 'running' | 'exited'
  /** Set when a mail or approval arrives; drives the badge, and later the avatar. */
  activity: 'idle' | 'working' | 'blocked'
  /** Avatar seed - the preset the human picked, not the id. */
  face: string
  /** Shirt colour override, so two agents sharing a face stay distinguishable. */
  color?: string
  /** Epoch ms the pty was spawned; drives uptime in monitor and workers. */
  startedAt?: number
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

export type MailEvent = { to: string; from: string; subject: string; ts: number }

type State = {
  agents: Agent[]
  approvals: Approval[]
  mail: MailEvent[]
  /** agentId -> epoch ms of the last pty output, throttled. */
  lastSeen: Record<string, number>
  /** agentId -> messages typed while that agent was busy, oldest first. */
  queue: Record<string, string[]>
  /** agentId -> steer notes accepted by main but not yet delivered. */
  steers: Record<string, string[]>
  selected: string | null
  select: (id: string) => void
  upsertAgent: (a: Partial<Agent> & { id: string }) => void
  setApprovals: (a: Approval[]) => void
  addApproval: (a: Approval) => void
  removeApproval: (id: string) => void
  addMail: (m: MailEvent) => void
  enqueue: (agentId: string, text: string) => void
  /** Remove and return the oldest queued message, or null if there is none. */
  shift: (agentId: string) => string | null
  removeQueued: (agentId: string, index: number) => void
  clearQueue: (agentId: string) => void
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
  queue: {},
  steers: {},
  selected: null,

  select: (id) => set({ selected: id }),

  upsertAgent: (a) =>
    set((s) => {
      const i = s.agents.findIndex((x) => x.id === a.id)
      if (i === -1) {
        const fresh: Agent = {
          role: 'worker',
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

  enqueue: (agentId, text) =>
    set((s) => ({ queue: { ...s.queue, [agentId]: [...(s.queue[agentId] ?? []), text] } })),

  // Not a zustand action returning state: the caller needs the message itself
  // to write it to the pty, and it must leave the queue in the same step so a
  // second idle event cannot send it twice.
  shift: (agentId) => {
    const list = get().queue[agentId] ?? []
    if (list.length === 0) return null
    const [head, ...rest] = list
    set((s) => ({ queue: { ...s.queue, [agentId]: rest } }))
    return head
  },

  removeQueued: (agentId, index) =>
    set((s) => ({
      queue: { ...s.queue, [agentId]: (s.queue[agentId] ?? []).filter((_, i) => i !== index) }
    })),

  clearQueue: (agentId) => set((s) => ({ queue: { ...s.queue, [agentId]: [] } })),

  setSteers: (agentId, notes) => set((s) => ({ steers: { ...s.steers, [agentId]: notes } })),

  // Throttled by the caller: pty output arrives dozens of times a second and
  // every write here would re-render the whole tree.
  touch: (agentId, ts) => set((s) => ({ lastSeen: { ...s.lastSeen, [agentId]: ts } }))
}))
