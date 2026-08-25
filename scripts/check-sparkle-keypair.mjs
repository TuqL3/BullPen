/**
 * Are the two Sparkle secrets two halves of one keypair?
 *
 * `generate_appcast` reads `SUPublicEDKey` out of the app bundle inside the
 * archive and compares it against the public half carried in the private key it
 * was handed. When they disagree it writes the appcast **without a signature,
 * prints nothing, and exits 0** - and an app that carries `SUPublicEDKey` then
 * rejects every update it is ever offered. The release looks finished and
 * updates nobody.
 *
 * That mismatch costs a full macOS build to discover. This is the same
 * comparison, made in a second, before anything is packaged.
 *
 * Which 32 bytes hold the public half was settled by experiment rather than by
 * reading: with the app's plist pinned to one key, a private blob carrying that
 * key at bytes 32..64 was refused and one carrying it at bytes 64..96 was
 * signed. The last 32 bytes are what Sparkle looks at.
 *
 * Nothing here prints key material - only lengths and a verdict.
 */

/** Where the public half sits inside the private blob. */
const PUBLIC_KEY_BYTES = 32

/**
 * What Sparkle accepts a private key to decode to.
 *
 * Its own words, when handed anything else: "Imported key must be 64 bytes or
 * 96 bytes (for the older format) decoded." 96 is what `generate_keys -x`
 * writes today - 128 base64 characters.
 */
const PRIVATE_KEY_BYTES = [64, 96]

/** What `electron-sparkle-updater` writes when no key was given at pack time. */
const PLACEHOLDER = 'SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER'

/**
 * A reason a private key cannot be used, or null when it can.
 *
 * Length is the whole test, and it names the mistake that has actually been
 * made: 32 bytes is an ed25519 *public* key. That is the value `generate_keys`
 * prints to the screen, and it is the obvious thing to copy - the private key
 * is never printed at all. It lives in the Keychain and only `generate_keys -x`
 * writes it out.
 */
function privateKeyProblem(priv) {
  if (!priv || !priv.trim()) return 'SPARKLE_ED_PRIVATE_KEY is empty'

  const bytes = Buffer.from(priv.trim(), 'base64')
  if (PRIVATE_KEY_BYTES.includes(bytes.length)) return null

  return (
    `SPARKLE_ED_PRIVATE_KEY decodes to ${bytes.length} bytes; Sparkle accepts ` +
    `${PRIVATE_KEY_BYTES.join(' or ')}. ` +
    (bytes.length === PUBLIC_KEY_BYTES
      ? 'That is the length of an ed25519 public key - the value generate_keys ' +
        'prints to the screen. The private key is never printed: it lives in the ' +
        'Keychain, and `generate_keys -x <file>` exports it as 128 base64 characters.'
      : 'The file generate_keys -x writes is 128 base64 characters - paste it ' +
        'whole, and nothing around it.')
  )
}

/**
 * A reason the pair cannot work, or null when it can.
 *
 * Returns the reason rather than throwing so the caller decides what a failure
 * looks like, and so this is a plain function to test.
 */
export function keypairProblem(pub, priv) {
  if (!pub) return 'SPARKLE_ED_PUBLIC_KEY is empty'
  if (!priv) return 'SPARKLE_ED_PRIVATE_KEY is empty'
  if (pub === PLACEHOLDER) {
    return `SPARKLE_ED_PUBLIC_KEY is the literal placeholder "${PLACEHOLDER}"`
  }

  const pubBytes = Buffer.from(pub.trim(), 'base64')
  if (pubBytes.length !== PUBLIC_KEY_BYTES) {
    return (
      `SPARKLE_ED_PUBLIC_KEY decodes to ${pubBytes.length} bytes, not ${PUBLIC_KEY_BYTES}. ` +
      'An ed25519 public key is 44 base64 characters. Paste the key itself, not the ' +
      '"SUPublicEDKey" line generate_keys prints around it.'
    )
  }

  // Length first, and against the lengths Sparkle accepts rather than merely
  // "long enough to end in 32 bytes". A public key pasted into the private
  // secret ends in itself, so the comparison below would call that a match and
  // wave through a release that cannot be signed.
  const badPrivate = privateKeyProblem(priv)
  if (badPrivate) return badPrivate

  const privBytes = Buffer.from(priv.trim(), 'base64')
  const carried = privBytes.subarray(privBytes.length - PUBLIC_KEY_BYTES)
  if (carried.equals(pubBytes)) return null

  // Worth telling apart: a private key that carries the public key somewhere
  // else has a layout this does not know about, and that is a different bug
  // from the two secrets simply belonging to different keypairs.
  const elsewhere = privBytes.includes(pubBytes)
  return elsewhere
    ? 'SPARKLE_ED_PRIVATE_KEY contains the public key, but not in its last 32 bytes - ' +
        'this key has a layout generate_appcast will not match against Info.plist'
    : 'SPARKLE_ED_PUBLIC_KEY and SPARKLE_ED_PRIVATE_KEY are not two halves of one keypair. ' +
        'Re-export both from the same key: generate_keys prints the public half, ' +
        'generate_keys -x writes the private one.'
}

