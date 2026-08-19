/**
 * How the app is drawn on this machine.
 *
 * Not the workflow: the workflow is the floor, and you would hand it to
 * somebody else. This is terminal size and paint colour - the same floor on a
 * different screen wants different numbers, and neither belongs in a document
 * describing who reports to whom.
 *
 * Module state for the same reason `shape.ts` is: a canvas frame and a terminal
 * that lives outside React both need it, and threading a prop into either is
 * more plumbing than the two values are worth.
 */
export type Prefs = { fontSize: number; floor: string }

let prefs: Prefs = { fontSize: 12.5, floor: 'green' }

export const setPrefs = (next: Prefs): void => {
  prefs = next
}

export const getPrefs = (): Prefs => prefs
