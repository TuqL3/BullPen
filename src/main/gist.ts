import { isBundle, type Bundle } from './sync.ts'

/**
 * The other machine, reached through a secret gist.
 *
 * A gist rather than a repo because the thing being synced is one JSON blob and
 * the rule is last-write-wins: git would offer merges, history and conflicts
 * for a question already answered with "whoever saved last". One file, two
 * calls, and the whole of it fits on a screen.
 *
 * The token comes from signing in through GitHub's device flow, and carries
 * the `gist` scope and nothing else. Which gist is not asked for either: the
 * account is the same on both machines and so is the file name, so the id is
 * looked up rather than carried across by hand.
 */

const API = 'https://api.github.com'
const FILE = 'bullpen.json'

export type Remote = { token: string; gist: string }

const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'content-type': 'application/json'
})

/** What GitHub said went wrong, in the words it used. */
const said = async (res: Response): Promise<string> => {
  try {
    const body = (await res.json()) as { message?: string }
    return body.message ? `${body.message} (${res.status})` : `GitHub answered ${res.status}.`
  } catch {
    return `GitHub answered ${res.status}.`
  }
}

/**
 * Who this token belongs to.
 *
 * `gist` is the only scope on it, and that is enough for this: GitHub answers
 * `/user` with the public half of the profile whatever the scopes are. Worth
 * asking because "signed in" on its own is not an answer to "signed in as
 * whom" - two accounts is the normal case for anybody with a work one, and
 * syncing a floor into the wrong account's gists is silent.
 */
export async function whoAmI(token: string): Promise<{ login?: string; error?: string }> {
  try {
    const res = await fetch(`${API}/user`, { headers: headers(token) })
    if (!res.ok) return { error: await said(res) }
    const body = (await res.json()) as { login?: string }
    return typeof body.login === 'string' ? { login: body.login } : { error: 'GitHub sent no login.' }
  } catch (err) {
    return { error: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * The gist this account already syncs through, if there is one.
 *
 * Same account, same file name: two machines signed in as the same person are
 * looking at the same list, so the id does not have to be carried between them
 * by hand. It used to - one machine pressed "make one" and the other had a
 * field to paste it into - which is a step that can only be got wrong, on a
 * setup whose whole premise is that both ends are the same GitHub account.
 *
 * Not found is not an error: it means this is the first machine.
 */
export async function findGist(token: string): Promise<{ gist?: string; error?: string }> {
  try {
    const res = await fetch(`${API}/gists?per_page=100`, { headers: headers(token) })
    if (!res.ok) return { error: await said(res) }
    const body = (await res.json()) as { id?: string; files?: Record<string, unknown> }[]
    const hit = Array.isArray(body) ? body.find((g) => g.files && FILE in g.files) : undefined
    return { gist: typeof hit?.id === 'string' ? hit.id : undefined }
  } catch (err) {
    return { error: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Make the gist this machine will sync through, and hand back its id.
 *
 * Secret rather than public - a floor is a set of instructions to agents with
 * shell access, and "secret" here means unlisted, not private. Anybody with the
 * URL can read it, which is why nothing in the bundle is a secret: no token, no
 * paths, no ports.
 */
export async function createGist(token: string, first: Bundle): Promise<{ gist?: string; error?: string }> {
  try {
    const res = await fetch(`${API}/gists`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        description: 'Bullpen — floors and settings',
        public: false,
        files: { [FILE]: { content: JSON.stringify(first, null, 2) } }
      })
    })
    if (!res.ok) return { error: await said(res) }
    const body = (await res.json()) as { id?: string }
    return body.id ? { gist: body.id } : { error: 'GitHub made the gist and did not say its id.' }
  } catch (err) {
    return { error: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** What is up there now, or nothing when the gist has never been written to. */
export async function readGist(r: Remote): Promise<{ bundle?: Bundle; error?: string }> {
  try {
    const res = await fetch(`${API}/gists/${r.gist}`, { headers: headers(r.token) })
    if (!res.ok) return { error: await said(res) }
    const body = (await res.json()) as { files?: Record<string, { content?: string; truncated?: boolean }> }
    const file = body.files?.[FILE]
    if (!file?.content) return {}
    // Over a megabyte GitHub sends a URL instead of the text. Floors are prose
    // and briefs; a floor set that big is not a sync problem.
    if (file.truncated) return { error: 'That gist is too big for Bullpen to read in one piece.' }
    const raw: unknown = JSON.parse(file.content)
    if (!isBundle(raw)) return { error: 'What is in that gist is not a Bullpen bundle.' }
    return { bundle: raw }
  } catch (err) {
    return { error: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Put this machine's version up, whole. */
export async function writeGist(r: Remote, b: Bundle): Promise<{ error?: string }> {
  try {
    const res = await fetch(`${API}/gists/${r.gist}`, {
      method: 'PATCH',
      headers: headers(r.token),
      body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(b, null, 2) } } })
    })
    return res.ok ? {} : { error: await said(res) }
  } catch (err) {
    return { error: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}` }
  }
}
