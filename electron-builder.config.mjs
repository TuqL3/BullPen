import { sparkleBuilderConfig } from 'electron-sparkle-updater/builder'

/**
 * Was `electron-builder.yml`. It is JavaScript now because Sparkle needs values
 * a YAML file cannot state: the framework's own list of localizations, read off
 * the copy that is actually vendored. Hard-coding those 30-odd language tags
 * would go stale the first time Sparkle is bumped, silently - macOS confines an
 * embedded framework to the languages the host app declares, so the symptom is
 * an update dialog that is English on a French machine.
 *
 * ponytail: keyed off `process.platform` rather than off the target being
 * built, because electron-builder does not say which target it is loading the
 * config for. A macOS package can only be built on macOS and a Windows one is
 * built on Windows, so the two coincide. Ceiling: a `--mac` run from Windows
 * would silently produce a package with no Sparkle in it. If that ever becomes
 * a thing anybody does, read `process.argv` for `--mac` here instead.
 */
const onMac = process.platform === 'darwin'

/**
 * Where a packaged mac app looks for the appcast.
 *
 * `releases/latest/download/<asset>` is GitHub's stable alias for the newest
 * *published* release - which is why the release workflow leaves a draft and a
 * human presses Publish. A draft is not `latest`, so nothing updates to a
 * version nobody has looked at yet.
 */
const FEED = 'https://github.com/TuqL3/BullPen/releases/latest/download/appcast.xml'

/**
 * The EdDSA public key the app validates every update against.
 *
 * Given here rather than patched into the plist afterwards, so the key is in
 * the bundle before it is sealed. Unset - which is every local build - leaves
 * the placeholder `electron-sparkle-updater` writes, and `src/main/update.ts`
 * refuses to arm Sparkle against it and says so in the window. That is the
 * intended local behaviour: a developer build does not check for updates.
 *
 * Throws when the framework has not been vendored yet, which is the right
 * failure: `npm run rebuild:sparkle` has to have run before this can pack.
 */
const sparkle = onMac
  ? sparkleBuilderConfig({
      feedUrl: FEED,
      // Trimmed. A secret pasted into GitHub's box keeps whatever whitespace
      // came with it, and that whitespace goes into Info.plist verbatim - where
      // generate_appcast compares the value character for character against the
      // key it is signing with, and declines to sign without saying so.
      publicEdKey: process.env.SPARKLE_ED_PUBLIC_KEY?.trim() || undefined
    })
  : null

