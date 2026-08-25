import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ED_KEY_PLACEHOLDER,
  Updates,
  isNewer,
  newestIn,
  sparkleFeed,
  type SparkleBridge,
  type UpdateState
} from '../src/main/update.ts'

/**
 * The parts of the updater that are ours.
 *
 * Comparing versions, deciding what a packaged bundle is allowed to check
 * against, and routing the three verbs to whichever of the two updaters is
 * attached. Neither `electron-updater` nor Sparkle is re-tested - they are the
 * things being wrapped.
 */

test('newer is newer, and the same version is not', () => {
  assert.equal(isNewer('1.1.0', '1.0.0'), true)
  assert.equal(isNewer('v1.1.0', '1.0.0'), true, 'a leading v is a tag, not a version')
  assert.equal(isNewer('1.0.0', '1.0.0'), false)
  assert.equal(isNewer('1.0.0', '1.1.0'), false)
  assert.equal(isNewer('1.0.10', '1.0.9'), true, 'ten is after nine, not before it')
  assert.equal(isNewer('2.0.0', '1.99.99'), true)
  // A release beats its own pre-release; two pre-releases go in tag order.
  assert.equal(isNewer('1.1.0', '1.1.0-beta.1'), true)
  assert.equal(isNewer('1.1.0-beta.1', '1.1.0'), false)
  assert.equal(isNewer('1.1.0-beta.2', '1.1.0-beta.1'), true)
  assert.equal(isNewer('1.1.0-beta.1', '1.0.9'), true)
})

/**
 * The placeholder is the dangerous one. A build that ships it looks completely
 * healthy - Sparkle arms, checks on schedule, and rejects every signature it is
 * ever shown, so the app simply never updates and nothing anywhere says why.
 */
test('a bundle that cannot say what feed it belongs to is refused, with the reason', () => {
  const plist = (values: Record<string, string>) => (key: string) => values[key] ?? null

  assert.deepEqual(
    sparkleFeed(plist({ SUFeedURL: 'https://example.com/appcast.xml', SUPublicEDKey: 'abc123' })),
    { appcastUrl: 'https://example.com/appcast.xml', publicEdKey: 'abc123' }
  )
  assert.throws(() => sparkleFeed(plist({ SUPublicEDKey: 'abc123' })), /SUFeedURL/)
  assert.throws(() => sparkleFeed(plist({ SUFeedURL: 'https://x/a.xml' })), /SUPublicEDKey/)
  assert.throws(
    () => sparkleFeed(plist({ SUFeedURL: 'https://x/a.xml', SUPublicEDKey: ED_KEY_PLACEHOLDER })),
    /placeholder/,
    'the release step never injected the real key'
  )
})

test('a dev run has no updater at all', async () => {
  const u = new Updates('1.0.0')
  // What main does when the app is not packaged: nothing. `attach` is never
  // reached, and even if it were, it refuses an unpackaged app.
  u.attach({
    app: { isPackaged: false, getVersion: () => '1.0.0', getAppPath: () => '/x' },
    autoUpdater: never()
  })
  assert.deepEqual(u.get(), { kind: 'dev', version: '1.0.0' })
  // Every verb is a no-op rather than a throw: an unpackaged app has no
  // `app-update.yml`, and asking `autoUpdater` anything without one throws.
  u.start()
  assert.equal(u.get().kind, 'dev', 'and nothing was scheduled')
  assert.deepEqual(await u.check(), { kind: 'dev', version: '1.0.0' })
  assert.equal(u.install(), false)
})

test('found, downloaded, installed - and the window is told at every step', async (t) => {
  const el = fake('1.0.0')
  const u = new Updates('1.0.0')
  u.attach(el.electron)
  // Registered before the first assert: a failure that skipped `stop()` would
  // leave the check interval running and the test process would never exit.
  t.after(() => u.stop())
  const seen: UpdateState['kind'][] = []
  u.on('state', (s: UpdateState) => seen.push(s.kind))
  u.start(60_000, 60_000)

  el.fire('update-available', { version: '1.1.0', releaseNotes: 'faster' })
  const found = u.get()
  assert.equal(found.kind, 'available')
  assert.equal('next' in found && found.next, '1.1.0')

  await u.download()
  el.fire('download-progress', { percent: 41.6 })
  const half = u.get()
  assert.equal(half.kind, 'downloading')
  assert.equal('percent' in half && half.percent, 42, 'rounded, because a bar is not a decimal')

  el.fire('update-downloaded', {})
  assert.equal(u.get().kind, 'ready')
  assert.equal(u.install(), true)
  assert.equal(el.installed, 1, 'and the app was actually asked to quit and install')

  assert.deepEqual(seen.slice(0, 3), ['available', 'downloading', 'downloading'])
})

