import { DEFAULT_WORKFLOW as BARE, PRESETS as SHIPPED } from '../src/main/presets.ts'
import type { CardRule, Workflow } from '../src/main/workflow.ts'

/**
 * The shipped floors, with card rules written on them.
 *
 * Bullpen ships no rules any more: an arrow is drawn by the operator and what
 * it does to the board is theirs to write, so a floor out of the box moves no
 * cards. That is the product, and it is useless for testing the router - which
 * is a machine for moving cards. So the rules that used to be built in live
 * here, as one floor's answer rather than everyone's, and the router tests run
 * against a floor somebody wrote.
 */
const HOUSE: CardRule[] = [
  { from: 'assigns', to: 'staff', status: 'open' },
  { from: 'speaksToHuman', to: 'staff', status: 'open' },
  { from: 'builds', to: 'assigns', status: 'wait_test' },
  { from: 'checks', to: 'builds', status: 'doing', whose: 'to' },
  { from: 'builds', to: 'checks', status: 'wait_test' },
  { from: 'checks', to: 'assigns', status: 'closes' },
  { from: 'assigns', to: 'speaksToHuman', status: 'done' },
  { from: 'speaksToHuman', to: 'you', status: 'done' }
]

/** The same eight, in the words each floor uses for them. */
const OWN: Record<string, CardRule[]> = {
  'content-floor': [
    { from: 'commissions', to: 'staff', status: 'open' },
    { from: 'speaks', to: 'staff', status: 'open' },
    { from: 'drafts', to: 'commissions', status: 'in_review' },
    { from: 'proofs', to: 'drafts', status: 'drafting', whose: 'to' },
    { from: 'drafts', to: 'proofs', status: 'in_review' },
    { from: 'proofs', to: 'commissions', status: 'closes' },
    { from: 'commissions', to: 'speaks', status: 'published' },
    { from: 'speaks', to: 'you', status: 'published' }
  ],
  'support-desk': [
    { from: 'triages', to: 'staff', status: 'open' },
    { from: 'speaks', to: 'staff', status: 'open' },
    { from: 'answers', to: 'triages', status: 'to_check' },
    { from: 'verifies', to: 'answers', status: 'answering', whose: 'to' },
    { from: 'answers', to: 'verifies', status: 'to_check' },
    { from: 'verifies', to: 'triages', status: 'closes' },
    { from: 'triages', to: 'speaks', status: 'sent' },
    { from: 'speaks', to: 'you', status: 'sent' }
  ]
}

const ruled = (w: Workflow): Workflow => ({ ...w, cardRules: OWN[w.name] ?? HOUSE })

export const DEFAULT_WORKFLOW = ruled(BARE)
export const PRESETS = SHIPPED.map(ruled)
