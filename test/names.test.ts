import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PRESETS, hireName, slug } from '../src/names.ts'

test('a hire gets a name off the roster, not a numbered slug', () => {
  assert.equal(hireName('seo', () => false), PRESETS[0])
})

test('names already on the floor are skipped, never reused', () => {
  const taken = new Set([slug(PRESETS[0]), slug(PRESETS[1])])
  assert.equal(hireName('seo', (id) => taken.has(id)), PRESETS[2])

  // Every hire in turn, with nobody leaving: the roster must not repeat.
  const seen = new Set<string>()
  for (let i = 0; i < PRESETS.length; i++) {
    const name = hireName('seo', (id) => seen.has(id))
    assert.equal(seen.has(slug(name)), false, `${name} handed out twice`)
    seen.add(slug(name))
  }
  assert.equal(seen.size, PRESETS.length)
})

test('an exhausted roster falls back to the project form rather than failing', () => {
  const full = new Set(PRESETS.map(slug))
  assert.equal(hireName('seo', (id) => full.has(id)), 'seo-2')
  full.add('seo-2')
  assert.equal(hireName('seo', (id) => full.has(id)), 'seo-3')
  // A project whose name slugs to nothing still has to produce a usable id.
  assert.equal(hireName('   ', (id) => full.has(id)), 'agent-2')
})

test('slug produces an id safe to use as a directory name', () => {
  assert.equal(slug('Morgan'), 'morgan')
  assert.equal(slug('Renée O’Brien'), 'renee-o-brien')
  assert.equal(slug('///'), 'agent')
  assert.ok(slug('x'.repeat(80)).length <= 32)
})
