import { EventEmitter } from 'node:events'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'

/** What an outside system posted in, after it has been made sense of. */
export type Incoming = {
  /** Agent id to hand it to. Absent means "whoever the floor decides". */
  to?: string
  /** Which project it belongs to, when the sender knows: a repo name, usually. */
  project?: string
  subject: string
  body: string
  /** Who sent it, for the log: a header, or the user agent, or 'webhook'. */
  from: string
}

/** Bodies larger than this are refused unread: this is a task, not an upload. */
export const MAX_BODY = 64 * 1024

/** Fields a sender might reasonably have called the text, in the order tried. */
const TEXT_KEYS = ['body', 'text', 'message', 'task', 'prompt', 'content']
const TITLE_KEYS = ['subject', 'title', 'headline', 'name', 'action', 'event']
/** What a sender might call the project. A GitHub payload carries `repository`. */
const PROJECT_KEYS = ['project', 'repo', 'repository', 'service', 'app']

/**
 * One inbound door, bolted shut by default.
 *
 * Everything else in Bullpen is outbound or local; this is the only thing that
 * lets an outside system start work, so it is deliberately the least trusting
 * component here: bound to 127.0.0.1 and nothing else, a token compared in
 * constant time, a hard body cap checked as bytes arrive.
 *
 * Inside those limits it is as forgiving as it can be, because the alternative
 * is a shim script per sender. Plain text is a task. A form post is a task.
 * Somebody else's webhook payload - GitHub, Sentry, an uptime monitor - is a
 * task, summarised rather than rejected for not being our shape. It parses and
 * emits; what to do with a task is main's decision, not this file's.
 */
export class Webhooks extends EventEmitter {
  private server: Server | null = null
  private tokenBuf: Buffer = Buffer.alloc(0)

  /** The port it is actually listening on, which may not be the one asked for. */
  port = 0

  get running(): boolean {
    return this.server !== null
  }

  async start(port: number, token: string): Promise<number> {
    if (this.server) await this.stop()
    this.tokenBuf = Buffer.from(token)
    const server = createServer((req, res) => {
      const reply = (code: number, msg: string): void => {
        res.writeHead(code, { 'content-type': 'text/plain' })
        res.end(msg)
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      // A GET on the root is a person checking they typed the port right.
      if (req.method === 'GET' && url.pathname === '/') {
        return reply(200, 'bullpen webhook. POST /task with a token header and any body.')
      }
      if (req.method !== 'POST' || !url.pathname.startsWith('/task')) {
        return reply(404, 'POST /task only')
      }
      if (!this.ok(tokenOf(req))) {
        this.emit('refused', { from: sourceOf(req), why: 'bad token' })
        return reply(401, 'set x-bullpen-token (or Authorization: Bearer) to the token in Bullpen')
      }

      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => {
        size += c.length
        // Stopped mid-stream: reading a gigabyte to then reject it is the same
        // as accepting it, for anything that matters here.
        if (size > MAX_BODY) {
          reply(413, `bodies over ${MAX_BODY} bytes are refused`)
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        if (size > MAX_BODY) return
        const task = read(req, url, Buffer.concat(chunks).toString('utf8'))
        if (!task) {
          this.emit('refused', { from: sourceOf(req), why: 'empty body' })
          return reply(400, 'send something to do: a line of text, or json with a body field')
        }
        this.emit('task', task)
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ accepted: true, to: task.to ?? null, subject: task.subject }))
      })
    })
    this.server = server
    return new Promise<number>((resolve, reject) => {
      server.once('error', (err) => {
        this.server = null
        reject(err)
      })
      // Loopback only. Not a setting: a setting is a thing someone turns on by
      // accident, and this one puts a task queue on the network.
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address()
        this.port = typeof addr === 'object' && addr ? addr.port : port
        resolve(this.port)
      })
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = 0
    if (!server) return
    await new Promise<void>((done) => server.close(() => done()))
  }

  /** Constant time, and length-safe: `timingSafeEqual` throws on a mismatch. */
  private ok(given: string): boolean {
    const a = Buffer.from(given)
    if (a.length !== this.tokenBuf.length || a.length === 0) return false
    return timingSafeEqual(a, this.tokenBuf)
  }
}

/** A token nobody chose. 24 bytes of urandom, hex, so it survives a copy-paste. */
export const newToken = (): string => randomBytes(24).toString('hex')

