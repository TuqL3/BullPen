import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID, randomBytes } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'

export type HookPayload = {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_use_id?: string
}

export type Verdict = 'allow' | 'ask' | 'deny'

export type Pending = {
  id: string
  agentId: string
  toolName: string
  detail: string
  reason: string
  payload: HookPayload
  createdAt: number
}

/**
 * Commands that must never run unattended. Matching only escalates to a human;
 * it is a speed bump, not a sandbox — see SECURITY in README.
 */
const DANGEROUS_BASH: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-zA-Z]*[rf]|--recursive|--force)/, 'recursive/forced delete'],
  [/\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b)/, 'force push'],
  [/\bgit\s+reset\s+--hard\b/, 'hard reset discards work'],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'git clean deletes untracked files'],
  [/\bgit\s+remote\s+(set-url|add)\b/, 'changes where code is pushed'],
  [/\bdd\b[^|;&]*\bof=/, 'raw disk write'],
  [/\bmkfs(\.|\b)/, 'formats a filesystem'],
  [/>\s*\/dev\/(sd|nvme|disk)/, 'raw device write'],
  [/\b(shutdown|reboot|halt)\b/, 'powers off the machine'],
  [/\bsudo\b|\bdoas\b|(^|\s)su\s/, 'privilege escalation'],
  [/\bchmod\s+(-R\s+)?[0-7]*777/, 'world-writable permissions'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(ba|z|k|fi)?sh/, 'pipes network content into a shell'],
  [/:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, 'fork bomb'],
  [/\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/, 'publishes a package'],
  [/\bgh\s+(release\s+create|repo\s+delete|pr\s+merge)\b/, 'public GitHub side effect'],
  [/\bdocker\s+(system\s+prune|volume\s+rm)\b/, 'destroys container data'],
  [/\bhistory\s+-c\b|\bunset\s+HISTFILE\b/, 'covers its own tracks'],
  [/\bkill(all)?\s+.*\b(bullpen|electron)\b/, 'targets the supervisor itself']
]

/** Paths that hold credentials. Reading them is the first half of exfiltration. */
const SECRET_PATHS = [
  /\.ssh(\/|\\)/,
  /\.aws(\/|\\)/,
  /\.gnupg(\/|\\)/,
  /\.kube(\/|\\)/,
  /(^|\/|\\)\.env(\.|$)/,
  /id_(rsa|ed25519|ecdsa)/,
  /(^|\/|\\)credentials(\.json)?$/,
  /\.netrc$/,
  /Keychains(\/|\\)/,
  /\.claude(\/|\\).*\.credentials/
]

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const

/** Which lifecycle hooks mean the agent started or finished a turn. */
const LIFECYCLE_STATUS: Record<string, 'working' | 'idle' | undefined> = {
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  Stop: 'idle',
  SessionEnd: 'idle'
}

export class Approvals extends EventEmitter {
  readonly root: string
  readonly token: string
  private server: Server | null = null
  private port = 0
  private pending = new Map<string, { p: Pending; resolve: (v: 'allow' | 'deny') => void }>()
  /** agentId -> absolute sandbox dir the agent may touch freely */
  private sandboxes = new Map<string, string>()
  /** agentId -> steer notes waiting to ride out on the next hook reply */
  private steers = new Map<string, string[]>()

  constructor(root: string) {
    super()
    this.root = resolve(root)
    this.token = randomBytes(24).toString('hex')
    mkdirSync(this.root, { recursive: true })
  }

  setSandbox(agentId: string, dir: string): void {
    this.sandboxes.set(agentId, resolve(dir))
  }

  listPending(): Pending[] {
    return [...this.pending.values()].map((e) => e.p)
  }

  /**
   * Queue a note to be handed to a working agent as conversation context.
   *
   * Typing into the pty is the wrong tool while an agent is mid-turn: the text
   * lands in the middle of its work. A PreToolUse hook may return
   * `additionalContext`, so a steer rides out on the agent's next tool call
   * instead - no keystrokes, no interruption.
   *
   * Consequence worth knowing: an agent that makes no further tool calls never
   * collects it. Steering is for a busy agent; an idle one should just be sent
   * a message.
   */
  steer(agentId: string, note: string): void {
    const text = note.trim()
    if (!text) return
    const list = this.steers.get(agentId) ?? []
    list.push(text)
    this.steers.set(agentId, list)
    this.emit('steer-queued', agentId, text, list.length)
  }

  pendingSteers(agentId: string): string[] {
    return [...(this.steers.get(agentId) ?? [])]
  }

  /** Take everything queued for this agent, formatted for the hook reply. */
  private drainSteers(agentId: string): string {
    const list = this.steers.get(agentId)
    if (!list?.length) return ''
    this.steers.delete(agentId)
    this.emit('steer-delivered', agentId, list)
    return list.map((n) => `[steer from your operator] ${n}`).join('\n')
  }

