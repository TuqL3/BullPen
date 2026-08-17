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
  const base = slug(project) || 'agent'
  for (let n = 2; n < 100; n++) {
    if (!isTaken(slug(`${base}-${n}`))) return `${base}-${n}`
  }
  return `${base}-${Date.now()}`
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
