/**
 * Two things the packer leaves wrong, fixed on the way out.
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
 * `electron-builder.yml`: a platform-level `files:` key drops the packer's own
 * default excludes, and the first thing that walks back in is `release/`
 * itself - a 3.8 GB asar built out of the previous builds.
 */
import { chmodSync, readdirSync, rmSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export default async function afterPack({ appOutDir, electronPlatformName, packager }) {
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
}
