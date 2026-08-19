/**
 * Teach node the one Vite-ism main's source uses: `import x from './a.md?raw'`.
 *
 * Only so `src/main/index.ts` can be loaded by a test at all - it reads the
 * rules document that way, and without this the import is an unknown file
 * extension and nothing in that file can be exercised.
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./raw-hooks.mjs', pathToFileURL(import.meta.filename))
