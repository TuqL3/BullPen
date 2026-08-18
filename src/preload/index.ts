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

/** A call that came in: accepted, or refused with the reason as its subject. */
export type WebhookCall = { at: number; from: string; subject: string; ok: boolean }

/** The inbound webhook, as main knows it. `error` is set when it refused to start. */
export type WebhookState = {
  enabled: boolean
  port: number
  token: string
  running?: boolean
  error?: string
  lastCall?: WebhookCall | null
}

/** What to do when an agent's context fills: compact it, or clear it. */
export type ContextRule = {
  agentId: string
  atPct: number
  action: 'compact' | 'clear'
  enabled: boolean
  lastRun: number
  armed: boolean
}

/** A brief the operator handed to the god agent, before he wrapped it in orders. */
/**
 * The floor's shape, as the renderer sees it.
 *
 * Structural rather than imported from main: preload is the only thing both
 * sides share, and re-declaring the four fields the UI actually reads is
 * cheaper than dragging main's module graph into the renderer.
 */
export type WorkflowInfo = {
  name: string
  description: string
  dispatch: string
  entry: string
  reuseBelowPct: number
  hireAbovePct: number
  roles: Record<
    string,
    {
      can: string[]
      label: string
      fixed?: { id: string; name: string }
      hireable?: boolean
      brief: string
    }
  >
  talksTo: Record<string, string[]>
}

export type Dispatch = { text: string; owner: string; project: string; ts: number }

/** Where the work stands, as the god agent last described it. */
export type Report = { from: string; subject: string; body: string; ts: number }

/** One row of the snapshot Michael reads to see who is on the floor. */
export type FloorAgent = {
  id: string
  name: string
  project: string
  cwd: string
  status: string
  activity: string
  /** What they are for - the analyst reads this to pick who tests what. */
  role?: string
  pid: number
  ctxPct?: number
  model?: string
  costUsd?: number
}

export type GitChange = { path: string; code: string; staged: boolean; untracked: boolean }
export type GitChanges = { repo: boolean; changes: GitChange[]; branch?: string; error?: string }
export type CodeEntry = { name: string; path: string; dir: boolean; size: number }
export type CodeEdit = { path: string; ts: number; tool: string }
export type Hit = {
  path: string
  line: number
  text: string
  /** Where the query matched inside `text`, for highlighting. */
  ranges: [number, number][]
}
export type FileHits = { path: string; count: number }

