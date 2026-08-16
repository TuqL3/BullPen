/**
 * Close inherited descriptors in the pty child before it execs.
 *
 * node-pty's Unix path is forkpty() + execvp(), and fork copies the parent's
 * entire descriptor table. Electron main holds one pty master per running
 * agent, so agent N was starting with the master ends of agents 1..N-1 open:
 * measured as 0, 1 and 2 inherited /dev/ptmx handles for the first, second and
 * third agent. An agent holding another's terminal master keeps that terminal
 * from ever reaching EOF, so the leak outlives the agent that caused it - and
 * every one of Electron's own sockets and shared-memory handles rode along too.
 *
 * The upstream macOS path already gets this right via POSIX_SPAWN_CLOEXEC_DEFAULT;
 * only the fork path needs it, which is why the patch is guarded the same way
 * upstream guards that branch.
 *
 * Applied before electron-rebuild, so the change is compiled in. Idempotent, and
 * loud if node-pty moves the anchors - a silent no-op here would look exactly
 * like a fixed leak.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = new URL('../node_modules/node-pty/src/unix/pty.cc', import.meta.url)
const MARK = 'bullpen_close_inherited_fds'

const HELPER_ANCHOR = `struct DelBuf {`
const HELPER = `/**
 * Close every descriptor above stdio. Runs between fork and exec, so nothing
 * here may be async-signal-unsafe: close_range(2) and close(2) both are.
 *
 * Guarded like the fork path it serves - macOS spawns instead, and defining an
 * unused static there is a warning some builds treat as an error.
 */
#if !defined(__APPLE__)
static void bullpen_close_inherited_fds() {
#if defined(__linux__) && defined(SYS_close_range)
  if (syscall(SYS_close_range, 3, ~0U, 0) == 0) return;
#endif
  long max = sysconf(_SC_OPEN_MAX);
  // A container can report a limit in the millions; walking it would stall the
  // child far longer than any real descriptor table needs.
  if (max < 0 || max > 65536) max = 65536;
  for (int fd = 3; fd < (int)max; fd++) close(fd);
}
#endif

`

const CALL_ANCHOR = `    case 0:
      if (strlen(cwd_.c_str())) {`
const CALL = `    case 0:
      // The pty slave is already stdin/stdout/stderr by now; everything above
      // it belongs to Electron, not to the agent. See scripts/patch-node-pty.mjs.
      bullpen_close_inherited_fds();

      if (strlen(cwd_.c_str())) {`

const INCLUDE_ANCHOR = `#include <fcntl.h>`
const INCLUDE = `#include <fcntl.h>
#include <sys/syscall.h>`

let src = readFileSync(FILE, 'utf8')
if (src.includes(MARK)) {
  console.log('[bullpen] node-pty already patched')
  process.exit(0)
}

for (const [anchor, what] of [
  [INCLUDE_ANCHOR, 'include'],
  [HELPER_ANCHOR, 'helper'],
  [CALL_ANCHOR, 'call site']
]) {
  if (src.includes(anchor)) continue
  console.error(
    `[bullpen] cannot patch node-pty: the ${what} anchor is gone.\n` +
      `  Re-read node_modules/node-pty/src/unix/pty.cc and update scripts/patch-node-pty.mjs.\n` +
      `  Leaving it unpatched would silently reintroduce the descriptor leak.`
  )
  process.exit(1)
}

src = src.replace(INCLUDE_ANCHOR, INCLUDE)
src = src.replace(HELPER_ANCHOR, HELPER + HELPER_ANCHOR)
src = src.replace(CALL_ANCHOR, CALL)
writeFileSync(FILE, src, 'utf8')
console.log('[bullpen] patched node-pty to close inherited fds before exec')
