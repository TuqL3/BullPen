import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type PidRecord = {
  pid: number
  /** A string that must appear in the live process's command line for it to be
   *  considered ours. Without this check, pid reuse would let the reaper kill
   *  an unrelated process that happens to hold the same number after a reboot. */
  marker: string
  cwd: string
  startedAt: number
}

export type ReapResult = {
  id: string
  pid: number
  outcome: 'killed' | 'already-gone' | 'not-ours'
}

const PID_FILE = 'pid.json'

export function writePid(agentHome: string, rec: PidRecord): void {
  mkdirSync(agentHome, { recursive: true })
  writeFileSync(join(agentHome, PID_FILE), JSON.stringify(rec, null, 2))
}

export function clearPid(agentHome: string): void {
  rmSync(join(agentHome, PID_FILE), { force: true })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but belongs to someone else - alive, but never ours.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The live command line for a pid, or '' if it cannot be read.
 *
 * ponytail: shells out rather than pulling in a process-list dependency.
 * Ceiling — one subprocess per stale pidfile, at startup only, so a handful of
 * execs on a cold start. If Bullpen ever tracks hundreds of agents, batch it
 * into a single `ps -o pid,args` sweep.
 */
export function processCommand(pid: number): string {
  try {
    if (process.platform === 'win32') {
      return execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
      )
    }
    // Linux exposes /proc; macOS does not, so fall through to ps there.
    const proc = `/proc/${pid}/cmdline`
    if (existsSync(proc)) return readFileSync(proc, 'utf8').replace(/\0/g, ' ')
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return ''
  }
}

/**
 * Kill agents left behind by a crash or SIGKILL of a previous run.
 *
 * A graceful quit runs PtyManager.killAll(); neither that nor any exit handler
 * runs when the main process is killed hard, so the only place an orphan can be
 * cleaned up is the next startup. Call this BEFORE spawning anything new.
 *
 * Refuses to kill anything whose live command line does not contain the marker
 * recorded at spawn time - a stale pidfile pointing at a recycled pid must
 * never take out an unrelated process.
 */
export function reapOrphans(agentsRoot: string): ReapResult[] {
  const out: ReapResult[] = []
  let ids: string[]
  try {
    ids = readdirSync(agentsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return out
  }

  for (const id of ids) {
    const home = join(agentsRoot, id)
    const file = join(home, PID_FILE)
    let rec: PidRecord
    try {
      rec = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue // no pidfile, or unreadable - nothing claimed to be running
    }

    if (!Number.isInteger(rec.pid) || rec.pid <= 0 || !rec.marker) {
      rmSync(file, { force: true })
      continue
    }

    if (!isAlive(rec.pid)) {
      out.push({ id, pid: rec.pid, outcome: 'already-gone' })
      rmSync(file, { force: true })
      continue
    }

    if (!processCommand(rec.pid).includes(rec.marker)) {
      // Pid reuse, or a process we have no business touching.
      out.push({ id, pid: rec.pid, outcome: 'not-ours' })
      rmSync(file, { force: true })
      continue
    }

    try {
      process.kill(rec.pid, 'SIGTERM')
    } catch {
      // Raced with its own exit; the SIGKILL below is a no-op then.
    }
    out.push({ id, pid: rec.pid, outcome: 'killed' })
    rmSync(file, { force: true })
  }
  return out
}

/**
 * Second pass for anything that ignored SIGTERM. Separate from reapOrphans so
 * the caller decides how long to wait rather than blocking startup on a sleep.
 */
export function forceKill(results: ReapResult[]): void {
  for (const r of results) {
    if (r.outcome !== 'killed') continue
    try {
      if (isAlive(r.pid)) process.kill(r.pid, 'SIGKILL')
    } catch {
      // Already dead - the desired state.
    }
  }
}
