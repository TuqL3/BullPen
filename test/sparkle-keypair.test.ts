import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
// @ts-expect-error - plain JS release tooling, no types and none wanted
import { keypairProblem } from '../scripts/check-sparkle-keypair.mjs'

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
