import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
// @ts-expect-error - plain JS release tooling, no types and none wanted
import { keypairProblem, publicKeyFromPrivate } from '../scripts/check-sparkle-keypair.mjs'

/**
 * The check that stands between a broken signing key and a release that updates
 * nobody.
 *
 * `generate_appcast` answers this same question by writing an unsigned appcast
 * and exiting 0, which is why it is asked here first.
 */

const b64 = (b: Buffer): string => b.toString('base64')
/** The older Sparkle format: key material with the public half appended. */
const legacy = (pub: Buffer): string => b64(Buffer.concat([randomBytes(64), pub]))

/**
 * The derivation, against the only fixed points there are.
 *
 * RFC 8032 section 7.1, vectors 1 and 2. Sparkle *signs* with orlp/ed25519,
 * whose nonce derivation node cannot reproduce, so "the signature libraries
 * differ, therefore key generation differs" is an easy and wrong conclusion to
 * reach. These pin it: key generation is standard, and a seed exported by
 * `generate_keys -x` yields the public key `generate_keys -p` prints.
 */
const VECTORS = [
  {
    seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    pub: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
  },
  {
    seed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    pub: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'
  }
]

test('a 32-byte seed derives the public key RFC 8032 says it should', () => {
  for (const { seed, pub } of VECTORS) {
    const got = publicKeyFromPrivate(b64(Buffer.from(seed, 'hex')))
    assert.equal(Buffer.from(got, 'base64').toString('hex'), pub)
  }
})

test('the current generate_keys -x format is accepted', () => {
  // 32 bytes, 44 base64 characters. Rejecting this - which an earlier version
  // of the length check did - refuses the only format Sparkle exports today,
  // and cost three tags to work that out.
  const seed = randomBytes(32)
  const pub = publicKeyFromPrivate(b64(seed))
  assert.equal(Buffer.from(pub, 'base64').length, 32)
  assert.equal(keypairProblem(pub, b64(seed)), null)
})

test('the older formats still read their public half off the end', () => {
  const pub = randomBytes(32)
  assert.equal(publicKeyFromPrivate(legacy(pub)), b64(pub))
  assert.equal(publicKeyFromPrivate(b64(Buffer.concat([randomBytes(32), pub]))), b64(pub))
  // Whitespace is what a copy-paste into a secret box leaves behind.
  assert.equal(publicKeyFromPrivate(`\n${legacy(pub)}\n`), b64(pub))
})

test('a key Sparkle would not accept is refused rather than half-read', () => {
  // Refusing beats deriving something plausible from the wrong bytes: a wrong
  // public key ships inside the app and rejects every update it is offered.
  assert.throws(() => publicKeyFromPrivate(''), /is empty/)
  assert.throws(() => publicKeyFromPrivate('   '), /is empty/)
  // "9 bytes" is what an earlier version of this said, and it was a number
  // node invented by dropping the characters it did not like. This is not
  // base64 at all, and saying so is the honest answer.
  assert.throws(() => publicKeyFromPrivate('SUPublicEDKey'), /not valid base64/)
  assert.throws(() => publicKeyFromPrivate(b64(randomBytes(48))), /Sparkle accepts 32, 64, 96/)
  // 102 characters was measured off a real export once and used to explain two
  // failures it had nothing to do with. It is not a length base64 can be, and
  // that is all this can honestly say about it.
  assert.throws(() => publicKeyFromPrivate('a'.repeat(102)), /not valid base64/)
})

test('a matching pair passes', () => {
  const pub = randomBytes(32)
  assert.equal(keypairProblem(b64(pub), legacy(pub)), null)
  // Trailing whitespace is what a copy-paste into a secret box leaves behind.
  assert.equal(keypairProblem(`${b64(pub)}\n`, `${legacy(pub)}\n`), null)
})

test('two halves of different keypairs are refused', () => {
  const problem = keypairProblem(b64(randomBytes(32)), legacy(randomBytes(32)))
  assert.match(problem ?? '', /not two halves of one keypair/)
  // The message has to say what to run, not only what is wrong.
  assert.match(problem ?? '', /generate_keys -x/)
})

test('the public key pasted into the private secret is named as such', () => {
  // A seed and a public key are both 32 bytes, so length cannot tell them
  // apart - but the same value in both secrets can only be this mistake.
  const pub = b64(randomBytes(32))
  const problem = keypairProblem(pub, pub)
  assert.match(problem ?? '', /PRIVATE_KEY holds the public key/)
  assert.match(problem ?? '', /never prints the private one/)
})

