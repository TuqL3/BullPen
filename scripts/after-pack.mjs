/**
 * Restore the exec bit on node-pty's spawn-helper.
 *
 * node-pty ships its prebuilt spawn-helper as 0644 and only chmods the copy it
 * compiles locally. An Intel-Mac package falls back to prebuilds/darwin-x64
 * (the locally built arm64 binary fails to load there), so without this the app
 * launches fine and then fails to start a single agent - forkpty execs a file
 * it is not allowed to run.
 */
import { chmodSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export default async function afterPack({ appOutDir, electronPlatformName, packager }) {
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
