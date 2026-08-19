/**
 * What you can type at an agent, per CLI.
 *
 * The command set belongs to the program the agent is running, not to Bullpen:
 * a Claude Code agent has `/compact`, a Codex or Gemini agent will not, and a
 * page that lists Claude's commands for all of them is a page that lies about
 * three quarters of the floor. Catalogues are keyed by the command an agent was
 * spawned with, and an unknown one gets the mailbox protocol and nothing else.
 */
export type Entry = { cmd: string; desc: string; eg?: string }
export type Group = { title: string; entries: Entry[] }
export type Catalog = {
  /** The executable, as the agent was spawned with it. */
  cli: string
  label: string
  /** Where the list came from, so a stale one can be recognised as stale. */
  source: string
  groups: Group[]
}

/**
 * Claude Code, read out of the installed binary rather than from memory.
 *
 * Every entry below is a command the CLI declares in its own bundle, with the
 * description it declares. Internal ones nobody types (heap dumps, trial-expiry
 * screens, workflow handoffs) are left out.
 */
const CLAUDE: Catalog = {
  cli: 'claude',
  label: 'Claude Code',
  source: 'read from the installed CLI, v2.1.234',
  groups: [
    {
      title: 'Session',
      entries: [
        {
          cmd: '/clear',
          desc: 'Start a new session with empty context; the previous one stays on disk.'
        },
        { cmd: '/resume', desc: 'Resume a previous conversation.', eg: '/resume auth refactor' },
        { cmd: '/rewind', desc: 'Roll code and conversation back to an earlier checkpoint.' },
        { cmd: '/compact', desc: 'Free up context by summarising the conversation so far.' },
        { cmd: '/autocompact', desc: 'Set how full the context gets before auto-summarising.' },
        { cmd: '/branch', desc: 'Create a branch of the current conversation at this point.' },
        { cmd: '/rename', desc: 'Rename the current conversation.' },
        { cmd: '/recap', desc: 'Generate a one-line session recap now.' },
        { cmd: '/export', desc: 'Export the current conversation to a file or clipboard.' },
        { cmd: '/copy', desc: "Copy Claude's last response to the clipboard.", eg: '/copy 2' },
        { cmd: '/cd', desc: 'Move this session to a new working directory.' },
        { cmd: '/add-dir', desc: 'Add a new working directory.' }
      ]
    },
    {
      title: 'Context & memory',
      entries: [
        { cmd: '/context', desc: 'Visualise current context usage as a coloured grid.' },
        { cmd: '/memory', desc: 'Edit CLAUDE.md files and memory settings.' },
        { cmd: '/pause-memory', desc: 'Pause automemory for this session.' },
        { cmd: '/init', desc: 'Scan the repo and write a CLAUDE.md for it.' },
        { cmd: '/explain-usage', desc: "See where this session's tokens went, in plain words." },
        { cmd: '/usage', desc: 'Show session cost, plan usage and activity stats.' }
      ]
    },
    {
      title: 'How it works',
      entries: [
        { cmd: '/model', desc: 'Set the AI model for Claude Code.', eg: '/model opus' },
        { cmd: '/effort', desc: 'Set effort level for model usage.', eg: '/effort high' },
        { cmd: '/plan', desc: 'Enable plan mode or view the current session plan.' },
        { cmd: '/goal', desc: 'Set a goal Claude checks before stopping.' },
        { cmd: '/advisor', desc: 'Let Claude consult a stronger model at key moments.' },
        { cmd: '/permissions', desc: 'Manage allow and deny tool permission rules.' },
        { cmd: '/hooks', desc: 'View hook configurations for tool events.' },
        { cmd: '/mcp', desc: 'Manage MCP servers.' },
        { cmd: '/plugin', desc: 'Manage Claude Code plugins.' },
        { cmd: '/skills', desc: 'List available skills.' },
        { cmd: '/skill-doctor', desc: 'Show which loaded skills are unused and costing context.' },
        { cmd: '/reload-skills', desc: 'Pick up skills added or changed on disk this session.' },
        { cmd: '/reload-plugins', desc: 'Activate pending plugin changes in this session.' }
      ]
    },
    {
      title: 'Work',
      entries: [
        { cmd: '/diff', desc: 'Toggle the diff panel showing uncommitted changes.' },
        {
          cmd: '/security-review',
          desc: 'Complete a security review of the pending changes on this branch.'
        },
        { cmd: '/autofix-pr', desc: 'Monitor and autofix any issues with the current PR.' },
        { cmd: '/subtask', desc: 'Send a subagent off with your full context; its result comes back here.' },
        { cmd: '/fork', desc: 'Spawn a background agent that inherits the full conversation.' },
        { cmd: '/background', desc: 'Send this session to the background and free the terminal.' },
        { cmd: '/tasks', desc: 'View and manage everything running in the background.' },
        { cmd: '/workflows', desc: 'Browse running and completed workflows.' },
        { cmd: '/loops', desc: 'List, create and delete loops.' },
        { cmd: '/btw', desc: 'Ask a quick side question without interrupting the main conversation.' }
      ]
    },
    {
      title: 'Account & setup',
      entries: [
        { cmd: '/status', desc: 'Version, model, account, API connectivity and tool status.' },
        { cmd: '/config', desc: 'Open settings.' },
        { cmd: '/theme', desc: 'Change the theme.' },
        { cmd: '/keybindings', desc: 'Open your keyboard shortcuts file.' },
        { cmd: '/statusline', desc: 'Set up the status line.' },
        { cmd: '/ide', desc: 'Manage IDE integrations and show status.' },
        { cmd: '/login', desc: 'Sign in, or switch Anthropic accounts.' },
        { cmd: '/logout', desc: 'Sign out from your Anthropic account.' },
        { cmd: '/doctor', desc: 'Check the installation for problems.' },
        { cmd: '/debug', desc: 'Enable debug logging for this session.' },
        { cmd: '/update', desc: 'Switch to the latest version; the conversation continues.' },
        { cmd: '/bug', desc: 'Report a bug or share your conversation.' },
        { cmd: '/privacy-settings', desc: 'View and update your privacy settings.' },
        { cmd: '/help', desc: 'Show help and available commands.' }
      ]
    },
    {
      title: 'Shell',
      entries: [
        { cmd: 'claude -c', desc: 'Continue the most recent session in this directory.' },
        { cmd: 'claude -r', desc: 'Resume - pick or search a past session.', eg: 'claude -r auth' },
        {
          cmd: 'claude --fork-session',
          desc: 'When resuming, branch into a new session id instead of reusing the original.'
        },
        { cmd: 'claude --settings <file>', desc: 'Run with a settings file - how Bullpen installs its hooks.' }
      ]
    }
  ]
}