/**
 * The token, from wherever the sender could put it.
 *
 * Two headers, because half the systems that post webhooks can set a custom
 * header and the other half can only set `Authorization`. Not the query
 * string: URLs end up in access logs and shell history.
 */
function tokenOf(req: IncomingMessage): string {
  const own = req.headers['x-bullpen-token']
  if (typeof own === 'string') return own.trim()
  const auth = req.headers.authorization
  if (typeof auth === 'string' && /^bearer /i.test(auth)) return auth.slice(7).trim()
  return ''
}

/** A name for the sender: what it says it is, else what its user agent says. */
function sourceOf(req: IncomingMessage): string {
  const said = req.headers['x-bullpen-from']
  if (typeof said === 'string' && said.trim()) return said.trim().slice(0, 40)
  const ua = req.headers['user-agent']
  if (typeof ua === 'string' && ua.trim()) return ua.split('/')[0].trim().slice(0, 40)
  return 'webhook'
}

/**
 * Make a task out of whatever arrived.
 *
 * `/task/morgan` addresses an agent without any JSON at all, which is what
 * makes this usable from a system that can only be given a URL.
 */
function read(req: IncomingMessage, url: URL, raw: string): Incoming | null {
  const from = sourceOf(req)
  const inPath = url.pathname.replace(/^\/task\/?/, '').trim()
  const header = req.headers['x-bullpen-to']
  const to =
    (typeof header === 'string' && header.trim()) || decodeURIComponent(inPath) || undefined
  const type = String(req.headers['content-type'] ?? '').toLowerCase()
  const saidProject = req.headers['x-bullpen-project']
  const headerProject = typeof saidProject === 'string' ? saidProject.trim() : ''

  const done = (body: string, subject?: string, project?: string): Incoming | null => {
    const text = body.trim()
    if (!text) return null
    return {
      to: to || undefined,
      project: (project || headerProject).trim().slice(0, 60) || undefined,
      subject: (subject ?? '').trim().slice(0, 120) || firstLine(text),
      body: text.slice(0, MAX_BODY),
      from
    }
  }

  if (type.includes('application/json')) {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      // Malformed json is still a sender trying to say something; the raw text
      // is more use to an agent than a 400 nobody sees.
      return done(raw)
    }
    if (json && typeof json === 'object') {
      const rec = json as Record<string, unknown>
      const pick = (keys: string[]): string => {
        for (const k of keys) if (typeof rec[k] === 'string' && rec[k].trim()) return rec[k].trim()
        return ''
      }
      const text = pick(TEXT_KEYS)
      const subject = pick(TITLE_KEYS)
      const target = typeof rec.to === 'string' && rec.to.trim() ? rec.to.trim() : to
      // `repository` in a GitHub payload is an object; its `name` is the project.
      const repo = rec.repository
      const nested =
        repo && typeof repo === 'object' && typeof (repo as Record<string, unknown>).name === 'string'
          ? ((repo as Record<string, unknown>).name as string)
          : ''
      const body = text || summarise(rec)
      const made = done(body, subject, pick(PROJECT_KEYS) || nested)
      return made ? { ...made, to: target || undefined } : null
    }
    return done(raw)
  }

  if (type.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(raw)
    for (const k of TEXT_KEYS) {
      const v = form.get(k)
      if (v?.trim()) return done(v, form.get('subject') ?? undefined)
    }
    return done(raw)
  }

  // Anything else - text/plain, no content type at all - is the task itself.
  return done(raw)
}

/**
 * Someone else's payload, in a form an agent can act on.
 *
 * A GitHub push or a Sentry alert has no field called `body`; refusing it would
 * mean a translator script per sender. The top-level scalars are what carry the
 * meaning, so they go in as a list and the whole payload follows.
 */
function summarise(rec: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(rec)) {
    if (lines.length >= 12) break
    if (v === null || typeof v === 'object') continue
    lines.push(`${k}: ${String(v).slice(0, 200)}`)
  }
  const json = JSON.stringify(rec, null, 2)
  const tail = json.length > 4000 ? `${json.slice(0, 4000)}\n… (truncated)` : json
  return `${lines.join('\n')}\n\nfull payload:\n${tail}`.trim()
}

/** A subject when the sender gave none: the first line, shortened. */
function firstLine(text: string): string {
  const line = text.split('\n')[0].trim()
  return line.length > 80 ? `${line.slice(0, 77)}…` : line || 'webhook'
}
