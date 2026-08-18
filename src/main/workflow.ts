import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import {
  CAPABILITIES,
  generatorBrief,
  HIRE_PARTY,
  HUMAN_PARTY,
  type Capability
} from '../workflow-spec.ts'

/**
 * A workflow is the shape of the floor: who exists, who may write to whom, what
 * each of them is told at spawn, and what a message between two of them does to
 * the task board.
 *
 * All four used to be code - a `Role` union, a `TALKS_TO` table, three brief
 * functions and a chain of if/else in the router - which meant the floor could
 * only ever run the one workflow its author happened to want. Somebody else's
 * floor has different people on it, and that is the whole reason this file
 * exists: the workflow is data, and the code reads it.
 */

/**
 * What a role does, as capabilities rather than a name.
 *
 * The router has to know what a message means without knowing what anyone is
 * called. "A builder reported to a planner" moves a card the same way whether
 * the roles are called dev/analyst or engineer/lead. A role may hold more than
 * one: on a small floor the same agent both talks to the human and hands out
 * the work, and a single label could not say that.
 *
 * Defined with the rest of the format in `workflow-spec.ts`, and re-exported
 * here so callers have one import for the whole of a workflow.
 */
export { CAPABILITIES, HIRE_PARTY, HUMAN_PARTY, type Capability }

export type RoleDef = {
  /** What this role does. Empty is legal but inert - it can only carry mail. */
  can: Capability[]
  /**
   * How a refusal names this role to the agent that tripped it: "the boss does
   * not write to a tester". Written to be read mid-sentence, article included.
   */
  label: string
  /**
   * A role with a fixed agent is part of the floor rather than staff on it: it
   * is spawned at launch under this exact id, and it cannot be fired. Roles
   * without one are hired into.
   */
  fixed?: { id: string; name: string }
  /** Whether the wizard and the `hire` address may create one of these. */
  hireable?: boolean
  /**
   * What an agent of this role is told at spawn, appended to whatever its
   * CLAUDE.md says. `{{...}}` placeholders are filled by `renderBrief`.
   */
  brief: string
}

export type Workflow = {
  name: string
  /** One line, shown where a workflow is picked. */
  description: string
  roles: Record<string, RoleDef>
  /**
   * Who may write to whom. Keys and values are role names, plus two addresses
   * that are not roles: `you` (the human) and `hire` (ask for a new agent).
   *
   * The chain is only a chain if the shortcuts are shut, and a briefing is
   * advice where this is enforcement - an agent that asks anyway gets the
   * message handed back with somewhere else to send it.
   */
  talksTo: Record<string, string[]>
  /** The role a task typed at the floor goes to first. */
  dispatch: string
  /** The role inbound work - webhooks, schedules - goes to. Often not dispatch. */
  entry: string
  /** Reuse an idle agent under this much context, in percent. */
  reuseBelowPct: number
  /** Over this much, treat an idle agent as unavailable. */
  hireAbovePct: number
}

/**
 * A blank left unfilled in the starter: `«Display Name»`.
 *
 * Its own brackets rather than `<...>`, because a brief is full of `<the task>`
 * and `<what you changed>` - those are instructions to the agent about what to
 * write in a message, and they belong there. A blank the operator was meant to
 * replace has to be distinguishable from a blank the agent is meant to fill.
 */
const BLANK = /«[^»]*»/

const PARTY_LABEL: Record<string, string> = {
  [HUMAN_PARTY]: 'the human',
  [HIRE_PARTY]: 'hiring'
}

/** Every role that can do `cap`. */
export const rolesWith = (w: Workflow, cap: Capability): string[] =>
  Object.keys(w.roles).filter((r) => w.roles[r].can.includes(cap))

export const can = (w: Workflow, role: string, cap: Capability): boolean =>
  w.roles[role]?.can.includes(cap) ?? false

/** The roles nobody can fire: they have a fixed agent and no way to re-hire. */
export const coreRoles = (w: Workflow): string[] =>
  Object.keys(w.roles).filter((r) => w.roles[r].fixed)

/** The agent id a fixed role runs under, or null when the role is hired into. */
export const fixedId = (w: Workflow, role: string): string | null =>
  w.roles[role]?.fixed?.id ?? null

