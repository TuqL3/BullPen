/**
 * The public key a Sparkle signing key belongs to, and whether a packaged app
 * carries it.
 *
 * `generate_appcast` reads `SUPublicEDKey` out of the app bundle inside the
 * archive and compares it against the public half of the private key it was
 * handed. When they disagree it writes the appcast **without a signature,
 * prints nothing, and exits 0** - and an app that carries `SUPublicEDKey` then
 * rejects every update it is ever offered. The release looks finished and
 * updates nobody.
 *
 * That mismatch costs a full macOS build to discover. This is the same
 * comparison, made in a second, before anything is packaged.
 *
 * Nothing here prints key material - only lengths and a verdict. The public key
 * is not key material: it ships inside every build.
 */

import { createPrivateKey, createPublicKey } from 'node:crypto'

/** An ed25519 public key, and also the seed a private key is stored as. */
const PUBLIC_KEY_BYTES = 32

/**
 * What Sparkle accepts a private key to decode to.
 *
 * 32 is the format `generate_keys -x` writes today, and its own help is the
 * source: "if the private key is generated in the new format (i.e. the key file
 * after base64 decoding is 32 bytes), then the exported key file is the base64
 * encoding of the private seed."
 *
 * 64 and 96 are the older format, where the public half is appended to the key
 * material rather than derived from it. Sparkle still imports both.
 */
const PRIVATE_KEY_BYTES = [PUBLIC_KEY_BYTES, 64, 96]

/** What `electron-sparkle-updater` writes when no key was given at pack time. */
const PLACEHOLDER = 'SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER'

/** The fixed PKCS#8 header for a raw Ed25519 seed - OID 1.3.101.112. */
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')

/**
 * The public key belonging to a 32-byte seed.
 *
 * Standard EdDSA key generation, which is what Sparkle means by "the seed can
 * be used to create the private/public keypair with other tools that support
 * EdDSA signing". Checked against the RFC 8032 test vectors rather than taken
 * on trust - Sparkle *signs* with orlp/ed25519, whose nonce derivation node
 * cannot reproduce, and it would be easy to assume key generation diverges too.
 * It does not.
 */
function publicKeyFromSeed(seed) {
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, seed]),
    format: 'der',
    type: 'pkcs8'
  })
  return Buffer.from(createPublicKey(priv).export({ format: 'jwk' }).x, 'base64url')
}

/**
 * A reason a private key cannot be used, or null when it can.
 *
 * Length is the whole test. It cannot tell a 32-byte seed from a 32-byte public
 * key - they are the same shape - so that mistake is caught in
 * `keypairProblem` instead, by the value being identical to the public key it
 * is supposed to be checked against.
 */
function privateKeyProblem(priv) {
  if (!priv || !priv.trim()) return 'SPARKLE_ED_PRIVATE_KEY is empty'

  const bytes = Buffer.from(priv.trim(), 'base64')
  if (PRIVATE_KEY_BYTES.includes(bytes.length)) return null

  return (
    `SPARKLE_ED_PRIVATE_KEY decodes to ${bytes.length} bytes; Sparkle accepts ` +
    `${PRIVATE_KEY_BYTES.join(', ')}. The file \`generate_keys -x <file>\` writes ` +
    'is 44 base64 characters in the current format - paste it whole, and nothing ' +
    'around it.'
  )
}

/**
 * The public half of a Sparkle private key.
 *
 * There is no second secret to keep in step with this one, and that is the
 * point: a public key and a private key held apart drift, and when they drift
 * `generate_appcast` says nothing and ships an appcast that validates against
 * neither. Derived, they cannot disagree.
 *
 * Two shapes, because Sparkle has two formats. A 32-byte key is a seed and the
 * public key is computed from it. A 64- or 96-byte key carries its public half
 * in its last 32 bytes - established by experiment rather than by reading: with
 * a packaged app's plist pinned to one key, a 96-byte blob carrying that key at
 * bytes 32..64 was refused and one carrying it at 64..96 was signed.
 *
 * Throws rather than returning a wrong answer: a key this cannot read is a
 * release that must not be built, not one that should quietly go unsigned.
 */
export function publicKeyFromPrivate(priv) {
  const problem = privateKeyProblem(priv)
  if (problem) throw new Error(problem)

  const bytes = Buffer.from(priv.trim(), 'base64')
  const pub =
    bytes.length === PUBLIC_KEY_BYTES
      ? publicKeyFromSeed(bytes)
      : bytes.subarray(bytes.length - PUBLIC_KEY_BYTES)
  return pub.toString('base64')
}

/**
 * A reason the app's key and the signing key cannot work together, or null.
 *
 * Returns the reason rather than throwing so the caller decides what a failure
 * looks like, and so this is a plain function to test.
 */
export function keypairProblem(pub, priv) {
  if (!pub || !pub.trim()) return 'SPARKLE_ED_PUBLIC_KEY is empty'
  if (!priv || !priv.trim()) return 'SPARKLE_ED_PRIVATE_KEY is empty'
  if (pub.trim() === PLACEHOLDER) {
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

  // A seed and a public key are both 32 bytes, so length cannot tell them
  // apart - but the public key pasted into the private secret is the same
  // value twice, and that can be said plainly instead of as a mismatch.
  if (pub.trim() === priv.trim()) {
    return (
      'SPARKLE_ED_PRIVATE_KEY holds the public key. `generate_keys` prints the ' +
      'public half to the screen and never prints the private one - that lives in ' +
      'the Keychain, and `generate_keys -x <file>` writes it out.'
    )
  }

  const badPrivate = privateKeyProblem(priv)
  if (badPrivate) return badPrivate

  if (publicKeyFromPrivate(priv) === pub.trim()) return null

  return (
    'SPARKLE_ED_PUBLIC_KEY and SPARKLE_ED_PRIVATE_KEY are not two halves of one ' +
    'keypair. `generate_keys -p` prints the public key belonging to the key in ' +
    'the Keychain; `generate_keys -x <file>` writes that key out.'
  )
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