/**
 * The macOS half. Sparkle owns the window, so what is tested here is only the
 * routing: the three verbs reach the bridge, and none of them reach - or need -
 * the `electron-updater` half that is not attached.
 */
test('on macOS the verbs go to Sparkle, and the state stops at idle', () => {
  const bridge = fakeBridge()
  const u = new Updates('1.0.0')
  const plist: Record<string, string> = {
    SUFeedURL: 'https://example.com/appcast.xml',
    SUPublicEDKey: 'abc123'
  }

  assert.equal(u.attachSparkle(bridge.bridge, (k) => plist[k] ?? null), true)
  assert.deepEqual(bridge.feed, { appcastUrl: 'https://example.com/appcast.xml', publicEdKey: 'abc123' })
  assert.deepEqual(u.get(), { kind: 'idle', version: '1.0.0' })

  // No timers: Sparkle keeps its own schedule off SUScheduledCheckInterval, so
  // a second one here would be two apps asking the same feed twice as often.
  u.start(60_000, 60_000)
  assert.equal(bridge.automatic, true)
  u.stop()

  u.check()
  assert.equal(bridge.checks, 1)
  assert.equal(u.get().kind, 'idle', 'Sparkle took over the window; nothing moved here')

  assert.equal(u.install(), true)
  assert.equal(bridge.installs, 1)
})

/** An appcast, as `generate_appcast` writes one. */
const appcast = (...versions: string[]): string =>
  `<?xml version="1.0" standalone="yes"?><rss version="2.0"><channel><title>BullPen</title>` +
  versions
    .map(
      (v) =>
        `<item><title>${v}</title><sparkle:version>${v}</sparkle:version>` +
        `<sparkle:shortVersionString>${v}</sparkle:shortVersionString>` +
        `<enclosure url="https://x/${v}.zip" sparkle:edSignature="sig"/></item>`
    )
    .join('') +
  `</channel></rss>`

test('the newest item wins, whatever order the appcast lists them in', () => {
  assert.equal(newestIn(appcast('0.1.8')), '0.1.8')
  assert.equal(newestIn(appcast('0.1.3', '0.1.8', '0.1.7')), '0.1.8')
  assert.equal(newestIn('<rss></rss>'), '', 'an appcast offering nothing offers nothing')
})

/**
 * The failure this exists for: on macOS every way the updater breaks is silent.
 * A 404 feed - which is what an unpublished draft release serves - left this app
 * sitting on 0.1.1 while eight versions shipped, and the window said nothing
 * because "nothing to say" and "cannot reach the feed" drew the same thing.
 */
test('macOS reads the appcast itself, and says so when it cannot', async () => {
  const armed = (): { u: Updates; bridge: ReturnType<typeof fakeBridge> } => {
    const bridge = fakeBridge()
    const u = new Updates('0.1.1')
    u.attachSparkle(bridge.bridge, (k) =>
      ({ SUFeedURL: 'https://x/appcast.xml', SUPublicEDKey: 'abc' })[k] ?? null
    )
    return { u, bridge }
  }

  const found: string[] = []
  const { u, bridge } = armed()
  u.on('found', (v: string) => found.push(v))
  await u.probe(async (url) => {
    assert.equal(url, 'https://x/appcast.xml', 'the feed the bundle names, not a second copy')
    return { ok: true, status: 200, text: async () => appcast('0.1.3', '0.1.8') }
  })
  assert.deepEqual(u.get(), { kind: 'available', version: '0.1.1', next: '0.1.8', notes: undefined })
  assert.deepEqual(found, ['0.1.8'], 'and the notification goes out once')

  // The chip's click is the only download verb the renderer has, and on macOS
  // it must reach Sparkle rather than an updater that is not attached.
  await u.download()
  assert.equal(bridge.checks, 1)

  // A draft release, a private repo, a moved asset: all of them are this.
  const dead = armed().u
  await dead.probe(async () => ({ ok: false, status: 404, text: async () => 'Not Found' }))
  const s = dead.get()
  assert.equal(s.kind, 'error')
  assert.match('message' in s ? s.message : '', /404/)

  // Nothing newer is still an answer, and it is not an alarm.
  const same = armed().u
  await same.probe(async () => ({ ok: true, status: 200, text: async () => appcast('0.1.1') }))
  assert.equal(same.get().kind, 'idle')
})