  /** Resolve a queued request. Unknown id is a no-op. */
  decide(id: string, decision: 'allow' | 'deny'): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    entry.resolve(decision)
    this.emit('resolved', entry.p, decision)
  }

  /**
   * Classify a tool call. 'deny' is reserved for the agent attacking its own
   * leash — that is never a question worth asking a human at 3am.
   */
  classify(agentId: string, payload: HookPayload): { verdict: Verdict; reason: string } {
    const tool = payload.tool_name ?? ''
    const input = payload.tool_input ?? {}

    // Self-protection: nothing may touch Bullpen's own control plane.
    const touched = this.touchedPaths(input)
    for (const p of touched) {
      if (this.isInside(this.root, p)) {
        return { verdict: 'deny', reason: 'writes to Bullpen control files (hook/settings/queue)' }
      }
    }
    const bash = typeof input.command === 'string' ? input.command : ''
    if (bash && this.mentionsControlPlane(bash)) {
      return { verdict: 'deny', reason: 'shell command targets Bullpen control files' }
    }

    if (bash) {
      for (const [re, why] of DANGEROUS_BASH) {
        if (re.test(bash)) return { verdict: 'ask', reason: why }
      }
    }

    for (const p of touched) {
      if (SECRET_PATHS.some((re) => re.test(p))) {
        return { verdict: 'ask', reason: 'touches a credential path' }
      }
      const sandbox = this.sandboxes.get(agentId)
      const writing = tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit'
      if (writing && sandbox && !this.isInside(sandbox, p)) {
        return { verdict: 'ask', reason: `writes outside sandbox (${sandbox})` }
      }
    }
    if (bash && SECRET_PATHS.some((re) => re.test(bash))) {
      return { verdict: 'ask', reason: 'shell command references a credential path' }
    }

    return { verdict: 'allow', reason: '' }
  }

  start(host = '127.0.0.1'): Promise<number> {
    return new Promise((res, rej) => {
      const server = createServer((req, reply) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        // Loopback-only bind plus a per-run token: another local process cannot
        // forge decisions even if it guesses the port.
        const known = url.pathname === '/hook' || url.pathname === '/event'
        if (req.method !== 'POST' || !known || url.searchParams.get('token') !== this.token) {
          reply.writeHead(404).end()
          return
        }
        const agentId = url.searchParams.get('agent') ?? 'unknown'
        let body = ''
        req.setEncoding('utf8')

        // Lifecycle events are observation only. They never block the agent, so
        // they answer immediately and parse afterwards.
        if (url.pathname === '/event') {
          reply.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
          req.on('data', (c) => {
            body += c
            if (body.length > 1_000_000) req.destroy()
          })
          req.on('end', () => this.onLifecycle(agentId, body))
          return
        }

        req.on('data', (c) => {
          body += c
          if (body.length > 4_000_000) req.destroy()
        })
        req.on('end', async () => {
          let payload: HookPayload
          try {
            payload = JSON.parse(body)
          } catch {
            this.reply(reply, 'deny', 'Bullpen could not parse the hook payload')
            return
          }
          const { verdict, reason } = this.classify(agentId, payload)
          // Steers ride out on whichever tool call comes next, but only when it
          // is actually allowed to run - a denied call is not a delivery.
          if (verdict === 'allow') return this.reply(reply, 'allow', '', this.drainSteers(agentId))
          if (verdict === 'deny') return this.reply(reply, 'deny', `Bullpen: ${reason}`)

          const decision = await this.ask(agentId, payload, reason)
          this.reply(
            reply,
            decision,
            decision === 'deny' ? `Bullpen: human denied (${reason})` : '',
            decision === 'allow' ? this.drainSteers(agentId) : ''
          )
        })
      })
      server.on('error', rej)
      server.listen(0, host, () => {
        const addr = server.address()
        this.port = typeof addr === 'object' && addr ? addr.port : 0
        this.server = server
        res(this.port)
      })
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
    // Anything still waiting must not hang the agent forever.
    for (const [id] of this.pending) this.decide(id, 'deny')
  }

  /**
   * Write the per-agent hook + settings file. Lives under Bullpen's own root,
   * NOT in the user's ~/.claude — a bug here must never corrupt the real config.
   */
  installHook(agentId: string, agentDir: string, matcher = '*'): string {
    if (!this.port) throw new Error('Approvals.start() must run before installHook()')
    mkdirSync(agentDir, { recursive: true })
    const hookPath = join(this.root, 'hook.mjs')
    writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o700 })

    const eventPath = join(this.root, 'event.mjs')
    writeFileSync(eventPath, EVENT_SCRIPT, { mode: 0o700 })

    const q = `token=${this.token}&agent=${encodeURIComponent(agentId)}`
    const url = `http://127.0.0.1:${this.port}/hook?${q}`
    const eventUrl = `http://127.0.0.1:${this.port}/event?${q}`

    // Observation only, so they get their own short-timeout script that can
    // never block a turn - unlike the PreToolUse hook, which must.
    const observe = (): unknown => ({
      hooks: [{ type: 'command', command: `node ${JSON.stringify(eventPath)}`, timeout: 10 }]
    })

    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher,
            hooks: [
              {
                type: 'command',
                command: `node ${JSON.stringify(hookPath)}`,
                timeout: 600
              }
            ]
          }
        ],
        UserPromptSubmit: [observe()],
        Stop: [observe()],
        SessionEnd: [observe()]
      },
      env: { BULLPEN_APPROVALS_URL: url, BULLPEN_EVENT_URL: eventUrl }
    }
    const settingsPath = join(agentDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 })
    return settingsPath
  }

  /**
   * Map a Claude Code lifecycle hook onto a busy/idle status.
   *
   * This replaces scraping the TUI, which was measured and rejected: output
   * gaps of ~5s occur mid-turn while the model thinks, so "quiet means idle"
   * reports false idles, and the on-screen working indicator moves between CLI
   * versions. The hook payload is structured and emitted by the CLI itself.
   */
  private onLifecycle(agentId: string, body: string): void {
    let event = ''
    try {
      event = (JSON.parse(body) as HookPayload).hook_event_name ?? ''
    } catch {
      return
    }
    const status = LIFECYCLE_STATUS[event]
    if (status) this.emit('status', agentId, status, event)
  }

  private ask(agentId: string, payload: HookPayload, reason: string): Promise<'allow' | 'deny'> {
    return new Promise((res) => {
      const p: Pending = {
        id: randomUUID(),
        agentId,
        toolName: payload.tool_name ?? '?',
        detail: this.describe(payload),
        reason,
        payload,
        createdAt: Date.now()
      }
      this.pending.set(p.id, { p, resolve: res })
      this.emit('pending', p)
    })
  }

  private reply(
    reply: import('node:http').ServerResponse,
    decision: 'allow' | 'deny',
    why: string,
    additionalContext = ''
  ): void {
    // Compact, key order fixed: the hook script greps this string to decide its
    // exit code, so do not pretty-print it.
    const out = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: why
      },
      ...(additionalContext ? { additionalContext } : {})
    })
    reply.writeHead(200, { 'Content-Type': 'application/json' }).end(out)
  }

  private describe(payload: HookPayload): string {
    const i = payload.tool_input ?? {}
    if (typeof i.command === 'string') return i.command
    for (const k of PATH_KEYS) if (typeof i[k] === 'string') return i[k] as string
    return JSON.stringify(i).slice(0, 500)
  }

  private touchedPaths(input: Record<string, unknown>): string[] {
    const out: string[] = []
    for (const k of PATH_KEYS) {
      const v = input[k]
      if (typeof v === 'string' && v.length) out.push(v)
    }
    return out
  }

  private mentionsControlPlane(command: string): boolean {
    return command.includes(this.root)
  }

  private isInside(parent: string, child: string): boolean {
    const abs = isAbsolute(child) ? resolve(child) : resolve(parent, child)
    const rel = relative(parent, abs)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
}

