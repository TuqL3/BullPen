import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'

/**
 * Whether there is a newer version of this app, and getting it.
 *
 * Two updaters, split by platform, because the two platforms do not have the
 * same problem.
 *
 * **macOS: Sparkle.** Squirrel.Mac - which is what `electron-updater` drives
 * here - refuses to replace an application it cannot read a Developer ID
 * signature from, and this app has never had one. That is the whole reason the
 * old `manual` state existed: a button that could only ever open the download
 * page. Sparkle validates an update by the EdDSA signature on the archive
 * instead of by the app's own code signature, so an ad-hoc signed build updates
 * itself for real. Sparkle also draws its own window for the whole find,
 * download and install sequence, so on macOS the state below never reaches
 * `downloading` or `ready` - the app reads the feed itself (`probe`) only far
 * enough to say that a newer version exists, and hands the click to Sparkle.
 * Without that it says nothing at all, and a feed that 404s or an archive
 * signed by a rotated key look exactly like being up to date.
 *
 * **Windows: electron-updater.** NSIS replaces an unsigned install happily, so
 * there was never a problem to solve. It stays, along with the three-step state
 * the title bar chip renders: there is one, it is coming down, it is ready.
 *
 * The whole thing is off in a dev run. An unpackaged app has neither an
 * `app-update.yml` in its resources nor an `Info.plist` with a feed in it.
 */

/** What the UI is showing, and what it may do next. */
export type UpdateState =
  /** Not packaged, so there is nothing to update. */
  | { kind: 'dev'; version: string }
  /**
   * Nothing to say. On Windows: checked, and this is the newest there is. On
   * macOS: the appcast was read and holds nothing newer than this.
   */
  | { kind: 'idle'; version: string; checkedAt?: number }
  | { kind: 'checking'; version: string }
  /** Both platforms. On macOS the click hands over to Sparkle's window. */
  | { kind: 'available'; version: string; next: string; notes?: string }
  | { kind: 'downloading'; version: string; next: string; percent: number }
  | { kind: 'ready'; version: string; next: string }
  | { kind: 'error'; version: string; message: string }

/** Where a human goes when they want the list rather than the newest. */
const RELEASES = 'https://github.com/TuqL3/BullPen/releases/latest'

/**
 * What `electron-sparkle-updater`'s packaging step writes into `Info.plist`
 * when no key was given, and what the release step is supposed to replace.
 *
 * A build that ships this validates nothing: every appcast signature fails and
 * the app quietly never updates. Checked at startup so it is an error somebody
 * sees rather than an update that silently never arrives.
 */
export const ED_KEY_PLACEHOLDER = 'SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER'

/** The two things Sparkle has to be told before it can check anything. */
export type SparkleFeed = { appcastUrl: string; publicEdKey: string }

/** The native bridge, as `electron-sparkle-updater` hands it over. */
export type SparkleBridge = {
  init(options: SparkleFeed): boolean
  checkForUpdates(): void
  installUpdateNow(): void
  setAutomaticChecks(enabled: boolean): void
}

/**
 * Read one key out of the packaged app's `Info.plist`.
 *
 * The feed URL and the public key are already in there - electron-builder wrote
 * them at pack time and CI replaced the key placeholder - so reading them back
 * is the one way to be sure the app checks against the key it actually shipped
 * with. A second copy compiled in here could disagree with the bundle, and the
 * failure that produces is an app that never updates and never says why.
 *
 * `plutil` ships with macOS. Nothing calls this anywhere else.
 */
export const plistValue = (plist: string, key: string): string | null => {
  try {
    const out = execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out.trim() || null
  } catch {
    // Absent key, unreadable file, or not a plist at all. The caller turns this
    // into a message; there is nothing here worth telling them apart.
    return null
  }
}

/**
 * The feed a packaged macOS build is pointed at, or a reason it has none.
 *
 * Throws rather than returning null so the reason travels with the failure -
 * "no SUFeedURL" and "shipped the placeholder key" are different mistakes made
 * in different steps of the release, and an updater that just says "off" sends
 * whoever is looking to the wrong one.
 */
export function sparkleFeed(read: (key: string) => string | null): SparkleFeed {
  const appcastUrl = read('SUFeedURL')
  if (!appcastUrl) throw new Error('Info.plist has no SUFeedURL')
  const publicEdKey = read('SUPublicEDKey')
  if (!publicEdKey) throw new Error('Info.plist has no SUPublicEDKey')
  if (publicEdKey === ED_KEY_PLACEHOLDER) {
    throw new Error(
      'this build shipped the placeholder EdDSA key - the release step never injected the real one'
    )
  }
  return { appcastUrl, publicEdKey }
}

/**
 * Compare two versions the way the updater does, for the things around it.
 *
 * Both updaters decide what is newer for themselves; this is here for the UI
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

/** As much of `fetch` as the probe uses, so a test can hand over its own. */
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/**
 * The newest version an appcast offers, or '' when it offers none.
 *
 * Read with a regex rather than an XML parser: this is Sparkle's own generated
 * file, the two version tags are the only thing wanted out of it, and a parser
 * is a dependency to read four lines. `shortVersionString` is what the app
 * calls itself, and what `isNewer` can compare - `sparkle:version` is a build
 * number in the general case, and only happens to match here.
 */