export default {
  appId: 'com.bullpen.app',
  productName: 'BullPen',

  /**
   * Where a built app looks for a newer one - on Windows.
   *
   * electron-builder writes `latest.yml` from this and embeds `app-update.yml`
   * in the NSIS package; `electron-updater` reads both. macOS does not use
   * either any more - it reads the appcast at FEED above - which is why the dmg
   * and zip targets have `writeUpdateInfo` turned off below. Publishing needs
   * GH_TOKEN in the environment.
   */
  publish: {
    provider: 'github',
    owner: 'TuqL3',
    repo: 'BullPen'
  },

  directories: {
    output: 'release',
    buildResources: 'build'
  },

  files: [
    '!src/**',
    '!test/**',
    '!scripts/**',
    '!OPEN-QUESTIONS.md',
    '!electron.vite.config.ts',
    '!tsconfig.json',
    // 28 MB of Windows debug symbols that ship inside node-pty's prebuilds.
    '!node_modules/node-pty/prebuilds/**/*.pdb',
    '!node_modules/node-pty/build/Release/obj.target/**',
    // The framework is copied into Contents/Frameworks by `extraFiles`; without
    // this it would also ride along inside the asar, twice the size for nothing.
    ...(sparkle?.files ?? [])
  ],

  // node-pty is native, plus winpty ships a .dll and an .exe that must be real
  // files on disk - nothing here can be read from inside the asar. The Sparkle
  // bridge is the same: a .node is dlopen'd, and dlopen cannot see into an asar.
  asarUnpack: ['**/node_modules/node-pty/**', ...(sparkle?.asarUnpack ?? [])],

  // node-pty 1.1 is node-api, so its shipped prebuilds load on Electron as-is and
  // a cross-platform build needs no toolchain. The macOS package still prefers the
  // locally rebuilt build/Release (see scripts/patch-node-pty.mjs); on Windows that
  // copy fails to load and node-pty falls through to prebuilds/win32-*.
  npmRebuild: false,

  afterPack: 'scripts/after-pack.mjs',

  /**
   * Sparkle reads its update out of the zip and validates it by the EdDSA
   * signature in the appcast, so the `latest-mac.yml` electron-updater wants is
   * not what anything on macOS reads any more.
   *
   * Only `dmg` is turned off here. `sparkleBuilderConfig` also returns a root
   * `zip` key, which electron-builder 26 rejects outright - "configuration has
   * an unknown property 'zip'" - so the zip still gets a `latest-mac.yml`
   * written beside it. Left alone rather than fought: nothing reads that file
   * now, and the alternative is patching a schema this does not own.
   */
  ...(sparkle ? { dmg: sparkle.dmg } : {}),

  mac: {
    category: 'public.app-category.developer-tools',
    /**
     * No Developer ID certificate. Left unset, electron-builder goes looking in
     * the keychain and signs with whatever it finds, which on a build machine
     * is not a decision anybody made. The bundle is ad-hoc signed in
     * `scripts/after-pack.mjs` instead - which is all Sparkle needs.
     */
    identity: null,
    /**
     * node-pty's locally compiled copy is arm64 only, and the same file in both
     * halves of the merge - which @electron/universal refuses to guess about.
     *
     * Declared rather than fixed, because it is already how this app works on
     * an Intel Mac: `npmRebuild: false` means only the host arch gets compiled,
     * and node-pty falls through to `prebuilds/darwin-x64` when the local build
     * will not load. See scripts/after-pack.mjs for the other half of that.
     *
     * The cost is real and predates this file: an Intel Mac runs the *prebuilt*
     * node-pty, so it does not get the inherited-descriptor patch that
     * scripts/patch-node-pty.mjs compiles into the arm64 one. Universal does
     * not make that worse, and it does not fix it either.
     *
     * `x64ArchFiles` and not `singleArchFiles`, which is the one the name would
     * suggest: `singleArchFiles` is only forwarded to the ASAR merge, and these
     * files live in `app.asar.unpacked`. The unpacked tree is walked separately
     * and consults this key - one minimatch string, not a list.
     */
    x64ArchFiles: '**/node-pty/**',
    /**
     * One universal package, not one per architecture.
     *
     * Sparkle's `generate_appcast` refuses a directory holding two archives
     * that report the same bundle version - "Duplicate updates are not
     * supported" - and an arm64 zip and an x64 zip of the same release are
     * exactly that. An appcast item carries no architecture, so there is no
     * version of this where two per-arch archives share one feed.
     *
     * ponytail: a universal zip is both slices, so every update is roughly
     * twice the download of a single-arch one. Ceiling accepted because the
     * alternative - a feed per architecture, chosen at runtime - puts the
     * architecture in three places at once, and getting it wrong means an
     * Intel Mac updating itself to a build that cannot launch. Upgrade path
     * when the size bites: delta updates, which `generate_appcast` produces
     * from previous archives and which cut a repeat update far below either.
     */
    target: [
      { target: 'dmg', arch: ['universal'] },
      // Sparkle updates out of the zip; the dmg is what a person downloads the
      // first time. Both are published, and the zip is what the appcast lists.
      { target: 'zip', arch: ['universal'] }
    ],
    // SUFeedURL, SUPublicEDKey and the localization list. The key is a
    // placeholder until the release workflow injects the real one.
    ...(sparkle?.mac ?? {}),
    // Per-platform on purpose: `sparkleBuilderConfig` returns this at the top
    // level, where it would apply to the Windows package too and fail trying to
    // copy a macOS framework into it.
    ...(sparkle ? { extraFiles: sparkle.extraFiles } : {})
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }]
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true
  }
}
