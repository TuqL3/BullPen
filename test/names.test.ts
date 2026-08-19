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

test('the id a hire gets is the id the taken-check tested', () => {
  // main used to slug a hire's name with a second, near-identical function of
  // its own while asking `hireName` whether the name was free with this one.
  // On a long project they disagree: this caps at 32 characters and that did
  // not, so the availability check was looking at a different id from the one
  // the agent was actually spawned under.
  const long = 'a-very-long-lived-internal-platform-project'
  const full = new Set(PRESETS.map(slug))
  const handed: string[] = []
  for (let i = 0; i < 3; i++) {
    const name = hireName(long, (id) => full.has(id))
    assert.equal(full.has(slug(name)), false, `${name} was already taken`)
    full.add(slug(name))
    handed.push(slug(name))
  }
  assert.equal(new Set(handed).size, 3, 'three hires, three distinct ids')
})

test('every name a hire can get is already the id it will be spawned under', () => {
  // The one invariant that makes the two sides agree: whatever comes back,
  // slugging it again must not change it, or the roster is checking one id and
  // the floor is spawning another.
  const full = new Set<string>()
  for (const project of ['seo', '   ', 'a'.repeat(80), 'Dự án nội bộ rất dài của công ty']) {
    for (let i = 0; i < PRESETS.length + 5; i++) {
      const name = hireName(project, (id) => full.has(id))
      const id = slug(name)
      assert.equal(full.has(id), false, `${name} was handed out twice`)
      assert.ok(id.length <= 32, `${id} is too long for a directory name`)
      full.add(id)
    }
  }
})