test('the name of the plist key, pasted instead of its value, is refused', () => {
  // `SUPublicEDKey` is what the key is called in Info.plist, not what goes in
  // it. It is also not base64, which is the first thing wrong with it.
  const problem = keypairProblem('SUPublicEDKey', legacy(randomBytes(32)))
  assert.match(problem ?? '', /PUBLIC_KEY is not valid base64/)
})

test('the packaging placeholder is caught before it can ship', () => {
  const problem = keypairProblem('SPARKLE_ED_PUBLIC_KEY_PLACEHOLDER', legacy(randomBytes(32)))
  assert.match(problem ?? '', /placeholder/)
})

test('an empty secret is reported as empty, not as a mismatch', () => {
  assert.match(keypairProblem('', legacy(randomBytes(32))) ?? '', /PUBLIC_KEY is empty/)
  assert.match(keypairProblem(b64(randomBytes(32)), '') ?? '', /PRIVATE_KEY is empty/)
  assert.match(keypairProblem('  ', legacy(randomBytes(32))) ?? '', /PUBLIC_KEY is empty/)
})

test('the derived key is what the keypair check then agrees with', () => {
  // The two halves of the fix have to meet: what is derived at pack time is
  // what the post-build check compares against the bundle. Both formats.
  for (const priv of [b64(randomBytes(32)), legacy(randomBytes(32))]) {
    assert.equal(keypairProblem(publicKeyFromPrivate(priv), priv), null)
  }
})

test('a key that only decodes because node is lenient is refused', () => {
  // The v0.1.6 failure. `Buffer.from(x, 'base64')` drops characters outside the
  // alphabet instead of failing, so all three of these decode to exactly 32
  // bytes and sail past a length check - and generate_appcast, whose decoder is
  // strict, then refuses the same value after a ten-minute build.
  const seed = b64(randomBytes(32))
  const mangled = [`"${seed}"`, `${seed.slice(0, 20)}\n${seed.slice(20)}`, `'${seed}'`]
  for (const bad of mangled) {
    assert.equal(Buffer.from(bad, 'base64').length, 32, 'precondition: node decodes it')
    assert.throws(() => publicKeyFromPrivate(bad), /not valid base64/)
    assert.throws(() => publicKeyFromPrivate(bad), /outside the base64 alphabet/)
  }
})

test('one stray character is located, so it can be recognised', () => {
  // "45 characters, 1 of them outside the alphabet" says something is wrong.
  // Where it is says what it is, and a position is not key material.
  const seed = b64(randomBytes(32))
  // zsh prints a reverse-video "%" for a file with no trailing newline, and it
  // comes along with the copy. This is what v0.1.7 actually hit.
  assert.throws(() => publicKeyFromPrivate(`${seed}%`), /at the very end/)
  assert.throws(() => publicKeyFromPrivate(`${seed}%`), /zsh prints/)
  // A wrapped paste puts it in the middle instead.
  const wrapped = `${seed.slice(0, 20)}\n${seed.slice(20)}`
  assert.throws(() => publicKeyFromPrivate(wrapped), /at character 21 of 45/)
  assert.throws(() => publicKeyFromPrivate(wrapped), /wrapped paste/)
  // And the fix is in the message, not only the diagnosis.
  assert.throws(() => publicKeyFromPrivate(`${seed}%`), /pbcopy/)
})

test('the stray character is named by code point, not left to guesswork', () => {
  // The culprit is not part of the key, so naming it leaks nothing - and
  // "U+0025" ends the argument about whether it is zsh's "%" or something else.
  const seed = b64(randomBytes(32))
  assert.throws(() => publicKeyFromPrivate(`${seed}%`), /U\+0025/)
  // A zero-width space survives trim() and is invisible in every editor, which
  // is exactly why it has to be named rather than described.
  assert.throws(() => publicKeyFromPrivate(`${seed}\u200b`), /U\+200B/)
  assert.throws(() => publicKeyFromPrivate(`${seed}"`), /U\+0022/)
})

test('an unpadded key is not treated as mangled', () => {
  // Refusing a key that is merely missing its "=" would be one more false
  // alarm, and this file has raised enough of those.
  const seed = randomBytes(32)
  assert.equal(publicKeyFromPrivate(b64(seed).replace(/=+$/, '')), publicKeyFromPrivate(b64(seed)))
})

test('a public key that is not base64 is named before it is measured', () => {
  const problem = keypairProblem(`"${b64(randomBytes(32))}"`, b64(randomBytes(32)))
  assert.match(problem ?? '', /PUBLIC_KEY is not valid base64/)
})