/** The role a fixed agent id belongs to, or null. */
export const roleOfFixedId = (w: Workflow, id: string): string | null =>
  Object.keys(w.roles).find((r) => w.roles[r].fixed?.id === id) ?? null

const nameOf = (w: Workflow, party: string): string =>
  PARTY_LABEL[party] ?? w.roles[party]?.label ?? party

/**
 * Why this message is not going through, or null when it is.
 *
 * The reason is written for whoever sent it: it says where to send it instead,
 * because a refusal an agent cannot act on just becomes silence.
 */
export function refuseMail(w: Workflow, from: string, to: string): string | null {
  const allowed = w.talksTo[from]
  if (allowed?.includes(to)) return null
  const instead = (allowed ?? []).map((p) => nameOf(w, p)).join(', ')
  if (!instead) {
    return `On this floor ${nameOf(w, from)} writes to nobody. Nothing was delivered.`
  }
  return `On this floor ${nameOf(w, from)} does not write to ${nameOf(w, to)}. You write to: ${instead}. Send it there instead - it reaches the same person, through whoever is meant to see it first.`
}

/**
 * Fill a brief's placeholders.
 *
 * `{{self.id}}` / `{{self.name}}` - the agent being spawned.
 * `{{reportTo}}`                  - whoever the work comes back to.
 * `{{role.<name>.id}}` / `.name`  - a fixed role's agent, by role name.
 * `{{reuseBelowPct}}`, `{{hireAbovePct}}`
 *
 * An unknown placeholder is left standing rather than blanked: a brief that
 * reads `{{role.qa.id}}` in the agent's own terminal is a bug someone can see,
 * where an empty string is a brief that quietly tells it to mail nobody.
 */
export function renderBrief(
  w: Workflow,
  role: string,
  vars: { id: string; name?: string; reportTo?: string }
): string {
  const brief = w.roles[role]?.brief ?? ''
  return brief.replace(/\{\{([\w.]+)\}\}/g, (whole, key: string) => {
    if (key === 'self.id') return vars.id
    if (key === 'self.name') return vars.name ?? vars.id
    if (key === 'reportTo') return vars.reportTo ?? ''
    if (key === 'reuseBelowPct') return String(w.reuseBelowPct)
    if (key === 'hireAbovePct') return String(w.hireAbovePct)
    const m = /^role\.([\w-]+)\.(id|name|label)$/.exec(key)
    if (m) {
      const def = w.roles[m[1]]
      if (!def) return whole
      if (m[2] === 'label') return def.label
      if (!def.fixed) return whole
      return m[2] === 'id' ? def.fixed.id : def.fixed.name
    }
    return whole
  })
}

/**
 * What is wrong with this workflow, as lines a person can act on.
 *
 * Worth having because every one of these fails silently at runtime: a role
 * nobody can reach never gets work, a floor with no way to the human does its
 * job and tells nobody, and a brief naming an address the router refuses puts
 * the agent in a loop of being handed its own message back. None of that shows
 * up as an error - it shows up as a floor that looks busy and finishes nothing.
 */
