import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Model } from '../models.ts'

/**
 * The model a CLI would start on when Bullpen passes no flag.
 *
 * An agent hired with no `--model` reads as "its default" everywhere, and that
 * is the truth about the arguments - but it is not an answer to "what is it
 * running". The model it actually answered on is read off the transcript, and
 * that only exists once it has taken a turn: a floor just brought up had
 * nothing to show at all.
 *
 * So: the same files the CLI itself reads, in the order it reads them. Not a
 * guess and not a scrape of the startup banner - what is returned here is a
 * line somebody wrote in a config file, and when nobody wrote one this says so
 * by returning null rather than naming whatever is newest.
 */

/** `model`, or the environment variable a settings file may set instead. */
function modelIn(path: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      model?: unknown
      env?: { ANTHROPIC_MODEL?: unknown }
    }
    const named = typeof raw.model === 'string' ? raw.model : ''
    const fromEnv = typeof raw.env?.ANTHROPIC_MODEL === 'string' ? raw.env.ANTHROPIC_MODEL : ''
    return named.trim() || fromEnv.trim() || null
  } catch {
    // Absent, unreadable, or half-written: none of those is a model.
    return null
  }
}

/**
 * Claude Code's chain, closest to the agent first.
 *
 * `ANTHROPIC_MODEL` in the environment beats the files because it is what the
 * process is actually started with. Below it, a project's local settings beat
 * the project's, which beat the home directory's - the CLI's own order, and
 * the reason this reads three files instead of one.
 *
 * Only `claude`. Another CLI keeps its defaults somewhere else and in another
 * format, and a model read out of the wrong file is worse than no model at
 * all: it is the wrong answer to what somebody is paying for.
 */
export function configuredModel(
  cmd: string,
  cwd: string,
  home: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const base = (cmd ?? '').trim().split(/\s+/)[0]?.split(/[\\/]/).pop() ?? ''
  if (base !== 'claude') return null
  const fromEnv = (env.ANTHROPIC_MODEL ?? '').trim()
  if (fromEnv) return fromEnv
  for (const path of [
    join(cwd, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.json')
  ]) {
    const found = modelIn(path)
    if (found) return found
  }
  return null
}

/**
 * The model named in the CLI's own startup box, when nothing else knows one.
 *
 * Read from the terminal, which nothing else here does and which is worth
 * saying out loud: what an agent prints is not a status, and a floor driven by
 * regexes over somebody's scrollback is a floor that breaks on a version bump.
 *
 * The narrowness is the whole defence. Only the window that follows the
 * version line the CLI prints once at startup - not the scrollback, not the
 * status line, not anything the agent said - and only names Bullpen already
 * ships, matched longest first so `Opus 5 · 1M` is not read as `Opus 5`. An
 * agent discussing models in its own output cannot reach this; a CLI that
 * changes its banner returns null and the menu is back to saying nothing,
 * which is what it said before this existed.
 */
export function bannerModel(output: string, models: Model[]): string | null {
  // Colour first: what a pty carries is not text, it is text with escape codes
  // through the middle of it, and `Claude Code` arrives bold - which is to say
  // with a reset sequence sitting between it and its own version number.
  const plain = output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
  const box = /Claude Code\s+v[\d.]+([\s\S]{0,240})/.exec(plain)
  if (!box) return null
  const window = box[1]
  const named = [...models]
    .sort((a, b) => b.label.length - a.label.length)
    .find((m) => window.includes(m.label))
  return named?.id ?? null
}
