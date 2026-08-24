/**
 * Boot `src/main/index.ts` outside Electron.
 *
 * Everything main is wired to lives behind three imports it cannot have here:
 * `electron`, `node-pty`, and a `?raw` markdown import only Vite resolves. All
 * three are replaced with the smallest thing that behaves - a recorder for the
 * IPC surface, a pty that is a script rather than a process, and the rules file
 * read off disk. What is left is main's own logic, driven directly.
 *
 * Written because that logic had no test at all: the roster, the report loop,
 * the approvals queue and the shell lifecycle are all wired together in one
 * 2300-line module, and every bug found in it was found by reading.
 */
import { mock } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'


export type FakePty = {
  id: string
  cmd: string
  args: string[]
  cwd: string
  pid: number
  killed: boolean
  written: string[]
  /** Push output as if the process had printed it. */
  say(chunk: string): void
  /** End it, as a crash or a kill would. */
  exit(code?: number): void
}

export type Hook = {
  /** POST a lifecycle event, the way an agent's own hook script does. */
  event(payload: Record<string, unknown>): Promise<void>
  /** POST a PreToolUse call and get main's verdict back. */
  ask(payload: Record<string, unknown>): Promise<{ permissionDecision: string; permissionDecisionReason: string }>
}

export type Main = {
  /** Call an `ipcMain.handle` channel the way the renderer would. */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  /** Call an `ipcMain.on` channel. */
  send(channel: string, ...args: unknown[]): void
  /** Every message main pushed at the renderer, in order. */
  pushed: { channel: string; args: unknown[] }[]
  /** The last payload on a channel, or undefined. */
  last(channel: string): unknown[] | undefined
  ptys: Map<string, FakePty>
  /** The pty for an id, waiting briefly for a spawn still in flight. */
  pty(id: string): FakePty
  channels: string[]
  /** The hook endpoints main installed for one agent, as its CLI would use them. */
  hook(id: string): Hook
  stop(): Promise<void>
}

export async function bootMain(home: string): Promise<Main> {
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const listeners = new Map<string, (...a: unknown[]) => unknown>()
  const pushed: { channel: string; args: unknown[] }[] = []
  const ptys = new Map<string, FakePty>()
  let pid = 4000

  const fakeSpawn = (cmd: string, args: string[], opts: { cwd: string }): unknown => {
    const data: ((c: string) => void)[] = []
    const exits: ((e: { exitCode: number }) => void)[] = []
    const id = String(args[args.indexOf('--settings') + 1] ?? cmd)
    const p: FakePty = {
      id,
      cmd,
      args,
      cwd: opts.cwd,
      pid: ++pid,
      killed: false,
      written: [],
      say: (chunk) => data.forEach((f) => f(chunk)),
      exit: (code = 0) => exits.forEach((f) => f({ exitCode: code }))
    }
    const pty = {
      pid: p.pid,
      onData: (f: (c: string) => void) => data.push(f),
      onExit: (f: (e: { exitCode: number }) => void) => exits.push(f),
      write: (d: string) => p.written.push(d),
      resize: () => {},
      kill: () => {
        p.killed = true
        p.exit(0)
      }
    }
    // Keyed by the agent id main spawned it under, which is the last thing it
    // puts in BULLPEN_AGENT_ID.
    const agentId = (opts as { env?: Record<string, string> }).env?.BULLPEN_AGENT_ID ?? id
    p.id = agentId
    ptys.set(agentId, p)
    return pty
  }

  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((r) => (resolveReady = r))

  const win = {
    isDestroyed: () => false,
    isFocused: () => true,
    maximize: () => {},
    minimize: () => {},
    close: () => {},
    isMaximized: () => false,
    getNormalBounds: () => ({ x: 0, y: 0, width: 1700, height: 1000 }),
    setFullScreen: () => {},
    isFullScreen: () => false,
    loadFile: () => {},
    loadURL: () => {},
    on: () => {},
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, ...args: unknown[]) => pushed.push({ channel, args }),
      setWindowOpenHandler: () => {},
      on: () => {},
      getURL: () => 'file:///index.html'
    }
  }

  mock.module('electron', {
    namedExports: {
      app: {
        isPackaged: true,
        getPath: () => home,
        setName: () => {},
        whenReady: () => ready,
        on: () => {},
        quit: () => {},
        dock: undefined
      },
      ipcMain: {
        handle: (c: string, f: (...a: unknown[]) => unknown) => handlers.set(c, f),
        on: (c: string, f: (...a: unknown[]) => unknown) => listeners.set(c, f)
      },
      BrowserWindow: Object.assign(function () {
        return win
      }, { getAllWindows: () => [win] }),
      // `showMessageBox` answers with the default button, which is what a
      // person clicking through would do. Absent, `ui:unsaved` threw rather
      // than returning - a channel the harness could not reach at all.
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showMessageBox: async () => ({ response: 0 })
      },
      Notification: { isSupported: () => false },
      screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
      shell: { openExternal: () => {} },
      // No keyring under a test runner. `secret.ts` says so out loud rather
      // than pretending, and writes the token plainly - which is what a machine
      // without a keyring does too.
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (s: string) => Buffer.from(s, 'utf8'),
        decryptString: (b: Buffer) => b.toString('utf8')
      }
    }
  })
  mock.module('node-pty', { namedExports: { spawn: fakeSpawn } })

  process.env.BULLPEN_HOME = home
  await import('../src/main/index.ts')
  resolveReady()
  // Startup is async - approvals binds a port before `wire()` runs.
  for (let i = 0; i < 200 && !handlers.has('agent:kill'); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }

  const invoke = async <T,>(channel: string, ...args: unknown[]): Promise<T> => {
    const f = handlers.get(channel)
    if (!f) throw new Error(`no handler for "${channel}"`)
    return (await f({}, ...args)) as T
  }

  return {
    invoke,
    send: (channel, ...args) => {
      const f = listeners.get(channel)
      if (!f) throw new Error(`no listener for "${channel}"`)
      f({}, ...args)
    },
    pushed,
    last: (channel) => [...pushed].reverse().find((p) => p.channel === channel)?.args,
    ptys,
    pty: (id) => {
      const p = ptys.get(id)
      if (!p) throw new Error(`no pty for "${id}" - have ${[...ptys.keys()].join(', ')}`)
      return p
    },
    channels: [...handlers.keys()],
    hook: (id) => {
      const settings = JSON.parse(
        readFileSync(join(home, 'agents', id, 'settings.json'), 'utf8')
      ) as { env: { BULLPEN_APPROVALS_URL: string; BULLPEN_EVENT_URL: string } }
      const post = async (url: string, payload: Record<string, unknown>): Promise<Response> =>
        fetch(url, { method: 'POST', body: JSON.stringify(payload) })
      return {
        event: async (payload) => {
          await post(settings.env.BULLPEN_EVENT_URL, payload)
          // The reply is sent before the handler has finished emitting.
          await new Promise((r) => setTimeout(r, 20))
        },
        ask: async (payload) => {
          const res = await post(settings.env.BULLPEN_APPROVALS_URL, {
            hook_event_name: 'PreToolUse',
            ...payload
          })
          const body = (await res.json()) as {
            hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string }
          }
          return body.hookSpecificOutput
        }
      }
    },
    stop: async () => {
      for (const p of ptys.values()) if (!p.killed) p.exit(0)
      // main's own shutdown, reached the way a real one is: it closes the
      // approvals socket and stops the router and board timers, without which
      // the test process never exits.
      process.emit('SIGTERM')
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}
