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
  to?: string
  subject: string
  body: string
  ts: number
  /** Set once the human replied. Absent while it is still waiting. */
  answeredAt?: number
  answer?: string
  /** Waved away rather than answered. Still worth having been asked. */
  dismissedAt?: number
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
  /** What this floor is for, in prose. Written by the model, kept in the file. */
  summary?: string
  dispatch: string
  entry: string
  hireAbovePct: number
  roles: Record<
    string,
    {
      can: string[]
      label: string
      /** One sentence on what this role is for, when the workflow says. */
      does?: string
      /** The command this role runs, when it is not the default. */
      cli?: string
      /** Where this role's fixed agent works, when it has a directory of its own. */
      cwd?: string
      /** Tools this role never uses. Refused by the approvals layer. */
      never?: string[]
      /** This floor's own words for this role, substituted into its brief. */
      attrs?: Record<string, string>
      fixed?: { id: string; name: string }
      hireable?: boolean
      brief: string
    }
  >
  talksTo: Record<string, string[]>
  /** The role that reports to you, when `talks to` allows more than one. */
  voice?: string
  /** What a hire is when nothing said which kind. */
  hires?: string
  /** What this floor calls the things a role can do, and what each behaves like. */
  capabilities: { name: string; what: string; kind?: string }[]
  /** The board's columns, under this floor's names for them. */
  columns: { key: string; label: string; bar: string; kind?: string }[]
  /** What a message between two roles does to a card. First match wins. */
  cardRules: { from: string; to: string; status: string; whose?: string; when?: string }[]
  /** Placeholders this floor adds to every brief, and what they stand for. */
  words: Record<string, string>
  /** What the human is addressed as here, and what asking for an agent is called. */
  human: string
  hire: string
  /**
   * This floor's own words for the three things a card rule can say that are
   * not the name of a column, and for the word before the reason. Absent means
   * the format's own - which is what every floor written before this used.
   */
  says?: { open?: string; closes?: string; theirs?: string; when?: string }
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

/** Mirrors `src/main/update.ts`. Re-stated rather than imported: the preload is
 *  bundled on its own and must not pull main's modules into the renderer. */
