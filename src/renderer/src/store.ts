import { create } from 'zustand'

export type Agent = {
  id: string
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
  selected: string | null
  select: (id: string) => void
  upsertAgent: (a: Partial<Agent> & { id: string }) => void
  setApprovals: (a: Approval[]) => void
  addApproval: (a: Approval) => void
  removeApproval: (id: string) => void
  addMail: (m: MailEvent) => void
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
  selected: null,

  select: (id) => set({ selected: id }),

  upsertAgent: (a) =>
    set((s) => {
      const i = s.agents.findIndex((x) => x.id === a.id)
      if (i === -1) {
        const fresh: Agent = {
          name: a.id,
          cwd: '',
          pid: 0,
          status: 'running',
          activity: 'working',
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
  addMail: (m) => set((s) => ({ mail: [...s.mail.slice(-199), m] }))
}))