export function lint(w: Workflow): string[] {
  const bad: string[] = []
  const names = Object.keys(w.roles)
  if (names.length === 0) return ['A workflow needs at least one role.']

  const known = new Set([...names, HUMAN_PARTY, HIRE_PARTY])
  for (const [from, tos] of Object.entries(w.talksTo)) {
    if (!w.roles[from]) bad.push(`talksTo names "${from}", which is not a role.`)
    for (const to of tos) {
      if (!known.has(to)) bad.push(`"${from}" is allowed to write to "${to}", which does not exist.`)
    }
  }
  for (const r of names) {
    if (!w.talksTo[r]) bad.push(`"${r}" has no talksTo entry, so it can write to nobody.`)
    if (!w.roles[r].brief.trim()) bad.push(`"${r}" has an empty brief - it will spawn knowing nothing.`)
  }

  if (!w.roles[w.dispatch]) bad.push(`dispatch is "${w.dispatch}", which is not a role.`)
  if (!w.roles[w.entry]) bad.push(`entry is "${w.entry}", which is not a role.`)
  if (w.dispatch && !w.roles[w.dispatch]?.fixed) {
    bad.push(`"${w.dispatch}" takes the work typed at the floor, so it needs a fixed agent - there is nobody to give it to at launch.`)
  }
  if (w.entry && !w.roles[w.entry]?.fixed) {
    bad.push(`"${w.entry}" takes inbound work, so it needs a fixed agent.`)
  }

  if (rolesWith(w, 'speaksToHuman').length === 0) {
    bad.push('Nobody can write to the human, so the floor can never report anything.')
  }
  if (rolesWith(w, 'builds').length === 0) {
    bad.push('Nobody builds, so no task can ever be worked on.')
  }
  if (rolesWith(w, 'assigns').length === 0 && rolesWith(w, 'builds').length > 0) {
    bad.push('Nobody assigns, so work reaches a builder only if the human hands it over directly.')
  }
  for (const r of rolesWith(w, 'speaksToHuman')) {
    if (!(w.talksTo[r] ?? []).includes(HUMAN_PARTY)) {
      bad.push(`"${r}" is meant to speak to the human but talksTo does not allow "${HUMAN_PARTY}".`)
    }
    // Being allowed to write to the human is not the same as being told to.
    // A floor whose voice is never instructed to report does all its work and
    // then says nothing - it looks busy and finishes in silence, which is the
    // failure the operator notices last.
    if (!new RegExp(`["']${HUMAN_PARTY}["']`).test(w.roles[r].brief)) {
      bad.push(
        `"${r}" is the floor's voice but its brief never tells it to write to "${HUMAN_PARTY}" - work would finish and the human would never hear.`
      )
    }
  }
  if (rolesWith(w, 'assigns').every((r) => !(w.talksTo[r] ?? []).includes(HIRE_PARTY))) {
    if (rolesWith(w, 'assigns').length > 0) {
      bad.push('No role that assigns may "hire", so an empty floor can never staff itself.')
    }
  }

  // Reachability from dispatch: a role nothing routes to sits idle forever.
  const seen = new Set<string>([w.dispatch])
  const queue = [w.dispatch]
  while (queue.length) {
    for (const to of w.talksTo[queue.shift() as string] ?? []) {
      if (w.roles[to] && !seen.has(to)) {
        seen.add(to)
        queue.push(to)
      }
    }
  }
  // Hiring reaches any hireable role, whoever does the hiring.
  const hires = rolesWith(w, 'assigns').some((r) => (w.talksTo[r] ?? []).includes(HIRE_PARTY))
  for (const r of names) {
    if (seen.has(r)) continue
    if (hires && w.roles[r].hireable) continue
    bad.push(`Nothing routes to "${r}" from "${w.dispatch}" - work can never reach it.`)
  }

  // A brief that names an address its own role may not use is a briefing the
  // router will spend the floor's time refusing.
  for (const r of names) {
    const allowed = new Set(w.talksTo[r] ?? [])
    for (const m of w.roles[r].brief.matchAll(/\{\{role\.([\w-]+)\.(?:id|name)\}\}/g)) {
      const target = m[1]
      if (w.roles[target] && !allowed.has(target) && target !== r) {
        bad.push(`"${r}" is briefed to write to "${target}", which talksTo refuses.`)
      }
    }
  }

  if (!(w.reuseBelowPct > 0 && w.reuseBelowPct <= w.hireAbovePct && w.hireAbovePct <= 100)) {
    bad.push('Context thresholds must satisfy 0 < reuseBelowPct <= hireAbovePct <= 100.')
  }

  // The starter is a form with the answers left out, and the blanks look like
  // ordinary prose once they are three screens up: `<what this one does>` would
  // be handed to a real agent as its standing instruction, and it would follow
  // it. Named here rather than left to be noticed.
  const blank = (text: string): string | null => BLANK.exec(text)?.[0] ?? null
  if (blank(w.name)) bad.push(`The workflow still has "${blank(w.name)}" for its name.`)
  if (blank(w.description)) {
    bad.push(`The description still has "${blank(w.description)}" in it.`)
  }
  for (const r of names) {
    const inBrief = blank(w.roles[r].brief)
    if (inBrief) bad.push(`"${r}" still has "${inBrief}" in its brief - that is what it is told.`)
    const inFixed = w.roles[r].fixed && blank(`${w.roles[r].fixed?.id} ${w.roles[r].fixed?.name}`)
    if (inFixed) bad.push(`"${r}" still has "${inFixed}" for its agent.`)
  }
  return [...new Set(bad)]
}

