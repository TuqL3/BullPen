import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'

/**
 * The GitHub token, kept where the config is not.
 *
 * `config.json` is read and rewritten by half the app, printed in bug reports,
 * and copied between machines by the very feature this token exists for. A
 * token in it would be a token in a gist.
 *
 * Encrypted by the OS keychain where there is one - Keychain on macOS,
 * libsecret on Linux, DPAPI on Windows. Where there is not, it is written
 * plainly and said so out loud: refusing to sync at all on a machine without a
 * keyring is a worse answer than one the operator can weigh, and pretending
 * base64 is encryption is the worst answer of the three.
 */

const tokenPath = (home: string): string => join(home, 'credentials')

/** Whether the OS will actually encrypt this, or is only being asked to. */
export const keyringWorks = (): boolean => {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * Whether a token is stored, and whether the OS encrypted it - read off the
 * file, without decrypting anything.
 *
 * Both answers are in the first byte, and asking `safeStorage` for either one
 * is what made opening the settings dialog raise a keychain prompt. macOS ties
 * a keychain item's ACL to the code signature, this app is ad-hoc signed, and
 * every build signs differently - so every update turned "look at the settings"
 * into "type your login password". The keychain is now touched only where the
 * token itself is needed: signing in, syncing, asking GitHub who this is.
 */
export function tokenOnDisk(home: string): { has: boolean; encrypted: boolean } {
  const path = tokenPath(home)
  if (!existsSync(path)) return { has: false, encrypted: false }
  try {
    const raw = readFileSync(path)
    return { has: raw.length > 1, encrypted: raw[0] === 0x01 }
  } catch {
    return { has: false, encrypted: false }
  }
}

export function readToken(home: string): string {
  const path = tokenPath(home)
  if (!existsSync(path)) return ''
  try {
    const raw = readFileSync(path)
    // The first byte says which of the two it is, so a machine that gains a
    // keyring later can still read what it wrote before it had one.
    if (raw[0] === 0x01) return safeStorage.decryptString(raw.subarray(1))
    return raw.subarray(1).toString('utf8')
  } catch {
    return ''
  }
}

export function writeToken(home: string, token: string): void {
  const path = tokenPath(home)
  if (!token) {
    if (existsSync(path)) rmSync(path)
    return
  }
  const safe = keyringWorks()
  const body = safe ? safeStorage.encryptString(token) : Buffer.from(token, 'utf8')
  writeFileSync(path, Buffer.concat([Buffer.from([safe ? 0x01 : 0x00]), body]), { mode: 0o600 })
}
