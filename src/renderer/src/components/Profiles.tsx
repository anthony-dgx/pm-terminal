import { useCallback, useEffect, useState } from 'react'
import type { AgentProfile } from '../../../shared/types.js'
import { desk } from '../lib/api.js'
import { CopyButton } from './Copy.js'

function blank(): AgentProfile {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    name: 'New profile',
    description: '',
    prompt: '',
    createdAt: now,
    updatedAt: now,
  }
}

interface Props {
  /** Bumped by the host when profiles change elsewhere. */
  refreshKey: number
  onChanged: () => void
}

export function ProfilesPanel({ refreshKey, onChanged }: Props): React.ReactElement {
  const [profiles, setProfiles] = useState<AgentProfile[]>([])
  const [editing, setEditing] = useState<AgentProfile | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = useCallback(async () => {
    setProfiles(await desk.profilesRead())
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const persist = useCallback(
    async (next: AgentProfile[]) => {
      setProfiles(next)
      await desk.profilesWrite(next)
      onChanged()
    },
    [onChanged],
  )

  const save = useCallback(
    async (p: AgentProfile) => {
      const stamped = { ...p, updatedAt: new Date().toISOString() }
      const exists = profiles.some((x) => x.id === p.id)
      await persist(exists ? profiles.map((x) => (x.id === p.id ? stamped : x)) : [...profiles, stamped])
      setEditing(null)
    },
    [profiles, persist],
  )

  if (editing) {
    const p = editing
    return (
      <div className="panel">
        <div className="panel-head">
          <span>{profiles.some((x) => x.id === p.id) ? 'Edit profile' : 'New profile'}</span>
          <CopyButton text={() => p.prompt} label="Copy prompt" />
        </div>

        <label className="field">
          <span>Name</span>
          <input
            className="filter"
            value={p.name}
            onChange={(e) => setEditing({ ...p, name: e.target.value })}
            placeholder="Staff AAA PM"
          />
        </label>

        <label className="field">
          <span>Description</span>
          <input
            className="filter"
            value={p.description}
            onChange={(e) => setEditing({ ...p, description: e.target.value })}
            placeholder="What this profile is for"
          />
        </label>

        <label className="field">
          <span>Prompt</span>
          <textarea
            className="profile-prompt"
            value={p.prompt}
            onChange={(e) => setEditing({ ...p, prompt: e.target.value })}
            placeholder="You are acting as..."
            rows={14}
          />
        </label>
        <p className="panel-hint">
          Appended to Claude Code&apos;s own system prompt, so tools, skills, and your CLAUDE.md still apply.
        </p>

        <div className="row-actions">
          <button className="btn btn-primary btn-sm" disabled={!p.name.trim()} onClick={() => void save(p)}>
            Save
          </button>
          <button className="btn btn-sm" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span>
          {profiles.length} profile{profiles.length === 1 ? '' : 's'}
        </span>
        <button className="btn btn-sm" onClick={() => setEditing(blank())}>
          + New
        </button>
      </div>

      <ul className="list">
        {profiles.map((p) => (
          <li key={p.id} className="list-item skill-item">
            <div className="row">
              <span className="row-name">{p.name}</span>
              {p.builtIn && <span className="badge">built-in</span>}
            </div>
            {p.description && <p className="skill-desc">{p.description}</p>}
            <div className="row-actions">
              <button className="btn btn-sm" onClick={() => setEditing(p)}>
                Edit
              </button>
              <button
                className="btn btn-sm"
                onClick={() =>
                  void save({
                    ...p,
                    id: crypto.randomUUID(),
                    name: `${p.name} copy`,
                    builtIn: false,
                    createdAt: new Date().toISOString(),
                  })
                }
              >
                Duplicate
              </button>
              <CopyButton text={() => p.prompt} label="Copy prompt" />
              {confirmDelete === p.id ? (
                <>
                  <button
                    className="btn btn-sm btn-deny"
                    onClick={() => {
                      void persist(profiles.filter((x) => x.id !== p.id))
                      setConfirmDelete(null)
                    }}
                  >
                    Really delete
                  </button>
                  <button className="btn btn-sm" onClick={() => setConfirmDelete(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <button className="btn btn-sm btn-deny" onClick={() => setConfirmDelete(p.id)}>
                  Delete
                </button>
              )}
            </div>
            <details className="profile-peek">
              <summary>{p.prompt.split('\n').length} lines</summary>
              <pre className="tool-pre">{p.prompt}</pre>
            </details>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Titlebar dropdown choosing the profile for the next session. */
export function ProfilePicker({
  current,
  refreshKey,
  onChange,
}: {
  current: string | null
  refreshKey: number
  onChange: (id: string | null) => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [profiles, setProfiles] = useState<AgentProfile[]>([])

  useEffect(() => {
    void desk.profilesRead().then(setProfiles)
  }, [refreshKey, open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const active = profiles.find((p) => p.id === current)

  return (
    <div className="model-picker">
      <button className="model-btn" onClick={() => setOpen((o) => !o)} title="Agent profile for new sessions">
        {active ? active.name : 'no profile'}
        <span className="model-caret">▾</span>
      </button>
      {open && (
        <div className="model-menu" onMouseLeave={() => setOpen(false)}>
          <button
            className={`model-item ${!current ? 'is-on' : ''}`}
            onClick={() => {
              onChange(null)
              setOpen(false)
            }}
          >
            <span className="model-item-name">
              No profile
              {!current && <span className="model-check">✓</span>}
            </span>
            <span className="model-item-desc">Plain Claude Code, nothing appended</span>
          </button>
          {profiles.map((p) => (
            <button
              key={p.id}
              className={`model-item ${current === p.id ? 'is-on' : ''}`}
              onClick={() => {
                onChange(p.id)
                setOpen(false)
              }}
            >
              <span className="model-item-name">
                {p.name}
                {current === p.id && <span className="model-check">✓</span>}
              </span>
              <span className="model-item-desc">{p.description || `${p.prompt.split('\n').length} lines`}</span>
            </button>
          ))}
          <p className="panel-hint model-foot">Applies to the next session you start.</p>
        </div>
      )}
    </div>
  )
}