/**
 * The public half of a Sparkle private key.
 *
 * There is no second secret to keep in step with this one, and that is the
 * point: a public key and a private key held apart drift, and when they drift
 * `generate_appcast` says nothing and ships an appcast that validates against
 * neither. Derived, they cannot disagree.
 *
 * The last 32 bytes, established by experiment rather than by reading: with a
 * packaged app's plist pinned to one key, a private blob carrying that key at
 * bytes 32..64 was refused and one carrying it at 64..96 was signed. That holds
 * for both lengths Sparkle accepts - 64 bytes is seed then public, 96 is the
 * same with the public half repeated.
 *
 * Throws rather than returning a wrong answer: a key this cannot read is a
 * release that must not be built, not one that should quietly go unsigned.
 */
export function publicKeyFromPrivate(priv) {
  const problem = privateKeyProblem(priv)
  if (problem) throw new Error(problem)
  const bytes = Buffer.from(priv.trim(), 'base64')
  return bytes.subarray(bytes.length - PUBLIC_KEY_BYTES).toString('base64')
}

/**
 * The public key a packaged app actually carries.
 *
 * Worth asking separately from the secret it came from: whitespace, a partial
 * paste, or a packaging step that never received the variable all end here, and
 * this is the value generate_appcast will compare against.
 */
export function publicKeyInBundle(plistPath, run) {
  try {
    return run('plutil', ['-extract', 'SUPublicEDKey', 'raw', '-o', '-', plistPath]).trim()
  } catch {
    return ''
  }
}

// Run directly. `--plist <Info.plist>` checks the key the app was packaged
// with; without it, the key as the secret arrived.
if (process.argv[1] && process.argv[1].endsWith('check-sparkle-keypair.mjs')) {
  // `--print-public` is how the release workflow gets a public key at all:
  // there is no secret holding one.
  if (process.argv.includes('--print-public')) {
    try {
      process.stdout.write(publicKeyFromPrivate(process.env.SPARKLE_ED_PRIVATE_KEY ?? ''))
      process.exit(0)
    } catch (err) {
      console.error(`::error::${err.message}`)
      process.exit(1)
    }
  }

  const at = process.argv.indexOf('--plist')
  let pub = process.env.SPARKLE_ED_PUBLIC_KEY ?? ''
  let where = 'SPARKLE_ED_PUBLIC_KEY'

  if (at !== -1) {
    const plist = process.argv[at + 1]
    const { execFileSync } = await import('node:child_process')
    pub = publicKeyInBundle(plist, (cmd, args) =>
      execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    )
    where = `SUPublicEDKey in ${plist}`
    if (!pub) {
      console.error(`::error::${plist} has no SUPublicEDKey - this build was not packaged with one`)
      process.exit(1)
    }
  }

  const why = keypairProblem(pub, process.env.SPARKLE_ED_PRIVATE_KEY ?? '')
  if (why) {
    console.error(`::error::${why.replace('SPARKLE_ED_PUBLIC_KEY', where)}`)
    process.exit(1)
  }
  console.log(`Sparkle keypair: ${where} matches the private key`)
}
