/**
 * Procedural pixel portraits.
 *
 * Deliberately generated rather than drawn: bundled character art is the one
 * part of this kind of app that carries a licence, and an agent roster needs a
 * face per agent with no artist in the loop. Same id always yields the same
 * face, so an agent keeps its identity across restarts.
 */

const HAIR = ['#2b2118', '#6b3f1d', '#c9922f', '#8a2f2f', '#4a4a52', '#d9d2c5', '#3d5a80']
const SKIN = ['#f2c9a0', '#e0aa7d', '#c08a5c', '#96603a', '#6b4426']
const SHIRT = ['#3e6fa8', '#6b8f4e', '#a84b4b', '#7a5aa8', '#c9843e', '#4a5560', '#2f7a72']
const EYE = '#241f1a'

/** 12x12 busts. '.' is transparent; H hair, S skin, E eye, T shirt. */
const TEMPLATES: string[][] = [
  [
    '............',
    '...HHHHHH...',
    '..HHHHHHHH..',
    '..HSSSSSSH..',
    '..SSSSSSSS..',
    '..SSESSESS..',
    '..SSSSSSSS..',
    '..SSSSSSSS..',
    '...SSSSSS...',
    '..TTTTTTTT..',
    '.TTTTTTTTTT.',
    '.TTTTTTTTTT.'
  ],
  [
    '............',
    '...HHHHHH...',
    '..HHHHHHHH..',
    '..HSSSSSSH..',
    '..HSSSSSSH..',
    '..HSESSESH..',
    '..HSSSSSSH..',
    '..HSSSSSSH..',
    '..HSSSSSSH..',
    '..TTTTTTTT..',
    '.TTTTTTTTTT.',
    '.TTTTTTTTTT.'
  ],
  [
    '............',
    '............',
    '..HHHHHHHH..',
    '..HHHHHHHH..',
    '..SSSSSSSS..',
    '..SSESSESS..',
    '..SSSSSSSS..',
    '..SSSSSSSS..',
    '...SSSSSS...',
    '..TTTTTTTT..',
    '.TTTTTTTTTT.',
    '.TTTTTTTTTT.'
  ]
]

/** djb2 - stable across runs and platforms, unlike anything hash-seeded. */
function hash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h >>> 0
}

export type Face = {
  grid: string[]
  colors: Record<string, string>
}

/**
 * @param seed  anything stable - the agent id, or a preset name the user picked
 * @param shirt overrides the derived shirt colour, so two agents can share a
 *              face and still be told apart at a glance
 */
export function faceFor(seed: string, shirt?: string): Face {
  const h = hash(seed)
  return {
    grid: TEMPLATES[h % TEMPLATES.length],
    colors: {
      H: HAIR[(h >>> 3) % HAIR.length],
      S: SKIN[(h >>> 7) % SKIN.length],
      T: shirt ?? SHIRT[(h >>> 11) % SHIRT.length],
      E: EYE
    }
  }
}

export const FACE_SIZE = 12

/** Derive a project name from a working directory, for the roster grouping. */
export function projectOf(cwd: string): string {
  return cwd.split(/[/\\]/).filter(Boolean).pop() ?? cwd
}

/** The roster you pick from in the add-agent wizard. */
export const PRESETS = [
  'Michael',
  'Jim',
  'Pam',
  'Dwight',
  'Kevin',
  'Angela',
  'Oscar',
  'Stanley',
  'Phyllis',
  'Andy',
  'Ryan',
  'Toby',
  'Creed',
  'Meredith'
] as const

/** Shirt colours offered in the wizard. Kept few on purpose - a picker with a
 *  hundred swatches makes the roster harder to read, not easier. */
export const SHIRT_CHOICES = ['#d4685f', '#5f9e63', '#3e8fa8', '#d4a72c', '#8a7ac9', '#d98b4a']

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
