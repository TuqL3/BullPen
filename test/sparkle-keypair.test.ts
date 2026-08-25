import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
// @ts-expect-error - plain JS release tooling, no types and none wanted
import { keypairProblem, publicKeyFromPrivate } from '../scripts/check-sparkle-keypair.mjs'

/**
 * The check that stands between a mismatched pair of secrets and a release that
 * updates nobody.
 *
 * `generate_appcast` answers this same question by writing an unsigned appcast
 * and exiting 0, which is why it is asked here first.
 */

const b64 = (b: Buffer): string => b.toString('base64')
/** A Sparkle private blob: 64 bytes of key material, then the public half. */
const priv = (pub: Buffer): string => b64(Buffer.concat([randomBytes(64), pub]))

test('a matching pair passes', () => {
  const pub = randomBytes(32)
  assert.equal(keypairProblem(b64(pub), priv(pub)), null)
  // Trailing whitespace is what a copy-paste into a secret box leaves behind.
  assert.equal(keypairProblem(`${b64(pub)}\n`, `${priv(pub)}\n`), null)
})

test('two halves of different keypairs are refused', () => {
  const problem = keypairProblem(b64(randomBytes(32)), priv(randomBytes(32)))
  assert.match(problem ?? '', /not two halves of one keypair/)
})

test('the name of the plist key, pasted instead of its value, is named as such', () => {
  // The mistake that cost two CI runs: `SUPublicEDKey` is what the key is
  // called in Info.plist, not what goes in it.
  const problem = keypairProblem('SUPublicEDKey', priv(randomBytes(32)))
  assert.match(problem ?? '', /decodes to \d+ bytes, not 32/)
  assert.match(problem ?? '', /not the "SUPublicEDKey" line/)
})

test('the packaging placeholder is caught before it can ship', () => {
  const problem = keypairProblem('SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER', priv(randomBytes(32)))
  assert.match(problem ?? '', /placeholder/)
})

test('an empty secret is reported as empty, not as a mismatch', () => {
  assert.match(keypairProblem('', priv(randomBytes(32))) ?? '', /PUBLIC_KEY is empty/)
  assert.match(keypairProblem(b64(randomBytes(32)), '') ?? '', /PRIVATE_KEY is empty/)
})

test('a key carrying the public half in the wrong place is a different complaint', () => {
  // Sparkle matches the LAST 32 bytes. A blob with the public key anywhere else
  // is a layout generate_appcast will not accept, and saying "different
  // keypairs" would send somebody to re-export a key that is already correct.
  const pub = randomBytes(32)
  const wrong = b64(Buffer.concat([randomBytes(32), pub, randomBytes(32)]))
  assert.match(keypairProblem(b64(pub), wrong) ?? '', /not in its last 32 bytes/)
})

/**
 * The derivation that removed the second secret.
 *
 * A public key and a private key kept apart by hand drift, and drifted is
 * exactly the state `generate_appcast` refuses to report: it writes an unsigned
 * appcast and exits 0. Derived from the private key, they cannot.
 */

test('the public key comes back out of the private one', () => {
  const pub = randomBytes(32)
  // 96 bytes is what generate_keys -x writes: key material, then the public
  // half. 64 is the older form Sparkle still accepts - seed, then public.
  assert.equal(publicKeyFromPrivate(b64(Buffer.concat([randomBytes(64), pub]))), b64(pub))
  assert.equal(publicKeyFromPrivate(b64(Buffer.concat([randomBytes(32), pub]))), b64(pub))
  // Whitespace is what a copy-paste into a secret box leaves behind.
  assert.equal(publicKeyFromPrivate(`\n${b64(Buffer.concat([randomBytes(64), pub]))}\n`), b64(pub))
})

test('a key Sparkle would not accept is refused rather than half-read', () => {
  // Refusing beats deriving something plausible from the wrong bytes: a wrong
  // public key ships inside the app and rejects every update it is offered.
  assert.throws(() => publicKeyFromPrivate(''), /is empty/)
  assert.throws(() => publicKeyFromPrivate('   '), /is empty/)
  assert.throws(() => publicKeyFromPrivate('SUPublicEDKey'), /decodes to 9 bytes/)
  assert.throws(() => publicKeyFromPrivate(b64(randomBytes(48))), /Sparkle accepts 64 or 96/)
  // 102 characters is what turned up in a real export and is not a key.
  assert.throws(() => publicKeyFromPrivate('a'.repeat(102)), /Sparkle accepts 64 or 96/)
})

test('the derived key is what the keypair check then agrees with', () => {
  // The two halves of the fix have to meet: what is derived at pack time is
  // what the post-build check compares against the bundle.
  const priv = b64(Buffer.concat([randomBytes(64), randomBytes(32)]))
  assert.equal(keypairProblem(publicKeyFromPrivate(priv), priv), null)
})

test('a public key pasted into the private secret is named as such', () => {
  // What actually happened on v0.1.4. `generate_keys` prints the public key to
  // the screen and never prints the private one, so the value on screen is the
  // obvious thing to copy - and it is the wrong one.
  const pub = randomBytes(32)
  assert.throws(() => publicKeyFromPrivate(b64(pub)), /length of an ed25519 public key/)
  assert.throws(() => publicKeyFromPrivate(b64(pub)), /generate_keys -x/)
})

test('a public key in both secrets is refused, not called a match', () => {
  // A public key ends in itself, so a last-32-bytes comparison alone would call
  // this a matching pair and wave through a release nothing can sign.
  const pub = randomBytes(32)
  assert.match(keypairProblem(b64(pub), b64(pub)) ?? '', /decodes to 32 bytes/)
})
