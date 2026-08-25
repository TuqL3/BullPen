import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Updates, canInstallInPlace, isNewer, type UpdateState } from '../src/main/update.ts'

/**
 * The parts of the updater that are ours.
 *
 * Comparing versions and deciding what happens to a downloaded one are the two
 * places a mistake here would show: a "new version" that is the one already
 * running, or a button that promises an install this copy cannot do.
 * `electron-updater` itself is not re-tested - it is the thing being wrapped.
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

test('only macOS is asked for a signature, and only macOS can fail it', async () => {
  const asked: string[] = []
  const run = async (cmd: string, args: string[]): Promise<boolean> => {
    asked.push(`${cmd} ${args[0]}`)
    return false
  }
  assert.equal(await canInstallInPlace('win32', '/app', run), true)
  assert.equal(await canInstallInPlace('linux', '/app', run), true)
  assert.deepEqual(asked, [], 'NSIS replaces an unsigned install; nothing to ask')

  assert.equal(await canInstallInPlace('darwin', '/A.app', run), false)
  assert.deepEqual(asked, ['codesign -dv'])
  assert.equal(await canInstallInPlace('darwin', '/A.app', async () => true), true)
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
  const found = await until(u, 'available')
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

// Only on a Mac: the signature question is one `codesign` answers, and there is
// no `codesign` anywhere else to answer it.
test('an unsigned mac is told to fetch it by hand, not handed a button that fails', {
  skip: process.platform !== 'darwin' ? 'darwin only' : false
}, async (t) => {
  const el = fake('1.0.0', { signed: false })
  const u = new Updates('1.0.0')
  u.attach(el.electron)
  t.after(() => u.stop())
  u.start(60_000, 60_000)
  el.fire('update-available', { version: '1.1.0' })
  const s = await until(u, 'manual')
  assert.match('url' in s ? s.url : '', /github\.com/)
  // And the download is refused rather than started into an install that dies.
  assert.equal((await u.download()).kind, 'manual')
  assert.equal(u.install(), false)
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

/**
 * Wait for the updater to reach a state, rather than for a number of ms.
 *
 * `offer` shells out to `codesign` before it can say whether an update is
 * installable, and how long that takes is the machine's business. A fixed sleep
 * here is a test that passes on a fast laptop and fails on a busy one.
 */
const until = (u: Updates, kind: UpdateState['kind']): Promise<UpdateState> =>
  new Promise((done, fail) => {
    if (u.get().kind === kind) return done(u.get())
    const timer = setTimeout(() => fail(new Error(`never reached "${kind}": ${u.get().kind}`)), 5000)
    const watch = (s: UpdateState): void => {
      if (s.kind !== kind) return
      clearTimeout(timer)
      u.off('state', watch)
      done(s)
    }
    u.on('state', watch)
  })

/** A packaged app and an `autoUpdater` whose events this test fires by hand. */
function fake(
  version: string,
  opts: { signed?: boolean } = {}
): {
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
        // The signature answer is decided by the path, and `codesign` is asked
        // for real rather than faked: `/bin/ls` is signed on every Mac there
        // is, and a path that does not exist is the unsigned case. On anything
        // but darwin neither is asked - `canInstallInPlace` says yes.
        getAppPath: () => (opts.signed === false ? '/nonexistent-unsigned.app' : '/bin/ls')
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
