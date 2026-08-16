/**
 * Claude Code asks an interactive "do you trust this folder?" question the first
 * time it runs in an unknown directory, and will sit on it forever. Bullpen
 * answers it once, on the human's behalf, because the human already designated
 * that exact directory as the agent's sandbox in the add-agent wizard.
 *
 * That is the whole justification, so the guards below exist to keep it from
 * becoming anything more general than that. A harness that clicks through
 * safety dialogs in general is a harness that will click through the next one.
 */

/** How long after spawn an agent may still be auto-trusted. */
export const TRUST_WINDOW_MS = 120_000

/** Enough to hold the prompt even at a wide terminal; older output is dropped. */
export const TRUST_BUFFER = 8000

const ANSI = /\[[0-?]*[ -/]*[@-~]|\][^]*(?:|\\)|[@-Z\\-_]/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

/**
 * True only for the real workspace-trust prompt, for THIS agent's sandbox.
 *
 * The pty hard-wraps at the terminal width, so a path or a sentence can be
 * split mid-token; both checks are done against whitespace-stripped text rather
 * than trying to guess where the wraps landed.
 */
export function isTrustPrompt(buffer: string, sandbox: string): boolean {
  const clean = stripAnsi(buffer).toLowerCase()
  const squashed = clean.replace(/\s+/g, '')

  const asksToTrust =
    squashed.includes('yes,itrustthisfolder') || squashed.includes('doyoutrustthefilesinthisfolder')
  if (!asksToTrust) return false

  // The prompt must name the directory the human picked. Anything else - a
  // nested repo, a path the agent cd'd into, text an agent printed itself - is
  // a question Bullpen has no mandate to answer.
  const target = sandbox.toLowerCase().replace(/\s+/g, '')
  return target.length > 1 && squashed.includes(target)
}

export type TrustWatch = {
  sandbox: string
  buffer: string
  answered: boolean
  deadline: number
}

export function newWatch(sandbox: string, now: number): TrustWatch {
  return { sandbox, buffer: '', answered: false, deadline: now + TRUST_WINDOW_MS }
}

/**
 * Feed pty output in. Returns true exactly once, when the trust prompt for this
 * agent's own sandbox shows up inside the window.
 */
export function feed(watch: TrustWatch, chunk: string, now: number): boolean {
  if (watch.answered || now > watch.deadline) return false
  watch.buffer = (watch.buffer + chunk).slice(-TRUST_BUFFER)
  if (!isTrustPrompt(watch.buffer, watch.sandbox)) return false
  watch.answered = true
  watch.buffer = ''
  return true
}