export type SearchResult = {
  /** The first slice of matches, for rendering. */
  hits: Hit[]
  /** Every matching file, complete even when the rows are capped. */
  matched: FileHits[]
  /** Every match found, which is usually more than `hits` carries. */
  total: number
  /** How many distinct files matched. */
  files: number
  scanned: number
  /** True when there are more matches than `hits` holds. */
  capped: boolean
  /** True when the walk stopped on its time budget. */
  timedOut: boolean
  /** Set when the query itself was the problem - an unfinished regex. */
  error?: string
}

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
  toggleFullscreen: () => ipcRenderer.invoke('window:toggleFullscreen'),
  /** Light or dark, remembered across restarts and handed to every agent's CLI. */
  /** The saved theme, known before the first render rather than one paint late. */
  initialMode: (process.argv.find((a) => a.startsWith('--bullpen-mode=')) ?? '').endsWith('dark')
    ? ('dark' as const)
    : ('light' as const),
  setMode: (mode: 'light' | 'dark'): Promise<boolean> => ipcRenderer.invoke('ui:setMode', mode),
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
  /** The last tool an agent finished, so "working" can say what it is doing. */
  onTool: (fn: (id: string, tool: string, detail: string) => void) => on('agent:tool', fn),
  /** `asked` is null once the agent is no longer stopped on its own question. */
  onWaiting: (fn: (id: string, asked: string | null) => void) => on('agent:waiting', fn),
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
  /** The queue was dropped rather than delivered - the agent was halted. */
  onSteerCleared: (fn: (id: string, notes: string[]) => void) => on('agent:steer-cleared', fn),

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
  /** The god agent's last progress report. Not a question - nothing is owed. */
  lastReport: (): Promise<Report | null> => ipcRenderer.invoke('report:last'),
  onReport: (fn: (r: Report) => void) => on('report:new', fn),
  /** What the operator last dispatched, in their own words. */
  lastDispatch: (): Promise<Dispatch | null> => ipcRenderer.invoke('dispatch:last'),
  onDispatch: (fn: (d: Dispatch) => void) => on('dispatch:new', fn),

  setGod: (id: string) => ipcRenderer.invoke('agent:setGod', id),
  /** Say what a hand-made agent is for: it decides how its cards move. */
  setRole: (id: string, role: string) => ipcRenderer.invoke('agent:setRole', id, role),
  /**
   * Bring up every standing agent the workflow names besides the boss, or hand
   * back the ones already running. Empty when the workflow has none - a floor
   * whose boss assigns directly has nobody here, and that is an answer rather
   * than a failure.
   */
  ensureFixed: (size: {
    cols: number
    rows: number
  }): Promise<
    {
      id: string
      name: string
      /** Which workflow role this one fills. */
      role: string
      cwd: string
      pid: number
      startedAt: number
      cols: number
      rows: number
      alreadyUp: boolean
    }[]
  > => ipcRenderer.invoke('fixed:ensure', size),

  /**
   * The floor's shape - as structure for the summary table, and as the markdown
   * a person edits. Both, because they answer different questions: the table
   * says what is running, the text is what you change.
   */
  workflow: (): Promise<{
    workflow: WorkflowInfo
    markdown: string
    problems: string[]
    stale: string[]
  }> => ipcRenderer.invoke('workflow:get'),
  /** Everything switchable: the built-in starting points, and what was saved. */
  workflowList: (): Promise<
    { name: string; description: string; markdown: string; builtin: boolean }[]
  > => ipcRenderer.invoke('workflow:list'),
  /**
   * Stop the standing agents, so they can be brought back up on the workflow
   * that is running now. Returns the ids that are down.
   */
  stopFixed: (): Promise<string[]> => ipcRenderer.invoke('fixed:stop'),
  /**
   * Write a workflow from a sentence about how the floor should work.
   *
   * Slow - it runs a real model turn - and it can come back with problems
   * still on it, which is why it returns them rather than throwing.
   */
  generateWorkflow: (
    description: string
  ): Promise<{ markdown?: string; problems?: string[]; error?: string }> =>
    ipcRenderer.invoke('workflow:generate', description),
  /** An annotated empty floor, for a first workflow. */
  workflowStarter: (): Promise<string> => ipcRenderer.invoke('workflow:starter'),
  /** Keep one without running it. */
  saveWorkflow: (markdown: string): Promise<{ name?: string; error?: string }> =>
    ipcRenderer.invoke('workflow:save', markdown),
  deleteWorkflow: (name: string): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke('workflow:delete', name),
  /**
   * Read the editor's text without applying it: what is wrong with it, and the
   * floor it describes, for the preview beside it.
   */
  lintWorkflow: (
    markdown: string
  ): Promise<{ problems: string[]; preview: WorkflowInfo | null }> =>
    ipcRenderer.invoke('workflow:lint', markdown),
  /** Apply one. Refused whole if it would not work, with the reasons. */
  setWorkflow: (
    markdown: string
  ): Promise<{ workflow?: WorkflowInfo; markdown?: string; error?: string }> =>
    ipcRenderer.invoke('workflow:set', markdown),
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
  /** Plain text search across the agent's workspace. Bounded; see code.ts. */
  codeSearch: (
    root: string,
    query: string,
    caseSensitive = false,
    regex = false,
    /** Restrict to these paths - used to fetch one file's lines on demand. */
    only?: string[]
  ): Promise<SearchResult> =>
    ipcRenderer.invoke('code:search', root, query, caseSensitive, regex, only),
  /** `fresh` starts another shell beside the ones already open, rather than
   *  handing back the one that is running. */
  openShell: (
    agentId: string,
    cwd: string,
    size: { cols: number; rows: number },
    fresh = false
  ): Promise<{ id: string; cwd: string; pid: number; status: string }> =>
    ipcRenderer.invoke('shell:open', agentId, cwd, size, fresh),
  gitChanges: (root: string): Promise<GitChanges> => ipcRenderer.invoke('git:changes', root),
  gitDiff: (root: string, rel: string): Promise<{ text: string; error?: string }> =>
    ipcRenderer.invoke('git:diff', root, rel),
  /** Throw away one file's changes. Irreversible: a tracked file goes back to
   *  HEAD, an untracked one is deleted. Ask before calling it. */
  /** Per-file added/deleted counts: one call that says which diffs went stale. */
  gitStats: (root: string): Promise<Record<string, string>> => ipcRenderer.invoke('git:stats', root),
  gitDiscard: (root: string, rel: string): Promise<{ ok?: true; error?: string }> =>
    ipcRenderer.invoke('git:discard', root, rel),
  /** The same for one block of touching changed lines - what you point at. */
  gitDiscardBlock: (
    root: string,
    rel: string,
    hunk: number,
    block: number,
    marker: string
  ): Promise<{ ok?: true; error?: string }> =>
    ipcRenderer.invoke('git:discardBlock', root, rel, hunk, block, marker),
  /** The same for one hunk. `marker` is the `@@` line the panel is showing, so
   *  a stale panel cannot revert the wrong part of the file. */
  gitDiscardHunk: (
    root: string,
    rel: string,
    index: number,
    marker: string
  ): Promise<{ ok?: true; error?: string }> =>
    ipcRenderer.invoke('git:discardHunk', root, rel, index, marker),
  onEdited: (fn: (agentId: string, path: string) => void) => on('code:edited', fn),
  /** An agent Michael hired: main spawned it, the roster has never seen it. */
  onHired: (
    fn: (a: {
      id: string
      name: string
      project: string
      cwd: string
      pid: number
      startedAt: number
      cols: number
      rows: number
      /** What it was hired as: someone who builds, or someone who checks. */
      role?: string
      /** The task it was hired to do, as its first turn. */
      brief?: string
    }) => void
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
  onDeliver: (fn: (d: unknown) => void) => on('hive:deliver', fn),
  /** The board, whenever it changes - agents write to it as well as you do. */
  onTasks: (fn: (tasks: unknown[]) => void) => on('board:tasks', fn),
  /** Schedules, whenever one is added, toggled, removed or fires. */
  onTriggers: (fn: (triggers: unknown[]) => void) => on('board:triggers', fn),
  rules: (id?: string): Promise<ContextRule[]> => ipcRenderer.invoke('board:rules', id),
  setRule: (id: string, atPct: number, action: 'compact' | 'clear'): Promise<ContextRule | null> =>
    ipcRenderer.invoke('board:setRule', id, atPct, action),
  toggleRule: (id: string): Promise<void> => ipcRenderer.invoke('board:toggleRule', id),
  removeRule: (id: string): Promise<void> => ipcRenderer.invoke('board:removeRule', id),
  onRules: (fn: (rules: ContextRule[]) => void) => on('board:rules', fn),
  /** The inbound door: whether it is open, on what port, and with what token. */
  webhook: (): Promise<WebhookState> => ipcRenderer.invoke('webhook:get'),
  setWebhook: (enabled: boolean, port: number): Promise<WebhookState> =>
    ipcRenderer.invoke('webhook:set', enabled, port),
  rotateWebhookToken: (): Promise<WebhookState> => ipcRenderer.invoke('webhook:rotate'),
  /** Post a task to ourselves through the real socket, to prove it is wired. */
  testWebhook: (): Promise<{ ok: boolean; status?: number; body?: string; error?: string }> =>
    ipcRenderer.invoke('webhook:test'),
  onWebhookCall: (fn: (call: WebhookCall) => void) => on('webhook:call', fn),
  /** Open an http(s) link in the real browser. Anything else is refused. */
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('ui:open', url),
  /** Desktop notifications: on unless turned off. */
  notify: (): Promise<boolean> => ipcRenderer.invoke('ui:notify'),
  setNotify: (on: boolean): Promise<boolean> => ipcRenderer.invoke('ui:setNotify', on),
  /** A notification was clicked: show this tab, and this agent if it names one. */
  onGoto: (fn: (tab: string, id: string | null) => void) => on('ui:goto', fn)
}

contextBridge.exposeInMainWorld('bullpen', api)

export type BullpenApi = typeof api
