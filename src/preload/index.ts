import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

export type ActivityItem = {
  id: number
  ts: number
  kind: string
  actor: string
  text: string
}

export type Question = {
  id: string
  from: string
  to: string
  subject: string
  body: string
  ts: number
}

/** One row of the snapshot Michael reads to see who is on the floor. */
export type FloorAgent = {
  id: string
  name: string
  project: string
  cwd: string
  status: string
  activity: string
  pid: number
  ctxPct?: number
  model?: string
  costUsd?: number
}

export type GitChange = { path: string; code: string; staged: boolean; untracked: boolean }
export type GitChanges = { repo: boolean; changes: GitChange[]; branch?: string; error?: string }
export type CodeEntry = { name: string; path: string; dir: boolean; size: number }
export type CodeEdit = { path: string; ts: number; tool: string }

export type AgentCost = {
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  turns: number
  models: string[]
  unpricedTokens: number
  usd: number
  complete: boolean
}

const on = <T extends unknown[]>(channel: string, fn: (...args: T) => void): (() => void) => {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => fn(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.off(channel, listener)
  }
}

/**
 * The renderer gets this and nothing else - no `require`, no fs, no ipcRenderer.
 * Every capability the UI has is one named function on this object.
 */
const api = {
  pickDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDir'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  /** macOS keeps its native traffic lights; everywhere else we draw our own. */
  isMac: process.platform === 'darwin',
  spawn: (spec: { id: string; cwd: string; cmd?: string; args?: string[]; cols?: number; rows?: number }) =>
    ipcRenderer.invoke('agent:spawn', spec),
  listAgents: () => ipcRenderer.invoke('agent:list'),
  kill: (id: string) => ipcRenderer.invoke('agent:kill', id),

  write: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),
  /** Type a prompt and submit it - see submitPrompt in main for why not write(). */
  submit: (id: string, text: string) => ipcRenderer.invoke('agent:submit', id, text),
  resize: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:resize', id, cols, rows),
  onData: (fn: (id: string, chunk: string) => void) => on('pty:data', fn),
  onExit: (fn: (id: string, code: number) => void) => on('agent:exit', fn),
  onTrust: (fn: (id: string, sandbox: string) => void) => on('agent:trust', fn),
  onStatus: (fn: (id: string, status: 'working' | 'idle') => void) => on('agent:status', fn),
  ctx: (id: string): Promise<{ used: number; limit: number; pct: number; model: string } | null> =>
    ipcRenderer.invoke('agent:ctx', id),
  onCtx: (fn: (id: string, ctx: { used: number; limit: number; pct: number; model: string }) => void) =>
    on('agent:ctx', fn),
  cost: (id: string): Promise<AgentCost | null> => ipcRenderer.invoke('agent:cost', id),
  onCost: (fn: (id: string, cost: AgentCost) => void) => on('agent:cost', fn),
  steer: (id: string, note: string) => ipcRenderer.invoke('agent:steer', id, note),
  steers: (id: string): Promise<string[]> => ipcRenderer.invoke('agent:steers', id),
  onSteerQueued: (fn: (id: string, note: string, depth: number) => void) => on('agent:steer-queued', fn),
  onSteerDelivered: (fn: (id: string, notes: string[]) => void) => on('agent:steer-delivered', fn),

  listApprovals: () => ipcRenderer.invoke('approvals:list'),
  decide: (id: string, decision: 'allow' | 'deny') => ipcRenderer.invoke('approvals:decide', id, decision),
  onPending: (fn: (p: unknown) => void) => on('approvals:pending', fn),
  onResolved: (fn: (p: unknown, decision: string) => void) => on('approvals:resolved', fn),

  activity: (limit?: number): Promise<ActivityItem[]> => ipcRenderer.invoke('activity:list', limit),
  onActivity: (fn: (item: ActivityItem) => void) => on('activity:item', fn),
  /** An agent finished a turn, with the last thing it said. */
  onFinished: (fn: (r: { id: string; text: string | null; at: number }) => void) =>
    on('agent:finished', fn),

  askList: (): Promise<Question[]> => ipcRenderer.invoke('ask:list'),
  askAnswer: (qid: string, answer: string) => ipcRenderer.invoke('ask:answer', qid, answer),
  askDismiss: (qid: string) => ipcRenderer.invoke('ask:dismiss', qid),
  onAsk: (fn: (qs: Question[]) => void) => on('ask:pending', fn),

  setGod: (id: string) => ipcRenderer.invoke('agent:setGod', id),
  /** Bring Michael up, or hand back the one already running. */
  ensureGod: (size: {
    cols: number
    rows: number
  }): Promise<{
    id: string
    name: string
    cwd: string
    pid: number
    startedAt: number
    cols: number
    rows: number
    alreadyUp: boolean
  }> => ipcRenderer.invoke('god:ensure', size),
  /** Restart Michael in a directory of the operator's choosing, and remember it. */
  moveGod: (
    dir: string,
    size: { cols: number; rows: number }
  ): Promise<
    | { error: string }
    | { id: string; name: string; cwd: string; pid: number; startedAt: number; cols: number; rows: number }
  > => ipcRenderer.invoke('god:move', dir, size),
  godCwd: (): Promise<string> => ipcRenderer.invoke('god:cwd'),
  codeList: (root: string, rel: string): Promise<{ entries?: CodeEntry[]; error?: string }> =>
    ipcRenderer.invoke('code:list', root, rel),
  codeRead: (
    root: string,
    rel: string
  ): Promise<{ path?: string; text?: string; truncated?: boolean; binary?: boolean; error?: string }> =>
    ipcRenderer.invoke('code:read', root, rel),
  codeWrite: (root: string, rel: string, text: string): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke('code:write', root, rel, text),
  codeEdits: (agentId: string): Promise<CodeEdit[]> => ipcRenderer.invoke('code:edits', agentId),
  openShell: (
    agentId: string,
    cwd: string,
    size: { cols: number; rows: number }
  ): Promise<{ id: string; cwd: string; pid: number; status: string }> =>
    ipcRenderer.invoke('shell:open', agentId, cwd, size),
  gitChanges: (root: string): Promise<GitChanges> => ipcRenderer.invoke('git:changes', root),
  gitDiff: (root: string, rel: string): Promise<{ text: string; error?: string }> =>
    ipcRenderer.invoke('git:diff', root, rel),
  onEdited: (fn: (agentId: string, path: string) => void) => on('code:edited', fn),
  /** An agent Michael hired: main spawned it, the roster has never seen it. */
  onHired: (
    fn: (a: { id: string; name: string; project: string; cwd: string; pid: number; startedAt: number; cols: number; rows: number }) => void
  ) => on('agent:hired', fn),
  layout: (): Promise<unknown> => ipcRenderer.invoke('layout:get'),
  saveLayout: (layout: unknown): Promise<boolean> => ipcRenderer.invoke('layout:set', layout),
  /** Has a workspace been chosen for Michael yet, and what to suggest if not. */
  godSetup: (): Promise<{ chosen: boolean; cwd: string }> => ipcRenderer.invoke('god:setup'),
  /** Publish the roster to the file Michael reads. */
  publishFloor: (agents: FloorAgent[]): Promise<boolean> =>
    ipcRenderer.invoke('floor:publish', agents),
  dispatch: (text: string, owner: string, project = ''): Promise<string | null> =>
    ipcRenderer.invoke('agent:dispatch', text, owner, project),
  search: (q: string): Promise<{ where: string; text: string }[]> =>
    ipcRenderer.invoke('search:text', q),

  setTaskStatus: (id: string, status: string) => ipcRenderer.invoke('board:setTaskStatus', id, status),
  assignTask: (id: string, agentId: string) => ipcRenderer.invoke('board:assignTask', id, agentId),
  tasks: (id?: string) => ipcRenderer.invoke('board:tasks', id),
  addTask: (id: string, text: string) => ipcRenderer.invoke('board:addTask', id, text),
  toggleTask: (id: string) => ipcRenderer.invoke('board:toggleTask', id),
  removeTask: (id: string) => ipcRenderer.invoke('board:removeTask', id),
  triggers: (id?: string) => ipcRenderer.invoke('board:triggers', id),
  addTrigger: (id: string, prompt: string, mins: number) =>
    ipcRenderer.invoke('board:addTrigger', id, prompt, mins),
  toggleTrigger: (id: string) => ipcRenderer.invoke('board:toggleTrigger', id),
  removeTrigger: (id: string) => ipcRenderer.invoke('board:removeTrigger', id),
  onTriggerFired: (fn: (id: string, prompt: string) => void) => on('agent:trigger-fired', fn),
  memory: (cwd: string): Promise<{ name: string; text: string } | null> =>
    ipcRenderer.invoke('agent:memory', cwd),

  sendMail: (msg: { from: string; to: string; subject: string; body: string }) =>
    ipcRenderer.invoke('hive:send', msg),
  inbox: (id: string) => ipcRenderer.invoke('hive:inbox', id),
  onDeliver: (fn: (d: unknown) => void) => on('hive:deliver', fn)
}

contextBridge.exposeInMainWorld('bullpen', api)

export type BullpenApi = typeof api