/**
 * Read an unknown blob as a workflow, or say why it is not one.
 *
 * Hand-edited JSON is the point of this file, so a bad shape has to come back
 * as a sentence rather than a crash on the first missing field.
 */
export function parseWorkflow(raw: unknown): { workflow: Workflow } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'A workflow must be a JSON object.' }
  const o = raw as Record<string, unknown>
  if (typeof o.name !== 'string' || !o.name.trim()) return { error: 'A workflow needs a name.' }
  if (!o.roles || typeof o.roles !== 'object') return { error: 'A workflow needs a "roles" object.' }

  const roles: Record<string, RoleDef> = {}
  for (const [key, v] of Object.entries(o.roles as Record<string, unknown>)) {
    if (!/^[\w-]+$/.test(key)) return { error: `Role name "${key}" must be letters, digits, - or _.` }
    if (!v || typeof v !== 'object') return { error: `Role "${key}" must be an object.` }
    const d = v as Record<string, unknown>
    const can = Array.isArray(d.can) ? d.can.filter((c): c is Capability => CAPABILITIES.includes(c as Capability)) : []
    if (Array.isArray(d.can) && can.length !== d.can.length) {
      return { error: `Role "${key}" has an unknown capability. Known: ${CAPABILITIES.join(', ')}.` }
    }
    if (typeof d.brief !== 'string') return { error: `Role "${key}" needs a "brief" string.` }
    let fixed: RoleDef['fixed']
    if (d.fixed !== undefined) {
      const f = d.fixed as Record<string, unknown>
      if (!f || typeof f !== 'object' || typeof f.id !== 'string' || !/^[\w-]+$/.test(f.id)) {
        return { error: `Role "${key}" has a "fixed" without a usable id.` }
      }
      fixed = { id: f.id, name: typeof f.name === 'string' && f.name.trim() ? f.name : f.id }
    }
    roles[key] = {
      can,
      label: typeof d.label === 'string' && d.label.trim() ? d.label : key,
      brief: d.brief,
      ...(fixed ? { fixed } : {}),
      ...(d.hireable === true ? { hireable: true } : {})
    }
  }

  const talksTo: Record<string, string[]> = {}
  for (const [from, v] of Object.entries((o.talksTo ?? {}) as Record<string, unknown>)) {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      return { error: `talksTo["${from}"] must be a list of names.` }
    }
    talksTo[from] = [...new Set(v as string[])]
  }

  const pct = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback

  const workflow: Workflow = {
    name: o.name.trim(),
    description: typeof o.description === 'string' ? o.description : '',
    roles,
    talksTo,
    dispatch: typeof o.dispatch === 'string' ? o.dispatch : Object.keys(roles)[0] ?? '',
    entry: typeof o.entry === 'string' ? o.entry : typeof o.dispatch === 'string' ? o.dispatch : '',
    reuseBelowPct: pct(o.reuseBelowPct, 50),
    hireAbovePct: pct(o.hireAbovePct, 70)
  }
  return { workflow }
}

/**
 * A workflow, written the way a person would write one.
 *
 * JSON was the wrong surface for this. Three of the fields are short - who
 * exists, who writes to whom - and the fourth is several paragraphs of prose
 * per role, which in JSON becomes one string with `\n\n` in it. That is the
 * part somebody customising a floor actually has to write, and it was the part
 * the format made hardest.
 *
 * The shape:
 *
 * ```markdown
 * # my-floor
 * One line about how work moves here.
 *
 * - reuse below: 50
 * - hire above: 70
 *
 * ## boss
 * - agent: michael · Michael
 * - can: speaksToHuman
 * - talks to: lead, you
 * - dispatch
 *
 * You are {{self.name}}, and you stand in for the person running this floor.
 * ...the rest of the brief, as many paragraphs as it needs...
 * ```
 *
 * Everything after the bullet list, up to the next `##`, is that role's brief.
 */