export const CATALOGS: Catalog[] = [CLAUDE]

/**
 * Bullpen's own protocol, which is files and therefore CLI-agnostic.
 *
 * Anything that can write a file can send mail, which is the whole reason the
 * bus is a directory: a Codex or Gemini agent joins the floor without needing
 * anything ported to it.
 */
export const SHARED: Group = {
  title: 'Bullpen · any CLI',
  entries: [
    {
      cmd: 'Write $BULLPEN_MAILBOX/outbox/msg.json',
      desc: 'Send mail: JSON with from, to, subject, body. "to": "*" broadcasts.'
    },
    {
      cmd: 'ls $BULLPEN_MAILBOX/inbox',
      desc: 'Mail waiting for this agent. The router delivers here every 500ms.'
    },
    {
      cmd: 'Write $BULLPEN_MAILBOX/outbox/ask.json',
      desc: 'Ask the human: address it to "you" and it lands in the ask-me queue; the answer arrives in your inbox.',
      eg: '{"from":"<you>","to":"you","subject":"which variant?","body":"a, b or c"}'
    },
    {
      cmd: 'Write $BULLPEN_MAILBOX/outbox/hire.json',
      desc: 'Ask for another pair of hands: "to": "hire", subject is the project, body is the briefing.',
      eg: '{"from":"<you>","to":"hire","subject":"seo","body":"add the sitemap route"}'
    },
    { cmd: 'cat $BULLPEN_FLOOR', desc: 'Who is on the floor: id, project, idle or working, context used.' },
    {
      cmd: 'npm run verify:hook',
      desc: 'Re-check the approvals layer against the real CLI. Run after every Claude Code update.'
    }
  ]
}

/** The catalogue for an agent's CLI, if there is one for it yet. */
export function catalogFor(cli: string | undefined): Catalog | undefined {
  if (!cli) return undefined
  // `cmd` is whatever the agent was spawned with - a bare name, or a path to it.
  const name = cli.split('/').pop()?.trim().toLowerCase() ?? ''
  return CATALOGS.find((c) => c.cli === name)
}
