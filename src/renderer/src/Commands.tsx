import { useState } from 'react'
import { LABEL, MONO } from './theme'

type Entry = { kind: 'slash' | 'cli' | 'bullpen'; cmd: string; desc: string; eg?: string }
type Group = { title: string; entries: Entry[] }

const GROUPS: Group[] = [
  {
    title: 'Session',
    entries: [
      { kind: 'slash', cmd: '/clear', desc: 'Start a fresh conversation and reclaim the context window.' },
      { kind: 'slash', cmd: '/resume', desc: 'Pick or search a past session to continue.', eg: '/resume auth refactor' },
      { kind: 'slash', cmd: '/rewind', desc: 'Roll code AND conversation back to an earlier checkpoint.' },
      {
        kind: 'slash',
        cmd: '/compact',
        desc: 'Summarise the conversation so far to free context without losing the thread.',
        eg: '/compact keep the auth decisions'
      },
      { kind: 'cli', cmd: 'claude -c', desc: 'Continue the most recent session in this directory.' },
      { kind: 'cli', cmd: 'claude -r', desc: 'Resume — pick or search a past session.', eg: 'claude -r auth' },
      {
        kind: 'cli',
        cmd: 'claude --fork-session',
        desc: 'When resuming, branch into a new session id instead of reusing the original.'
      }
    ]
  },
  {
    title: 'Context & memory',
    entries: [
      { kind: 'slash', cmd: '/context', desc: 'Visualise what is filling the context window.' },
      { kind: 'slash', cmd: '/memory', desc: 'Open the project and user CLAUDE.md files for editing.' },
      { kind: 'slash', cmd: '/init', desc: 'Scan the repo and generate a CLAUDE.md capturing its conventions.' },
      { kind: 'slash', cmd: '/effort', desc: 'Set how hard the model works on each turn.', eg: '/effort high' }
    ]
  },
  {
    title: 'Bullpen',
    entries: [
      {
        kind: 'bullpen',
        cmd: 'Write $BULLPEN_MAILBOX/outbox/msg.json',
        desc: 'How an agent sends mail: write JSON with from, to, subject, body. "to": "*" broadcasts.'
      },
      {
        kind: 'bullpen',
        cmd: 'ls $BULLPEN_MAILBOX/inbox',
        desc: 'Mail waiting for this agent. The router delivers here every 500ms.'
      },
      {
        kind: 'bullpen',
        cmd: 'Write $BULLPEN_MAILBOX/outbox/ask.json',
        desc: 'Ask the human something: address it to "you" and it lands in the ask-me queue; your answer arrives in your inbox.',
        eg: '{"from":"<you>","to":"you","subject":"which variant?","body":"a, b or c"}'
      },
      {
        kind: 'bullpen',
        cmd: 'npm run verify:hook',
        desc: 'Re-check the approvals layer against the real CLI. Run after every Claude Code update.'
      }
    ]
  }
]

const KIND_COLOR: Record<Entry['kind'], string> = {
  slash: 'var(--accent-ink)',
  cli: 'var(--muted)',
  bullpen: 'var(--ok)'
}

export function Commands() {
  const [copied, setCopied] = useState('')

  const copy = async (cmd: string): Promise<void> => {
    await navigator.clipboard.writeText(cmd)
    setCopied(cmd)
    setTimeout(() => setCopied(''), 1200)
  }

  return (
    <div style={{ padding: '14px 18px', overflowY: 'auto', height: '100%' }}>
      <div style={{ ...LABEL, marginBottom: 14 }}>
        Click any command to copy. Slash commands run inside Claude Code; CLI commands run in a shell.
      </div>

      {GROUPS.map((g) => (
        <div key={g.title} style={{ marginBottom: 22 }}>
          <div style={{ ...LABEL, color: 'var(--faint)', marginBottom: 8 }}>{g.title}</div>
          {g.entries.map((e) => (
            <div
              key={e.cmd}
              onClick={() => copy(e.cmd)}
              style={{
                display: 'grid',
                gridTemplateColumns: '58px 1fr auto',
                gap: 12,
                alignItems: 'baseline',
                padding: '8px 0',
                borderTop: '1px solid var(--line)',
                cursor: 'pointer'
              }}
            >
              <span style={{ ...LABEL, color: KIND_COLOR[e.kind], fontWeight: 700 }}>{e.kind}</span>
              <span>
                <div style={{ font: `13px ${MONO}`, color: 'var(--ink)', wordBreak: 'break-all' }}>{e.cmd}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>{e.desc}</div>
                {e.eg && (
                  <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 3, fontStyle: 'italic' }}>
                    e.g. {e.eg}
                  </div>
                )}
              </span>
              <span style={{ ...LABEL, color: copied === e.cmd ? 'var(--ok)' : 'var(--faint)' }}>
                {copied === e.cmd ? 'copied' : 'copy'}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
