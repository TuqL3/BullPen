/**
 * The roster of names, shared by the hire path in main and the wizard in the
 * renderer. Dependency-free on purpose: it is imported from both sides, and
 * anything Node-only in here would break the renderer bundle.
 */

/**
 * Who you can be on this floor.
 *
 * Neutral given names rather than roles: two agents on the same project are
 * usually doing the same kind of work, so "Backend" and "Backend-2" says less
 * than two names does, and a name is what you actually address in a message.
 */
export const PRESETS = [
  'Morgan',
  'Avery',
  'Quinn',
  'Reese',
  'Harper',
  'Ellis',
  'Rowan',
  'Sloane',
  'Blake',
  'Emery',
  'Finley',
  'Sawyer',
  'Marlowe',
  'Hollis'
] as const

/**
 * The name a newly hired agent gets.
 *
 * A name from the roster, not `seo-2`: hires are addressed by name in every
 * message the agents send each other, and a numbered slug reads as a machine id
 * rather than as someone on the floor. Falls back to the numbered form only
 * once the roster is exhausted - a wrong name is better than no hire.
 *
 * @param isTaken called with the slug of a candidate; true means unavailable
 */
export function hireName(project: string, isTaken: (id: string) => boolean): string {
  for (const name of PRESETS) {
    if (!isTaken(slug(name))) return name
  }
  // Past the roster the name is already a slug, so the id `isTaken` was asked
  // about is exactly the id the caller derives from what comes back. Built the
  // other way round - name first, slug after - `slug` capped `<32 chars>-2` at
  // 32 and swallowed the `-2`, so every number from 2 to 99 produced the same
  // id as the first one and a long-named project could only ever hire once.
  const stem = slug(project).slice(0, 24).replace(/-+$/, '') || 'agent'
  for (let n = 2; n < 100; n++) {
    const id = `${stem}-${n}`
    if (!isTaken(id)) return id
  }
  return `${stem}-${String(Date.now()).slice(-6)}`
}

/** Filesystem- and id-safe name. Agent ids become directory names. */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'agent'
  )
}

/**
 * The pty ids of the plain shells, which are not agents.
 *
 * One shell per agent, in that agent's directory: the tab follows the roster
 * selection the same way the terminal does, and a shell that stayed in the
 * boss's directory while the row below it changed was a shell in the wrong
 * repository - which is the kind of wrong that is only noticed after the
 * command has run.
 *
 * Here rather than written twice because both sides of the wire have to agree
 * on them and neither can import the other's modules: main routes `pty:*` on
 * these ids to a second PtyManager, and the renderer opens terminals on them.
 * `slug` above strips everything but `[a-z0-9-]`, so no hire can produce an id
 * with a `~` or a `:` in it and take a shell's place.
 */
export const SHELL_PREFIX = '~shell:'
export const shellId = (agentId: string): string => `${SHELL_PREFIX}${agentId}`
export const isShellId = (id: string): boolean => id.startsWith(SHELL_PREFIX)
