import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'

/**
 * Whether there is a newer version of this app, and getting it.
 *
 * `electron-updater` against the `latest*.yml` electron-builder publishes to
 * GitHub Releases: it compares versions, downloads the artifact for this
 * platform, checks the sha512 the release was published with, and hands the
 * result to the platform's installer. Nothing here re-implements any of that -
 * this is the state the UI shows and the three buttons it offers.
 *
 * The whole thing is off in a dev run. An unpackaged app has no
 * `app-update.yml` in its resources, and asking `autoUpdater` anything without
 * one throws rather than answering.
 */

/** What the UI is showing, and what it may do next. */
export type UpdateState =
  /** Not packaged, so there is nothing to update. */
  | { kind: 'dev'; version: string }
  | { kind: 'idle'; version: string; checkedAt?: number }
  | { kind: 'checking'; version: string }
  | { kind: 'available'; version: string; next: string; notes?: string }
  | { kind: 'downloading'; version: string; next: string; percent: number }
  | { kind: 'ready'; version: string; next: string }
  /**
   * A new version exists and this copy cannot install it in place.
   *
   * macOS hands the install to Squirrel, which refuses an application it cannot
   * read a code signature from - which is every build made without a Developer
   * ID. Reported rather than attempted: a button that always fails is worse
   * than one that says what it can do, which is open the page to download it.
   */
  | { kind: 'manual'; version: string; next: string; url: string; why: string }
  | { kind: 'error'; version: string; message: string }

/** Where a human goes when the app cannot install for itself. */
const RELEASES = 'https://github.com/TuqL3/BullPen/releases/latest'

/**
 * Is this copy signed well enough for macOS to replace it with another?
 *
 * `codesign -dv` is the same question Squirrel asks, asked before the download
 * rather than after it. Anything that is not darwin is not Squirrel's business
 * and answers yes: NSIS on Windows replaces an unsigned install happily.
 */
export function canInstallInPlace(
  platform: string,
  appPath: string,
  run: (cmd: string, args: string[]) => Promise<boolean>
): Promise<boolean> {
  if (platform !== 'darwin') return Promise.resolve(true)
  return run('codesign', ['-dv', '--verbose=2', appPath])
}

const ok = (cmd: string, args: string[]): Promise<boolean> =>
  new Promise((done) => execFile(cmd, args, (err) => done(!err)))

/**
 * Compare two versions the way the updater does, for the things around it.
 *
 * `electron-updater` decides what is newer for itself; this is here for the UI
 * and the tests, which need to say "1.1.0 is newer than 1.0.0" without asking a
 * module that only loads inside Electron. Pre-release tags are compared as
 * strings after the numbers, which is enough for `1.1.0-beta.1` to sort under
 * `1.1.0` and above `1.0.9`.
 */
export function isNewer(next: string, current: string): boolean {
  const parts = (v: string): { nums: number[]; pre: string } => {
    const [main = '', pre = ''] = v.replace(/^v/, '').split('-')
    return { nums: main.split('.').map((n) => Number(n) || 0), pre }
  }
  const a = parts(next)
  const b = parts(current)
  for (let i = 0; i < 3; i++) {
    const x = a.nums[i] ?? 0
    const y = b.nums[i] ?? 0
    if (x !== y) return x > y
  }
  // Same numbers: a release beats a pre-release of itself, and two
  // pre-releases go in the order their tags do.
  if (a.pre === b.pre) return false
  if (!a.pre) return true
  if (!b.pre) return false
  return a.pre > b.pre
}

type Electron = {
  app: { isPackaged: boolean; getVersion(): string; getAppPath(): string }
  autoUpdater: {
    autoDownload: boolean
    autoInstallOnAppQuit: boolean
    logger: unknown
    checkForUpdates(): Promise<unknown>
    downloadUpdate(): Promise<unknown>
    quitAndInstall(): void
    on(event: string, fn: (...args: never[]) => void): void
  }
}

/**
 * The updater, as the rest of the app sees it: a state and three verbs.
 *
 * Every change is announced on `state`, so the window can be told once and
 * follow along rather than polling something that is idle nine times in ten.
 */
export class Updates extends EventEmitter {
  private state: UpdateState
  private el: Electron | null
  private timer: NodeJS.Timeout | null = null
  /** The delayed first check. Held so `stop()` can take it back too. */
  private first: NodeJS.Timeout | null = null
  /** Announced once per version, so a six-hour check is not a six-hour alarm. */
  private told = ''

  constructor(version: string) {
    super()
    this.el = null
    // Nothing to update until something hands over an updater, which only a
    // packaged app does.
    this.state = { kind: 'dev', version }
  }

