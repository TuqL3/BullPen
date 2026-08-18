import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_BODY, newToken, Webhooks } from '../src/main/webhook.ts'

async function up(): Promise<{ hooks: Webhooks; url: string; token: string }> {
  const hooks = new Webhooks()
  const token = newToken()
  // Port 0: the OS picks a free one, so the tests never collide with a real run.
  const port = await hooks.start(0, token)
  return { hooks, url: `http://127.0.0.1:${port}/task`, token }
}

const post = (url: string, body: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { method: 'POST', body, headers })

test('a task needs the token, the route and the method', async () => {
  const { hooks, url, token } = await up()
  const caught: unknown[] = []
  hooks.on('task', (t) => caught.push(t))

  assert.equal((await post(url, '{"body":"go"}')).status, 401, 'no token')
  assert.equal((await post(url, '{"body":"go"}', { 'x-bullpen-token': 'nope' })).status, 401)
  assert.equal((await fetch(url, { method: 'GET' })).status, 404, 'GET is not a way in')
  assert.equal(
    (await post(url.replace('/task', '/'), '{"body":"go"}', { 'x-bullpen-token': token })).status,
    404,
    'and there is one route'
  )
  assert.deepEqual(caught, [], 'none of that reached the floor')
  await hooks.stop()
})

test('a valid task is accepted once and handed on', async () => {
  const { hooks, url, token } = await up()
  const caught: { to?: string; subject?: string; body: string }[] = []
  hooks.on('task', (t) => caught.push(t))

  const res = await post(url, JSON.stringify({ to: 'morgan', body: 'ship the sitemap' }), {
    'x-bullpen-token': token,
    'content-type': 'application/json'
  })
  assert.equal(res.status, 202)
  assert.deepEqual(await res.json(), { accepted: true, to: 'morgan', subject: 'ship the sitemap' })
  assert.equal(caught.length, 1)
  assert.equal(caught[0].to, 'morgan')
  assert.equal(caught[0].body, 'ship the sitemap')

  // Nothing to do is the one thing that is refused.
  assert.equal((await post(url, '   ', { 'x-bullpen-token': token })).status, 400)
  assert.equal(caught.length, 1)
  await hooks.stop()
})

test('a bare line of text is a task, with no json to write', async () => {
  const { hooks, url, token } = await up()
  const caught: { to?: string; subject: string; body: string; from: string }[] = []
  hooks.on('task', (t) => caught.push(t))

  // curl -d 'fix the build' with no headers beyond the token: the shape most
  // senders can manage without a translator script.
  const res = await post(url, 'the nightly build is red, find out why', {
    'x-bullpen-token': token
  })
  assert.equal(res.status, 202)
  assert.equal(caught[0].body, 'the nightly build is red, find out why')
  assert.equal(caught[0].subject, 'the nightly build is red, find out why', 'first line is the title')
  assert.equal(caught[0].to, undefined, 'unaddressed, so the floor decides')

  // The path addresses an agent, for senders that can only be given a URL.
  await post(`${url}/morgan`, 'take the sitemap', { 'x-bullpen-token': token })
  assert.equal(caught[1].to, 'morgan')
  await hooks.stop()
})

test('a token may travel as a bearer, and a sender may name itself', async () => {
  const { hooks, url, token } = await up()
  const caught: { from: string }[] = []
  hooks.on('task', (t) => caught.push(t))

  const res = await post(url, 'deploy finished', {
    authorization: `Bearer ${token}`,
    'x-bullpen-from': 'deploy-bot'
  })
  assert.equal(res.status, 202, 'half of everything can only set Authorization')
  assert.equal(caught[0].from, 'deploy-bot')

  // No header: the user agent is a good enough name for the log.
  await post(url, 'ping', { 'x-bullpen-token': token, 'user-agent': 'GitHub-Hookshot/abc' })
  assert.equal(caught[1].from, 'GitHub-Hookshot')
  await hooks.stop()
})

test("somebody else's payload is summarised, not rejected", async () => {
  const { hooks, url, token } = await up()
  const caught: { subject: string; body: string }[] = []
  hooks.on('task', (t) => caught.push(t))

  // A GitHub-shaped push: no `body` field anywhere in it.
  const push = { action: 'opened', ref: 'refs/heads/main', pusher: { name: 'lukas' }, size: 3 }
  const res = await post(url, JSON.stringify(push), {
    'x-bullpen-token': token,
    'content-type': 'application/json'
  })
  assert.equal(res.status, 202)
  assert.equal(caught[0].subject, 'opened', 'a title is taken from whatever reads like one')
  assert.match(caught[0].body, /ref: refs\/heads\/main/, 'the scalars are listed')
  assert.match(caught[0].body, /full payload:/, 'and the whole thing follows')
  await hooks.stop()
})

test('a refused call is announced rather than swallowed', async () => {
  const { hooks, url } = await up()
  const refused: { from: string; why: string }[] = []
  hooks.on('refused', (r) => refused.push(r))

  await post(url, 'go', { 'x-bullpen-token': 'wrong', 'x-bullpen-from': 'ci' })
  assert.deepEqual(refused, [{ from: 'ci', why: 'bad token' }], 'a misconfigured sender is visible')
  await hooks.stop()
})

test('an oversized body is refused, not buffered', async () => {
  const { hooks, url, token } = await up()
  const caught: unknown[] = []
  hooks.on('task', (t) => caught.push(t))

  const huge = JSON.stringify({ body: 'x'.repeat(MAX_BODY + 1000) })
  await post(url, huge, { 'x-bullpen-token': token }).catch(() => null)
  assert.deepEqual(caught, [], 'nothing was delivered')
  await hooks.stop()
})

test('stopping closes the door', async () => {
  const { hooks, url, token } = await up()
  await hooks.stop()
  assert.equal(hooks.running, false)
  await assert.rejects(() => post(url, '{"body":"go"}', { 'x-bullpen-token': token }))
})
