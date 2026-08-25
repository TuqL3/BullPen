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

/** Where the public half sits inside the 96-byte private blob. */
const PUBLIC_KEY_BYTES = 32

/** What `electron-sparkle-updater` writes when no key was given at pack time. */
const PLACEHOLDER = 'SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER'

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

  const privBytes = Buffer.from(priv.trim(), 'base64')
  if (privBytes.length < PUBLIC_KEY_BYTES) {
    return `SPARKLE_ED_PRIVATE_KEY decodes to ${privBytes.length} bytes, which is too short to be a key`
  }

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

// Run directly: read the two secrets from the environment and say yes or no.
if (process.argv[1] && process.argv[1].endsWith('check-sparkle-keypair.mjs')) {
  const why = keypairProblem(
    process.env.SPARKLE_ED_PUBLIC_KEY ?? '',
    process.env.SPARKLE_ED_PRIVATE_KEY ?? ''
  )
  if (why) {
    console.error(`::error::${why}`)
    process.exit(1)
  }
  console.log('Sparkle keypair: public key matches the private key')
}