test('a mac build with no key in it says so instead of pretending to watch', () => {
  const bridge = fakeBridge()
  const u = new Updates('1.0.0')
  const plist: Record<string, string> = {
    SUFeedURL: 'https://example.com/appcast.xml',
    SUPublicEDKey: ED_KEY_PLACEHOLDER
  }
  assert.equal(u.attachSparkle(bridge.bridge, (k) => plist[k] ?? null), false)
  const s = u.get()
  assert.equal(s.kind, 'error')
  assert.match('message' in s ? s.message : '', /placeholder/)
  assert.equal(bridge.inits, 0, 'and Sparkle was never armed against a key that validates nothing')
  // Nothing was attached, so the verbs stay no-ops rather than throwing.
  u.start(60_000, 60_000)
  assert.equal(bridge.automatic, false)
  u.stop()
})

test('a bridge that refuses the feed is an error, not a silent no-op', () => {
  const bridge = fakeBridge({ accept: false })
  const u = new Updates('1.0.0')
  assert.equal(
    u.attachSparkle(bridge.bridge, (k) =>
      ({ SUFeedURL: 'https://x/a.xml', SUPublicEDKey: 'abc' })[k] ?? null
    ),
    false
  )
  assert.equal(u.get().kind, 'error')
})

/** An `autoUpdater` that would throw if anything actually touched it. */
function never(): never {
  return new Proxy(
    {},
    {
      get: (_t, k) => {
        if (k === 'on') return () => {}
        throw new Error(`the dev updater touched autoUpdater.${String(k)}`)
      },
      set: () => {
        throw new Error('the dev updater configured autoUpdater')
      }
    }
  ) as never
}

/** The native Sparkle bridge, counting what it was asked to do. */
function fakeBridge(opts: { accept?: boolean } = {}): {
  bridge: SparkleBridge
  feed: unknown
  inits: number
  checks: number
  installs: number
  automatic: boolean
} {
  const out = {
    feed: null as unknown,
    inits: 0,
    checks: 0,
    installs: 0,
    automatic: false,
    bridge: {} as SparkleBridge
  }
  out.bridge = {
    init: (feed) => {
      out.inits++
      out.feed = feed
      return opts.accept !== false
    },
    checkForUpdates: () => {
      out.checks++
    },
    installUpdateNow: () => {
      out.installs++
    },
    setAutomaticChecks: (enabled) => {
      out.automatic = enabled
    }
  }
  return out
}

/** A packaged app and an `autoUpdater` whose events this test fires by hand. */
function fake(version: string): {
  electron: Parameters<Updates['attach']>[0]
  fire: (event: string, payload: unknown) => void
  installed: number
} {
  const handlers = new Map<string, (p: unknown) => void>()
  const out = {
    installed: 0,
    fire: (event: string, payload: unknown) => handlers.get(event)?.(payload),
    electron: {
      app: {
        isPackaged: true,
        getVersion: () => version,
        getAppPath: () => '/bin/ls'
      },
      autoUpdater: {
        autoDownload: true,
        autoInstallOnAppQuit: true,
        logger: {} as unknown,
        checkForUpdates: async () => null,
        downloadUpdate: async () => null,
        quitAndInstall: () => {
          out.installed++
        },
        on: (event: string, fn: (...a: never[]) => void) =>
          handlers.set(event, fn as (p: unknown) => void)
      }
    }
  }
  return out
}
