import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inline, parseMarkdown } from '../src/markdown.ts'

test('a memory file reads as blocks, not as one wall of text', () => {
  const doc = `# Rules

Always run the tests.

- reuse before writing
- **never** commit secrets

> ask before deleting

---

## Commands
`
  const blocks = parseMarkdown(doc)
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['heading', 'para', 'bullet', 'bullet', 'quote', 'rule', 'heading']
  )
  assert.equal(blocks[0].kind === 'heading' && blocks[0].level, 1)
  assert.equal(blocks[6].kind === 'heading' && blocks[6].level, 2)
})

test('a fenced block is code, whatever it looks like inside', () => {
  // The line that broke a first attempt at this: `# not a heading` inside a
  // fence, rendered as an h1 half way down a shell snippet.
  const doc = ['before', '```bash', '# not a heading', '- not a bullet', '```', 'after'].join('\n')
  const blocks = parseMarkdown(doc)
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['para', 'fence', 'para']
  )
  const fence = blocks[1]
  assert.equal(fence.kind === 'fence' && fence.lang, 'bash')
  assert.equal(fence.kind === 'fence' && fence.text, '# not a heading\n- not a bullet')
})

test('an unclosed fence swallows the rest rather than losing it', () => {
  const blocks = parseMarkdown('```\nstill code\nand more')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].kind === 'fence' && blocks[0].text, 'still code\nand more')
})

test('inline markers become spans, and backticks win', () => {
  assert.deepEqual(inline('run `npm test` first'), [
    { kind: 'text', text: 'run ' },
    { kind: 'code', text: 'npm test' },
    { kind: 'text', text: ' first' }
  ])
  // Asterisks inside code are asterisks: this is a memory file full of globs.
  assert.deepEqual(inline('`**/*.ts`'), [{ kind: 'code', text: '**/*.ts' }])
  assert.deepEqual(inline('**loud** and *quiet*'), [
    { kind: 'strong', text: 'loud' },
    { kind: 'text', text: ' and ' },
    { kind: 'em', text: 'quiet' }
  ])
  assert.deepEqual(inline('see [the docs](https://x.dev/a)'), [
    { kind: 'text', text: 'see ' },
    { kind: 'link', text: 'the docs', href: 'https://x.dev/a' }
  ])
})

test('nesting is kept for lists, and plain text survives untouched', () => {
  const blocks = parseMarkdown('- top\n  - nested\n1. first')
  assert.deepEqual(
    blocks.map((b) => (b.kind === 'bullet' ? [b.depth, b.ordered] : b.kind)),
    [
      [0, false],
      [1, false],
      [0, true]
    ]
  )
  assert.deepEqual(inline('nothing special here'), [
    { kind: 'text', text: 'nothing special here' }
  ])
})