export function newestIn(appcast: string): string {
  const items = [...appcast.matchAll(/<sparkle:shortVersionString>([^<]+)</g)].map((m) => m[1].trim())
  return items.reduce((best, v) => (isNewer(v, best) ? v : best), '0.0.0').replace(/^0\.0\.0$/, '')
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
 * Which of the two updaters is behind those verbs is decided by which `attach`
 * main calls, and nothing above this line has to know.
 */
export class Updates extends EventEmitter {
  private state: UpdateState
  private el: Electron | null
  private sparkle: SparkleBridge | null = null
  /** Where Sparkle was pointed, so `probe` can read the same feed it reads. */
  private feed: SparkleFeed | null = null
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

  /** Where the releases live, for a window that wants to open the list. */
  get releasesUrl(): string {
    return RELEASES
  }

  /**
   * Hand it the packaged app's `electron-updater`. Windows.
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

  /**
   * Hand it the Sparkle bridge and the plist it was packaged with. macOS.
   *
   * Returns false and parks in `error` when the bundle cannot say what feed it
   * belongs to. That is a release-pipeline mistake, not a runtime condition -
   * reported rather than retried, because no amount of checking again will put
   * a key into a plist that shipped without one.
   */
  attachSparkle(bridge: SparkleBridge, read: (key: string) => string | null): boolean {
    let feed: SparkleFeed
    try {
      feed = sparkleFeed(read)
    } catch (err) {
      this.fail(err)
      return false
    }
    if (!bridge.init(feed)) {
      this.set({
        kind: 'error',
        version: this.state.version,
        message: 'Sparkle refused the feed it was given'
      })
      return false
    }
    this.sparkle = bridge
    this.feed = feed
    this.set({ kind: 'idle', version: this.state.version })
    return true
  }

  /** Say why there is no updater, when main could not build one. */
  fail(err: unknown): void {
    this.set({
      kind: 'error',
      version: this.state.version,
      message: err instanceof Error ? err.message : String(err)
    })
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
   * On macOS this is one call: Sparkle keeps its own schedule off
   * `SUScheduledCheckInterval` in the plist, in its own process time, and it
   * goes on doing that whether or not anything here is awake.
   *
   * On Windows the first check is delayed: launch is already spawning agents,
   * reading the floor and painting a window, and a release feed is not what any
   * of that is waiting on.
   */
  start(firstMs = 8_000, everyMs = 6 * 60 * 60 * 1000): void {
    if (this.sparkle) {
      this.sparkle.setAutomaticChecks(true)
      // Sparkle finds updates on its own schedule and says nothing here when it
      // does - and nothing at all when the feed 404s or the signature does not
      // validate, because a background check raises no window. So the app reads
      // the same feed itself, purely to have something to show. See `probe`.
      this.first = setTimeout(() => void this.probe(), firstMs)
      this.timer = setInterval(() => void this.probe(), everyMs)
      return
    }
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
      this.offer(next, typeof notes === 'string' ? notes : undefined)
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

  /**
   * Ask the feed. Safe to call from a button and from the timer.
   *
   * On macOS this hands over to Sparkle's own window, which is where the rest
   * of the sequence happens - so the state here does not move, and there is
   * nothing to await.
   */
  async check(): Promise<UpdateState> {
    if (this.sparkle) {
      this.sparkle.checkForUpdates()
      return this.state
    }
    const el = this.el
    if (!el) return this.state
    // Not while something is already happening to this copy of the app.
    if (this.state.kind === 'downloading' || this.state.kind === 'ready') return this.state
    this.set({ kind: 'checking', version: this.state.version })
    try {
      await el.autoUpdater.checkForUpdates()
    } catch (err) {
      this.fail(err)
    }
    return this.state
  }

  /**
   * Read the appcast ourselves, only to have something to say. macOS.
   *
   * Sparkle is still the thing that downloads and installs; this never touches
   * an archive. It exists because every way the macOS updater fails is silent:
   * a feed that 404s (an unpublished release, a private repo) and an archive
   * signed by a key the running app was not built with both leave a background
   * check looking exactly like "you are on the newest there is". Both cost this
   * app seven versions before anyone noticed.
   *
   * A newer version in the feed puts the chip in the title bar and sends the
   * one notification per version `found` carries; clicking either hands over to
   * Sparkle, whose window reports what a background check swallowed.
   */
  async probe(fetchFn: FetchLike = fetch): Promise<UpdateState> {
    const feed = this.feed
    if (!feed) return this.state
    try {
      const res = await fetchFn(feed.appcastUrl)
      if (!res.ok) {
        throw new Error(`the appcast at ${feed.appcastUrl} answered ${res.status}`)
      }
      const next = newestIn(await res.text())
      if (next && isNewer(next, this.state.version)) this.offer(next)
      else this.set({ kind: 'idle', version: this.state.version, checkedAt: Date.now() })
    } catch (err) {
      this.fail(err)
    }
    return this.state
  }

  /** A new version exists: say so, once. Windows - Sparkle says it itself. */
  private offer(next: string, notes?: string): void {
    this.set({ kind: 'available', version: this.state.version, next, notes })
    if (this.told !== next) {
      this.told = next
      this.emit('found', next)
    }
  }

  /** Fetch it. The state carries the percentage while this runs. */
  async download(): Promise<UpdateState> {
    // On macOS there is nothing here to download with: `probe` found the
    // version, and Sparkle owns everything after that. A foreground check opens
    // its window, which is both the offer and - when the archive is signed by a
    // key this build does not carry - the error the background check swallowed.
    if (this.sparkle) {
      this.sparkle.checkForUpdates()
      return this.state
    }
    const el = this.el
    if (!el || this.state.kind !== 'available') return this.state
    this.set({ kind: 'downloading', version: this.state.version, next: this.state.next, percent: 0 })
    try {
      await el.autoUpdater.downloadUpdate()
    } catch (err) {
      this.fail(err)
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
    if (this.sparkle) {
      this.sparkle.installUpdateNow()
      return true
    }
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
