import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hive } from '../src/main/hive.ts'

function fresh(): { hive: Hive; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'bullpen-test-'))
  return { hive: new Hive(root), root }
}

test('direct message reaches exactly one inbox', () => {
  const { hive, root } = fresh()
  hive.register('michael')
  hive.register('dwight')
  hive.register('jim')

  hive.send({ from: 'michael', to: 'dwight', subject: 'sales', body: 'call the client' })
  const made = hive.route()

  assert.equal(made.length, 1)
  assert.equal(hive.peekInbox('jim').length, 0, 'must not leak to third party')
  const got = hive.drainInbox('dwight')
  assert.equal(got.length, 1)
  assert.equal(got[0].body, 'call the client')
  assert.equal(hive.drainInbox('dwight').length, 0, 'drain must consume')
  rmSync(root, { recursive: true, force: true })
})

test('broadcast hits everyone but the sender', () => {
  const { hive, root } = fresh()
  for (const id of ['michael', 'dwight', 'jim']) hive.register(id)

  hive.send({ from: 'michael', to: '*', subject: 'meeting', body: 'conference room' })
  hive.route()

  assert.equal(hive.drainInbox('michael').length, 0, 'sender must not receive own broadcast')
  assert.equal(hive.drainInbox('dwight').length, 1)
  assert.equal(hive.drainInbox('jim').length, 1)
  rmSync(root, { recursive: true, force: true })
})

test('unknown recipient goes to dead, does not throw', () => {
  const { hive, root } = fresh()
  hive.register('michael')

  const dead: unknown[] = []
  hive.on('dead', (m) => dead.push(m))
  hive.send({ from: 'michael', to: 'nobody', subject: 'x', body: 'y' })
  const made = hive.route()

  assert.equal(made.length, 0)
  assert.equal(dead.length, 1)
  rmSync(root, { recursive: true, force: true })
})

test('malformed file is dropped, router keeps going', () => {
  const { hive, root } = fresh()
  hive.register('michael')
  hive.register('dwight')

  writeFileSync(join(hive.agentDir('michael'), 'outbox', '0-bad.json'), '{ not json')
  hive.send({ from: 'michael', to: 'dwight', subject: 'ok', body: 'still delivered' })

  const made = hive.route()
  assert.equal(made.length, 1, 'good message must survive a bad sibling')
  assert.equal(hive.drainInbox('dwight')[0].body, 'still delivered')
  rmSync(root, { recursive: true, force: true })
})

test('route is idempotent - a delivered message is not re-delivered', () => {
  const { hive, root } = fresh()
  hive.register('michael')
  hive.register('dwight')

  hive.send({ from: 'michael', to: 'dwight', subject: 'once', body: 'only once' })
  hive.route()
  hive.route()
  hive.route()

  assert.equal(hive.peekInbox('dwight').length, 1, 'must not duplicate on re-route')
  rmSync(root, { recursive: true, force: true })
})
