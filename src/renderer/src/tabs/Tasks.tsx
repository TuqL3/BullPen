import { useEffect, useState } from 'react'
import { LABEL, MONO } from '../theme'
import type { Agent } from '../store'

type Task = { id: string; agentId: string; text: string; done: boolean; createdAt: number }

/** A scratch list per agent, kept in ~/.bullpen/board.json so `cat` still works. */
export function Tasks({ agent }: { agent: Agent | null }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [text, setText] = useState('')

  const refresh = (): void => {
    if (!agent) return setTasks([])
    window.bullpen.tasks(agent.id).then(setTasks)
  }
  useEffect(refresh, [agent?.id])

  if (!agent) return <div style={S.empty}>Pick an agent to see its list.</div>

  const add = async (): Promise<void> => {
    if (!text.trim()) return
    await window.bullpen.addTask(agent.id, text.trim())
    setText('')
    refresh()
  }

  const open = tasks.filter((t) => !t.done)
  const done = tasks.filter((t) => t.done)

  return (
    <div style={S.wrap}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input
          style={S.input}
          value={text}
          placeholder={`what should ${agent.name} get to?`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button style={S.btn} onClick={add}>
          add
        </button>
      </div>

      {tasks.length === 0 && <div style={S.empty}>Nothing on the list.</div>}

      {open.map((t) => (
        <Row key={t.id} task={t} onChange={refresh} />
      ))}
      {done.length > 0 && <div style={{ ...LABEL, color: 'var(--faint)', margin: '14px 0 4px' }}>done</div>}
      {done.map((t) => (
        <Row key={t.id} task={t} onChange={refresh} />
      ))}

      <p style={S.note}>
        This list is yours, not the agent&apos;s: nothing here is sent anywhere. To make an agent act
        on something, message it, or set a trigger.
      </p>
    </div>
  )
}

function Row({ task, onChange }: { task: Task; onChange: () => void }) {
  return (
    <div style={S.row}>
      <input
        type="checkbox"
        checked={task.done}
        onChange={async () => {
          await window.bullpen.toggleTask(task.id)
          onChange()
        }}
      />
      <span
        style={{
          flex: 1,
          color: task.done ? 'var(--faint)' : 'var(--ink)',
          textDecoration: task.done ? 'line-through' : 'none'
        }}
      >
        {task.text}
      </span>
      <button
        style={S.linkBtn}
        onClick={async () => {
          await window.bullpen.removeTask(task.id)
          onChange()
        }}
      >
        ×
      </button>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: { padding: 14, overflowY: 'auto', height: '100%', font: `12px ${MONO}` },
  input: {
    flex: 1,
    padding: '6px 9px',
    background: 'var(--sunk)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    font: `12px ${MONO}`
  },
  btn: {
    padding: '6px 12px',
    background: 'var(--accent)',
    color: '#241f1a',
    border: '1px solid var(--accent)',
    cursor: 'pointer',
    font: `11px ${MONO}`
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 2px',
    borderTop: '1px solid var(--line)'
  },
  linkBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--faint)',
    cursor: 'pointer',
    font: `12px ${MONO}`
  },
  note: { fontSize: 11, color: 'var(--faint)', marginTop: 18, lineHeight: 1.6 },
  empty: { color: 'var(--faint)', padding: 18, fontSize: 11 }
}