export type UpdateState =
  | { kind: 'dev'; version: string }
  | { kind: 'idle'; version: string; checkedAt?: number }
  | { kind: 'checking'; version: string }
  | { kind: 'available'; version: string; next: string; notes?: string }
  | { kind: 'downloading'; version: string; next: string; percent: number }
  | { kind: 'ready'; version: string; next: string }
  | { kind: 'error'; version: string; message: string }

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
  /** `role` decides the brief the CLI is handed and the tools it is refused,
   *  both read once at spawn - so it has to go out with the spawn, not after. */
  spawn: (spec: {
    id: string
    cwd: string
    cmd?: string
    args?: string[]
    cols?: number
    rows?: number
    role?: string
  }) => ipcRenderer.invoke('agent:spawn', spec),
  kill: (id: string) => ipcRenderer.invoke('agent:kill', id),
  /**
   * Bring one back up under the same id, somewhere else or on another model.
   * A CLI reads both once at startup, so either is a restart - the conversation
   * does not survive it.
   */
  restart: (spec: {
    id: string
    cwd: string
    cmd?: string
    args?: string[]
    cols?: number
    rows?: number
    role?: string
  }) => ipcRenderer.invoke('agent:restart', spec),
  /** Off the roster for good: drop its cards, schedules, context rule and queue. */
  forget: (id: string): Promise<boolean> => ipcRenderer.invoke('agent:forget', id),

  write: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),
  /** Type a prompt and submit it - see submitPrompt in main for why not write(). */
  submit: (id: string, text: string) => ipcRenderer.invoke('agent:submit', id, text),
  resize: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:resize', id, cols, rows),
  /**
   * Open one agent's plain shell, spawning it in that agent's directory if it
   * is not up.
   *
   * Idempotent, so the renderer can call it on every switch to the tab and
   * every change of selection rather than tracking whether the process behind
   * it is still alive. Everything after this - keystrokes, output, resizes -
   * rides the same `pty:*` channels the agents use, keyed by `shellId(agent)`.
   */
  shellOpen: (agentId: string, cols: number, rows: number): Promise<unknown> =>
    ipcRenderer.invoke('shell:open', agentId, cols, rows),
  onData: (fn: (id: string, chunk: string) => void) => on('pty:data', fn),
  /** What this agent already printed, for a terminal buffer that has just opened. */
  backlog: (id: string): Promise<string> => ipcRenderer.invoke('pty:backlog', id),
  onExit: (fn: (id: string, code: number) => void) => on('agent:exit', fn),
  onTrust: (fn: (id: string, sandbox: string) => void) => on('agent:trust', fn),
  onStatus: (fn: (id: string, status: 'working' | 'idle') => void) => on('agent:status', fn),
  /** The last tool an agent finished, so "working" can say what it is doing. */
  onTool: (fn: (id: string, tool: string, detail: string) => void) => on('agent:tool', fn),
  /** `asked` is null once the agent is no longer stopped on its own question. */
  onWaiting: (fn: (id: string, asked: string | null) => void) => on('agent:waiting', fn),
  onCtx: (fn: (id: string, ctx: { used: number; limit: number; pct: number; model: string }) => void) =>
    on('agent:ctx', fn),
  onCost: (fn: (id: string, cost: AgentCost) => void) => on('agent:cost', fn),
  steer: (id: string, note: string) => ipcRenderer.invoke('agent:steer', id, note),
  steers: (id: string): Promise<string[]> => ipcRenderer.invoke('agent:steers', id),
  onSteerQueued: (fn: (id: string, note: string, depth: number) => void) => on('agent:steer-queued', fn),
  onSteerDelivered: (fn: (id: string, notes: string[]) => void) => on('agent:steer-delivered', fn),
  /** The queue was dropped rather than delivered - the agent was halted. */
  onSteerCleared: (fn: (id: string, notes: string[]) => void) => on('agent:steer-cleared', fn),

  decide: (id: string, decision: 'allow' | 'deny') => ipcRenderer.invoke('approvals:decide', id, decision),
  onPending: (fn: (p: unknown) => void) => on('approvals:pending', fn),
  onResolved: (fn: (p: unknown, decision: string) => void) => on('approvals:resolved', fn),

  activity: (limit?: number): Promise<ActivityItem[]> => ipcRenderer.invoke('activity:list', limit),
  onActivity: (fn: (item: ActivityItem) => void) => on('activity:item', fn),
  /** An agent finished a turn, with the last thing it said. */
  askList: (): Promise<Question[]> => ipcRenderer.invoke('ask:list'),
  askAnswer: (qid: string, answer: string) => ipcRenderer.invoke('ask:answer', qid, answer),
  askDismiss: (qid: string) => ipcRenderer.invoke('ask:dismiss', qid),
  /** Everything ever asked, answers and all, newest first. */
  askHistory: (): Promise<Question[]> => ipcRenderer.invoke('ask:history'),
  onAsk: (fn: (qs: Question[]) => void) => on('ask:pending', fn),
  /** The god agent's last progress report. Not a question - nothing is owed. */
  /** Every report this session, newest first. */
  reports: (): Promise<Report[]> => ipcRenderer.invoke('report:list'),
  onReport: (fn: (r: Report) => void) => on('report:new', fn),
  /** What the operator last dispatched, in their own words. */
  lastDispatch: (): Promise<Dispatch | null> => ipcRenderer.invoke('dispatch:last'),
  onDispatch: (fn: (d: Dispatch) => void) => on('dispatch:new', fn),

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
  /**
   * The same, drawn from a repo that already holds how the operator works.
   *
   * Public GitHub repos only so far. Slower than the sentence - a read of the
   * repo, then the same model turn - and it stops at a preview: what comes back
   * is a model's reading of somebody's files, and it becomes the system prompt
   * of every agent on the floor, so a person looks at it before it is applied.
   *
   * `read` is which files it actually took, so the preview can say what it was
   * drawn from rather than leaving that to be guessed.
   */
  workflowFromRepo: (
    url: string
  ): Promise<{
    markdown?: string
    problems?: string[]
    error?: string
    source?: string
    read?: string[]
  }> => ipcRenderer.invoke('workflow:fromRepo', url),
  /** An annotated empty floor, for a first workflow. */
  /** A new chart: you, the boss you dispatch to, a worker under them, and the rules between. */
  workflowBlank: (): Promise<string> => ipcRenderer.invoke('workflow:blank'),
  /** Leaving an unsaved floor: write it first, leave it, or stay. */
  unsavedAsk: (detail: string): Promise<'save' | 'discard' | 'cancel'> =>
    ipcRenderer.invoke('ui:unsaved', detail),
  /**
   * The whole file, written again to match the drawing: every `does`, every
   * brief, the card rules and the summary. The shape stays as drawn.
   */
  redraftWorkflow: (
    floor: WorkflowInfo
  ): Promise<{ markdown?: string; problems?: string[]; error?: string }> =>
    ipcRenderer.invoke('workflow:redraft', floor),
  /** One role's brief, written by the model from a sentence about the job. */
  roleBrief: (
    floor: WorkflowInfo,
    role: string,
    said: string
  ): Promise<{ brief?: string; error?: string }> =>
    ipcRenderer.invoke('role:brief', floor, role, said),
  /**
   * The format reference: the document Bullpen ships, or the one at `path` if
   * the operator wrote their own there. `custom` says which is being read.
   */
  /**
   * Walk a task through a floor without running it: who writes to whom, what it
   * does to the board, and where it stops. Costs nothing - no model, no agents.
   */
  dryRunWorkflow: (
    markdown: string,
    task: string
  ): Promise<{
    steps?: {
      from: string
      to: string
      /** The same two as a person would say them: an agent's name, or a label. */
      fromName: string
      toName: string
      says: string
      card: string
      refused?: string
    }[]
    ends?: string
    error?: string
  }> => ipcRenderer.invoke('workflow:dryRun', markdown, task),
  /** What the floor being drawn reads as, without saving it. */
  previewWorkflow: (
    patch: Partial<WorkflowInfo>
  ): Promise<{ markdown: string; problems: string[] }> =>
    ipcRenderer.invoke('workflow:preview', patch),

  /**
   * Change part of the running workflow - the board's columns, the context
   * thresholds - without retyping the file. Returns the workflow and the
   * markdown it now reads as, or why it was refused.
   */
  patchWorkflow: (
    patch: Partial<WorkflowInfo>
  ): Promise<{
    workflow?: WorkflowInfo
    markdown?: string
    /** What is still unfinished about the floor. Saved anyway. */
    problems?: string[]
    /** Agents stood down because the new floor has no role for them. */
    retired?: string[]
    error?: string
  }> =>
    ipcRenderer.invoke('workflow:patch', patch),

  /** The card rules the drawing itself says, one per line drawn on it. */
  rulesFromDrawing: (
    patch: Partial<WorkflowInfo>
  ): Promise<{ rules?: WorkflowInfo['cardRules']; error?: string }> =>
    ipcRenderer.invoke('workflow:rules', patch),

  /** Write it to disk. What runs is unchanged until `setWorkflow`. */
  saveWorkflowFile: (
    markdown: string
  ): Promise<{
    workflow?: WorkflowInfo
    markdown?: string
    problems?: string[]
    error?: string
  }> => ipcRenderer.invoke('workflow:save', markdown),
  /** Keep one without running it. */
  /**
   * The same floors on the other machine, through a secret gist.
   *
   * Three presses and no daemon: a sync that runs on its own overwrites work
   * while somebody is in the middle of it, and last-write-wins has no opinion
   * about who was typing.
   */
  syncStatus: (): Promise<{
    gist: string
    machine: string
    hasToken: boolean
    /** The GitHub login the token belongs to, as last known. */
    user: string
    keyring: boolean
    canSignIn: boolean
    floors: number
  }> => ipcRenderer.invoke('sync:status'),

  /**
   * Sign in to GitHub without a server: this hands back the code to show, and
   * `awaitSignIn` blocks until it has been typed in at github.com. Two calls
   * because the code has to be on screen while the waiting happens.
   */
  signIn: (): Promise<{ userCode?: string; url?: string; expires?: number; error?: string }> =>
    ipcRenderer.invoke('sync:signIn'),

  awaitSignIn: (): Promise<{ ok?: true; error?: string }> => ipcRenderer.invoke('sync:wait'),

  /** Who the stored token belongs to, straight from GitHub. */
  whoAmI: (): Promise<{ login?: string; error?: string }> => ipcRenderer.invoke('sync:whoami'),

  setSync: (next: { token?: string; machine?: string }): Promise<{ ok: true }> =>
    ipcRenderer.invoke('sync:set', next),

  /** Read what is up there, and let the clock decide which way it goes. */
  syncNow: (): Promise<{
    went?: 'up' | 'down'
    from?: string
    at?: number
    floors?: number
    dropped?: string[]
    error?: string
  }> => ipcRenderer.invoke('sync:now'),

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
  ): Promise<{
    workflow?: WorkflowInfo
    markdown?: string
    /** Agents stood down because the new floor has no role for them. */
    retired?: string[]
    error?: string
  }> =>
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
  gitChanges: (root: string): Promise<GitChanges> => ipcRenderer.invoke('git:changes', root),
  gitDiff: (root: string, rel: string): Promise<{ text: string; error?: string }> =>
    ipcRenderer.invoke('git:diff', root, rel),

  /**
   * The version this is, and whether there is a newer one.
   *
   * `kind: 'dev'` means the app is not packaged and there is nothing to check.
   * On macOS it stops at `idle`: Sparkle draws its own window for the find,
   * download and install, so there is nothing here for the title bar to say.
   * The three-step sequence below is the Windows one.
   */
  /**
   * Folders macOS was asked to open with Bullpen - "Open With" on a directory.
   *
   * Pulled rather than pushed, and draining: a cold launch delivers the folder
   * before this window exists, so there is nothing to push it at. `onOpenPath`
   * is only a nudge saying the queue is worth reading again.
   */
  pendingOpen: (): Promise<string[]> => ipcRenderer.invoke('open:pending'),
  onOpenPath: (fn: () => void): (() => void) => on('open:waiting', fn),
  update: (): Promise<UpdateState> => ipcRenderer.invoke('update:get'),
  updateCheck: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
  updateDownload: (): Promise<UpdateState> => ipcRenderer.invoke('update:download'),
  /** Quits, installs, and comes back on the new version. Ask first. */
  updateInstall: (): Promise<boolean> => ipcRenderer.invoke('update:install'),
  /** Opens the releases page in a browser. The way out when the updater broke. */
  updatePage: (): Promise<boolean> => ipcRenderer.invoke('update:page'),
  onUpdate: (fn: (state: UpdateState) => void): (() => void) => on('update:state', fn),
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
  tasks: (id?: string) => ipcRenderer.invoke('board:tasks', id),
  addTask: (id: string, text: string) => ipcRenderer.invoke('board:addTask', id, text),
  /** Confirm a card is work: the agent is started on it, and on what follows. */
  /** What this agent is on when no flag says: its CLI's config, else its own
   *  startup banner. Null when neither answers. */
  configModel: (id: string, cmd: string, cwd: string): Promise<string | null> =>
    ipcRenderer.invoke('agent:configModel', id, cmd, cwd),
  releaseTask: (id: string) => ipcRenderer.invoke('board:release', id),
  removeTask: (id: string) => ipcRenderer.invoke('board:removeTask', id),
  triggers: (id?: string) => ipcRenderer.invoke('board:triggers', id),
  addTrigger: (id: string, prompt: string, mins: number) =>
    ipcRenderer.invoke('board:addTrigger', id, prompt, mins),
  toggleTrigger: (id: string) => ipcRenderer.invoke('board:toggleTrigger', id),
  removeTrigger: (id: string) => ipcRenderer.invoke('board:removeTrigger', id),
  memory: (cwd: string): Promise<{ name: string; text: string } | null> =>
    ipcRenderer.invoke('agent:memory', cwd),
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
  /** How the app is drawn on this machine: terminal font size, floor colours. */
  uiPrefs: (): Promise<{
    fontSize: number
    floor: string
    /** Where the boxes sit, per floor: this machine's view of that document. */
    chart: Record<string, Record<string, { x: number; y: number }>>
    /** Zoom and corner, per floor. */
    view: Record<string, { k: number; tx: number; ty: number }>
  }> => ipcRenderer.invoke('ui:prefs'),
  setUiPrefs: (next: {
    fontSize?: number
    floor?: string
    chart?: Record<string, Record<string, { x: number; y: number }>>
    view?: Record<string, { k: number; tx: number; ty: number }>
  }): Promise<{ fontSize: number; floor: string }> => ipcRenderer.invoke('ui:setPrefs', next),
  notify: (): Promise<boolean> => ipcRenderer.invoke('ui:notify'),
  setNotify: (on: boolean): Promise<boolean> => ipcRenderer.invoke('ui:setNotify', on),

  /**
   * Show one now, whatever the switch says and whoever has focus.
   *
   * The switch above turns them off; it cannot tell you whether they were ever
   * arriving. On macOS they are refused per-app in System Settings, and a
   * refused notification is indistinguishable from one nobody sent.
   */
  notifyTest: (): Promise<{ ok?: true; error?: string }> => ipcRenderer.invoke('ui:notifyTest'),
  /** A notification was clicked: show this tab, and this agent if it names one. */
  onGoto: (fn: (tab: string, id: string | null) => void) => on('ui:goto', fn)
}

contextBridge.exposeInMainWorld('bullpen', api)

export type BullpenApi = typeof api