export function parseMarkdown(text: string): { workflow: Workflow } | { error: string } {
  // HTML comments come out first. The starter template teaches the format by
  // annotating itself, and without this every note in it would be swept into
  // the brief of whichever role it sat under - and handed to a real agent.
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')

  const title = lines.findIndex((l) => /^#\s+\S/.test(l))
  if (title === -1) return { error: 'Start with `# <workflow name>` on its own line.' }
  const name = lines[title].replace(/^#\s+/, '').trim()

  // Where each role starts. Everything before the first one is the header.
  const heads: number[] = []
  lines.forEach((l, i) => {
    if (/^##\s+\S/.test(l)) heads.push(i)
  })
  if (heads.length === 0) return { error: 'Add at least one role, as `## <role name>`.' }

  const header = lines.slice(title + 1, heads[0])
  const description = header.find((l) => l.trim() && !l.trim().startsWith('-'))?.trim() ?? ''

  /** `- key: value` out of a block of lines, case- and spacing-insensitive. */
  const field = (block: string[], key: string): string | null => {
    const re = new RegExp(`^\\s*[-*]\\s*${key}\\s*:\\s*(.+)$`, 'i')
    for (const l of block) {
      const m = re.exec(l)
      if (m) return m[1].trim()
    }
    return null
  }
  /** A bare `- flag` with no value. */
  const flag = (block: string[], word: string): boolean =>
    block.some((l) => new RegExp(`^\\s*[-*]\\s*${word}\\s*$`, 'i').test(l))

  // `Number('')` is 0, not NaN, so a missing field has to be caught before the
  // conversion - otherwise every unset threshold reads as zero and lints as
  // out of range.
  const num = (v: string | null, fallback: number): number => {
    if (v === null || !v.trim()) return fallback
    const n = Number(v.replace('%', '').trim())
    return Number.isFinite(n) ? Math.round(n) : fallback
  }

  const roles: Record<string, RoleDef> = {}
  const talksTo: Record<string, string[]> = {}
  let dispatch = ''
  let entry = ''

  for (let i = 0; i < heads.length; i++) {
    const from = heads[i]
    const to = heads[i + 1] ?? lines.length
    const head = lines[from].replace(/^##\s+/, '').trim()
    // `## boss · the boss` - the part after the separator is the label used in
    // refusals ("the boss does not write to a tester").
    const [rawRole, rawLabel] = head.split(/\s+[·|]\s+/)
    const role = rawRole.trim()
    if (!/^[\w-]+$/.test(role)) {
      return { error: `"${role}" is not a usable role name - letters, digits, - and _ only.` }
    }
    if (roles[role]) return { error: `"${role}" appears twice.` }

    // The bullet list is however many bullets follow the heading; the brief is
    // everything after them.
    //
    // The config block is the run of bullets directly under the heading, and it
    // ends at the first blank line after them. Ending it only at the first
    // non-bullet swallowed a brief that opened with a list - "- report when you
    // are done" read as a role field, vanished from the brief, and the agent was
    // never told. Nothing errored; the instruction was simply gone.
    const body = lines.slice(from + 1, to)
    let end = 0
    for (let j = 0; j < body.length; j++) {
      if (/^\s*[-*]\s+\S/.test(body[j])) {
        end = j + 1
        continue
      }
      // A blank line before the bullets start is just spacing under the heading.
      if (!body[j].trim()) {
        if (end > 0) break
        continue
      }
      break
    }
    const block = body.slice(0, end)
    const brief = body.slice(end).join('\n').trim()

    const list = (v: string | null): string[] =>
      (v ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)

    const caps = list(field(block, 'can'))
    const bad = caps.find((c) => !CAPABILITIES.includes(c as Capability))
    if (bad) {
      return { error: `"${role}" has an unknown capability "${bad}". Known: ${CAPABILITIES.join(', ')}.` }
    }

    let fixed: RoleDef['fixed']
    const agent = field(block, 'agent')
    if (agent) {
      const [id, display] = agent.split(/\s+[·|(]\s*/)
      const cleanId = id.trim()
      if (!/^[\w-]+$/.test(cleanId)) {
        return { error: `"${role}" has agent id "${cleanId}" - letters, digits, - and _ only.` }
      }
      fixed = { id: cleanId, name: (display ?? '').replace(/\)\s*$/, '').trim() || cleanId }
    }

    roles[role] = {
      can: caps as Capability[],
      label: (rawLabel ?? '').trim() || role,
      brief,
      ...(fixed ? { fixed } : {}),
      ...(flag(block, 'hireable') ? { hireable: true } : {})
    }
    talksTo[role] = list(field(block, 'talks to') ?? field(block, 'talksto'))
    if (flag(block, 'dispatch')) dispatch = role
    if (flag(block, 'entry')) entry = role
  }

  if (!dispatch) {
    return { error: 'No role is marked `- dispatch`. That is who a task typed at the floor goes to.' }
  }

  return {
    workflow: {
      name,
      description,
      roles,
      talksTo,
      dispatch,
      entry: entry || dispatch,
      reuseBelowPct: num(field(header, 'reuse below'), 50),
      hireAbovePct: num(field(header, 'hire above'), 70)
    }
  }
}

/** The same workflow, written back out. Round-trips through `parseMarkdown`. */
export function toMarkdown(w: Workflow): string {
  const out: string[] = [`# ${w.name}`]
  if (w.description) out.push('', w.description)
  out.push('', `- reuse below: ${w.reuseBelowPct}`, `- hire above: ${w.hireAbovePct}`)

  for (const [role, def] of Object.entries(w.roles)) {
    out.push('', `## ${role}${def.label && def.label !== role ? ` · ${def.label}` : ''}`)
    if (def.fixed) out.push(`- agent: ${def.fixed.id} · ${def.fixed.name}`)
    out.push(`- can: ${def.can.join(', ')}`)
    out.push(`- talks to: ${(w.talksTo[role] ?? []).join(', ')}`)
    if (def.hireable) out.push('- hireable')
    if (role === w.dispatch) out.push('- dispatch')
    if (role === w.entry) out.push('- entry')
    out.push('', def.brief)
  }
  return out.join('\n') + '\n'
}

/**
 * The workflows on disk.
 *
 * One markdown file per workflow, under `~/.bullpen/workflows`, named for its
 * own `# heading`. Files rather than a blob inside config.json because these
 * are documents: an operator with an opinion about how their floor runs will
 * want to keep several, diff them, and edit one in their own editor without
 * going through this dialog at all.
 *
 * The presets are not stored here. They ship with Bullpen and are offered as
 * starting points; saving one under its own name is what makes it yours.
 */
export const workflowDir = (home: string): string => join(home, 'workflows')

/** A filename that cannot escape the directory it is meant to be in. */
export const workflowFile = (home: string, name: string): string => {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  if (!slug) throw new Error('A workflow needs a name.')
  return join(workflowDir(home), `${slug}.md`)
}

export type SavedWorkflow = { name: string; description: string; markdown: string }

/**
 * Every saved workflow, newest name first.
 *
 * A file that no longer parses is skipped rather than thrown: one bad file in
 * the directory - hand-edited, half-saved - must not take the whole list with
 * it and leave the dialog empty.
 */
export function listWorkflows(home: string): SavedWorkflow[] {
  const dir = workflowDir(home)
  if (!existsSync(dir)) return []
  const out: SavedWorkflow[] = []
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.md')) continue
    try {
      const markdown = readFileSync(join(dir, file), 'utf8')
      const parsed = parseMarkdown(markdown)
      if ('error' in parsed) continue
      out.push({
        name: parsed.workflow.name,
        description: parsed.workflow.description,
        markdown
      })
    } catch {
      // Unreadable is the same as absent as far as the list is concerned.
    }
  }
  return out
}

/** Write one, atomically. Returns what was parsed out of it. */
export function saveWorkflow(home: string, markdown: string): Workflow {
  const parsed = parseMarkdown(markdown)
  if ('error' in parsed) throw new Error(parsed.error)
  const problems = lint(parsed.workflow)
  if (problems.length) throw new Error(problems.join('\n'))
  const dir = workflowDir(home)
  mkdirSync(dir, { recursive: true })
  const path = workflowFile(home, parsed.workflow.name)
  // Write-then-rename: a reader that catches a half-written file gets truncated
  // markdown and no error, which lists as "not a workflow" and looks like loss.
  const tmp = `${path}.tmp`
  writeFileSync(tmp, markdown, 'utf8')
  renameSync(tmp, path)
  return parsed.workflow
}

/** Remove one. Silent when it was not there - the end state is what was asked. */
export function deleteWorkflow(home: string, name: string): void {
  const path = workflowFile(home, name)
  if (existsSync(path)) rmSync(path)
}

/** Built from the shared spec, so the dialog and the writer never disagree. */
export const GENERATOR_BRIEF = generatorBrief()
