/**
 * Three things the packer leaves wrong, fixed on the way out.
 *
 * **macOS - the exec bit on node-pty's spawn-helper.** node-pty ships its
 * prebuilt spawn-helper as 0644 and only chmods the copy it compiles locally.
 * An Intel-Mac package falls back to prebuilds/darwin-x64 (the locally built
 * arm64 binary fails to load there), so without this the app launches fine and
 * then fails to start a single agent - posix_spawn execs a file it is not
 * allowed to run.
 *
 * **Windows - the macOS binaries that rode along.** `build/Release` is what
 * `npm install` compiled on the build machine, which is a Mach-O `pty.node`
 * and a Mach-O `spawn-helper`. node-pty looks in `build/Release` *first*
 * (`lib/utils.js: loadNativeModule`), fails to load them, and falls through to
 * `prebuilds/win32-*` - so the package works, and the load path is a
 * try/catch away from the one that was meant. Taken out here rather than in
 * `electron-builder.config.mjs`: a platform-level `files:` key drops the
 * packer's own default excludes, and the first thing that walks back in is
 * `release/` itself - a 3.8 GB asar built out of the previous builds.
 *
 * **macOS - the seal, after everything else has moved.** Sparkle validates an
 * update by EdDSA rather than by a Developer ID, but it still refuses an
 * archive whose `.app` does not pass `codesign --verify --deep --strict`.
 * Staging `extraFiles` and `asarUnpack` invalidates whatever signature the
 * bundle arrived with, so it is re-signed ad-hoc here, last.
 */
import { chmodSync, readdirSync, rmSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { adHocSignAfterPack } from 'electron-sparkle-updater/builder'

export default async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context
  if (electronPlatformName === 'win32') {
    const build = join(
      appOutDir,
      'resources/app.asar.unpacked/node_modules/node-pty/build'
    )
    // Absent is not a problem to report: a Windows machine building for itself
    // has no macOS copy to remove, and that is the state this is aiming at.
    if (existsSync(build)) {
      rmSync(build, { recursive: true, force: true })
      console.log('  • removed the macOS node-pty build from the Windows package')
    }
    return
  }
  if (electronPlatformName !== 'darwin') return

  const unpacked = join(
    appOutDir,
    `${packager.appInfo.productFilename}.app/Contents/Resources/app.asar.unpacked`
  )

  let found = 0
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'spawn-helper') {
        chmodSync(p, 0o755)
        found++
      }
    }
  }
  walk(unpacked)

  // Loud on zero: a silently skipped chmod looks exactly like a working build
  // until someone on an Intel Mac tries to start an agent.
  if (found === 0) throw new Error('afterPack: no spawn-helper found under ' + unpacked)
  console.log(`  • made ${found} spawn-helper binaries executable`)

  // A universal build packs x64 and arm64 into `<out>-<arch>-temp` first and
  // then lipo-merges them, and this hook runs on all three. Signing a staging
  // copy is what broke it: `codesign --force --deep` rewrites
  // `Electron Framework.framework/.../_CodeSignature/CodeResources`, the two
  // arches end up with different ones, and @electron/universal refuses to merge
  // -- "Expected all non-binary files to have identical SHAs". So the seal goes
  // on the merged app only, which electron-builder gives this hook a second
  // pass for (macPackager: "a final opportunity ... before signing").
  //
  // The chmod above is not skipped for the staging copies: it changes a mode,
  // not a byte, so it cannot make two arches disagree, and doing it in both
  // passes means the merge cannot lose it.
  if (appOutDir.endsWith('-temp')) return

  // Last, and only last. Ad-hoc signing seals the bundle as it stands, and the
  // chmod above changes an executable inside it - done the other way round, the
  // seal is over a file that no longer matches. Sparkle's generate_appcast
  // refuses any archive whose .app fails `codesign --verify --deep --strict`,
  // so a stale seal here is a release that cannot be signed at all.
  await adHocSignAfterPack(context)
  console.log('  • ad-hoc signed the bundle for Sparkle')
}