/**
 * Fail-CLOSED hook. Claude Code treats a timed-out or erroring hook as
 * non-blocking, so an unreachable Bullpen would silently mean "allow
 * everything". This script denies on every failure path instead.
 *
 * Written as .mjs and run with `node` (never bash/jq) so the same file works on
 * macOS, Linux and Windows; any machine running Claude Code already has node.
 */
const HOOK_SCRIPT = `#!/usr/bin/env node
// Generated by Bullpen. Do not edit - regenerated on every agent spawn.
const deny = (reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }))
  process.exit(2) // exit 2 blocks regardless of what the JSON says
}

const main = async () => {
  const url = process.env.BULLPEN_APPROVALS_URL
  if (!url) deny('Bullpen: BULLPEN_APPROVALS_URL missing - failing closed')

  let body = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) body += chunk

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(570000) // under Claude Code's 600s hook timeout
    })
  } catch (err) {
    deny('Bullpen: approvals server unreachable (' + err.message + ') - failing closed')
  }
  if (!res.ok) deny('Bullpen: approvals server returned ' + res.status + ' - failing closed')

  const text = await res.text()
  if (!text.includes('"permissionDecision"')) deny('Bullpen: malformed decision - failing closed')

  process.stdout.write(text)
  process.exit(text.includes('"permissionDecision":"deny"') ? 2 : 0)
}

main().catch((err) => deny('Bullpen: hook crashed (' + err.message + ') - failing closed'))
`

/**
 * Fail-OPEN by design, the exact opposite of the approvals hook.
 *
 * These hooks only report that a turn started or ended. If Bullpen is gone, a
 * missing status badge is the correct outcome; blocking the agent over it would
 * be absurd. Always exits 0, never prints a decision.
 */
const EVENT_SCRIPT = `#!/usr/bin/env node
// Generated by Bullpen. Do not edit - regenerated on every agent spawn.
const main = async () => {
  const url = process.env.BULLPEN_EVENT_URL
  if (!url) return

  let body = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) body += chunk

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(3000)
  })
}

main().catch(() => {}).finally(() => process.exit(0))
`