  /**
   * Hand it the packaged app's `autoUpdater`.
   *
   * Separate from the constructor because `electron-updater` is imported
   * lazily: it is a CommonJS module that pulls in Electron at load, and main is
   * loaded by tests that have no Electron to pull in. Unpackaged, this is never
   * called and every verb below is a no-op.
   */
  attach(el: Electron): void {
    if (!el.app.isPackaged) return
    this.el = el
    this.set({ kind: 'idle', version: this.state.version })
  }

  get(): UpdateState {
    return this.state
  }

  private set(next: UpdateState): void {
    this.state = next
    this.emit('state', next)
  }

  /**
   * Start listening, check once, and keep checking.
   *
   * The first check is delayed: launch is already spawning agents, reading the
   * floor and painting a window, and a release feed is not what any of that is
   * waiting on.
   */
  start(firstMs = 8_000, everyMs = 6 * 60 * 60 * 1000): void {
    const el = this.el
    if (!el) return
    el.autoUpdater.logger = null
    // The download is a decision, not a side effect of looking: the UI offers
    // it and the operator takes it.
    el.autoUpdater.autoDownload = false
    // And installing is a second one. A download that installs itself the next
    // time the app is quit is an app that changed while nobody was looking.
    el.autoUpdater.autoInstallOnAppQuit = false

    el.autoUpdater.on('update-available', (info: never) => {
      const next = (info as { version?: string }).version ?? ''
      const notes = (info as { releaseNotes?: string }).releaseNotes
      void this.offer(next, typeof notes === 'string' ? notes : undefined)
    })
    el.autoUpdater.on('update-not-available', () => {
      this.set({ kind: 'idle', version: this.state.version, checkedAt: Date.now() })
    })
    el.autoUpdater.on('download-progress', (p: never) => {
      const percent = Math.round((p as { percent?: number }).percent ?? 0)
      const next = 'next' in this.state ? this.state.next : ''
      this.set({ kind: 'downloading', version: this.state.version, next, percent })
    })
    el.autoUpdater.on('update-downloaded', () => {
      const next = 'next' in this.state ? this.state.next : ''
      this.set({ kind: 'ready', version: this.state.version, next })
    })
    el.autoUpdater.on('error', (err: never) => {
      this.set({
        kind: 'error',
        version: this.state.version,
        message: (err as Error)?.message ?? String(err)
      })
    })

    this.first = setTimeout(() => void this.check(), firstMs)
    this.timer = setInterval(() => void this.check(), everyMs)
  }

  /** Ask the feed. Safe to call from a button and from the timer. */
  async check(): Promise<UpdateState> {
    const el = this.el
    if (!el) return this.state
    // Not while something is already happening to this copy of the app.
    if (this.state.kind === 'downloading' || this.state.kind === 'ready') return this.state
    this.set({ kind: 'checking', version: this.state.version })
    try {
      await el.autoUpdater.checkForUpdates()
    } catch (err) {
      this.set({
        kind: 'error',
        version: this.state.version,
        message: err instanceof Error ? err.message : String(err)
      })
    }
    return this.state
  }

  /** A new version exists: say so, once, and say what can be done about it. */
  private async offer(next: string, notes?: string): Promise<void> {
    const el = this.el
    if (!el) return
    const version = this.state.version
    const installable = await canInstallInPlace(process.platform, el.app.getAppPath(), ok)
    this.set(
      installable
        ? { kind: 'available', version, next, notes }
        : {
            kind: 'manual',
            version,
            next,
            url: RELEASES,
            why: 'this build is not signed, so macOS will not let it replace itself'
          }
    )
    if (this.told !== next) {
      this.told = next
      this.emit('found', next, installable)
    }
  }

  /** Fetch it. The state carries the percentage while this runs. */
  async download(): Promise<UpdateState> {
    const el = this.el
    if (!el || this.state.kind !== 'available') return this.state
    this.set({ kind: 'downloading', version: this.state.version, next: this.state.next, percent: 0 })
    try {
      await el.autoUpdater.downloadUpdate()
    } catch (err) {
      this.set({
        kind: 'error',
        version: this.state.version,
        message: err instanceof Error ? err.message : String(err)
      })
    }
    return this.state
  }

  /**
   * Quit, install, come back on the new version.
   *
   * Everything running dies with the app - which on this floor is every agent -
   * so the renderer asks first. This is the yes.
   */
  install(): boolean {
    const el = this.el
    if (!el || this.state.kind !== 'ready') return false
    el.autoUpdater.quitAndInstall()
    return true
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.first) clearTimeout(this.first)
    this.timer = null
    this.first = null
  }
}
