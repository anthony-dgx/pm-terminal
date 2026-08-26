import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  GROUP_COLORS,
  type AgentProfile,
  type GroupColor,
  type HistoryEntry,
  type SessionGroup,
} from '../../../shared/types.js'
import { desk } from '../lib/api.js'


function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function shortCwd(cwd: string, home: string): string {
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
}

const DRAG_TYPE = 'application/x-claude-session'
const GROUP_DRAG_TYPE = 'application/x-claude-group'

type Bucket = 'today' | 'week' | 'before'

/**
 * Which time bucket a session falls into. "This week" is a rolling seven days
 * rather than a calendar week, so a Monday morning does not sweep everything
 * from the past few days straight into "Before".
 */
function bucketOf(modifiedMs: number, now: number): Bucket {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  if (modifiedMs >= startOfToday.getTime()) return 'today'
  if (modifiedMs >= startOfToday.getTime() - 6 * 86_400_000) return 'week'
  return 'before'
}

const BUCKET_LABELS: { key: Bucket; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'before', label: 'Before' },
]

interface SessionRowProps {
  entry: HistoryEntry
  home: string
  active: boolean
  busy: boolean
  /** An answer arrived here while you were looking somewhere else. */
  unread: boolean
  groups: SessionGroup[]
  /** Group this session currently sits in, if any. */
  groupId: string | null
  onAssign: (sessionId: string, groupId: string | null) => void
  onOpen: (e: HistoryEntry) => void
  onResume: (e: HistoryEntry) => void
  onRename: (e: HistoryEntry, title: string) => void
  onDragStart: (sessionId: string) => void
  onDragEnd: () => void
}

function SessionRow({
  entry,
  home,
  active,
  busy,
  unread,
  groups,
  groupId,
  onAssign,
  onOpen,
  onResume,
  onRename,
  onDragStart,
  onDragEnd,
}: SessionRowProps): React.ReactElement {
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState(false)
  const [draft, setDraft] = useState(entry.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDraft(entry.title)
  }, [entry.title])

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commit = (): void => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== entry.title) onRename(entry, next)
    else setDraft(entry.title)
  }

  return (
    <div
      className={`hist ${active ? 'is-active' : ''} ${unread ? 'is-unread' : ''}`}
      // Dragging must be off while renaming or the input cannot be selected.
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, entry.sessionId)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart(entry.sessionId)
      }}
      onDragEnd={onDragEnd}
      onClick={() => {
        if (!editing) onOpen(entry)
      }}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="hist-title-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft(entry.title)
              setEditing(false)
            }
          }}
        />
      ) : (
        <div
          className="hist-title"
          onDoubleClick={(e) => {
            e.stopPropagation()
            setEditing(true)
          }}
          title={`${entry.title}\n\nDouble-click to rename`}
        >
          {entry.title}
        </div>
      )}
      <div className="hist-meta">
        <span className="hist-cwd">{shortCwd(entry.cwd, home)}</span>
        {busy ? <span className="hist-busy" title="Working in this session">working</span> : null}
        {/* Only when idle: while it is still working, "working" is the truer
            label and two badges on one row is noise. */}
        {unread && !busy ? (
          <span className="hist-new" title="Answered while you were elsewhere">
            <span className="pip" />
            new
          </span>
        ) : null}
        <span>{relativeTime(entry.modifiedMs)}</span>
      </div>
      {!editing && (
        <div className="hist-actions">
          <button
            className="hist-btn"
            onClick={(ev) => {
              ev.stopPropagation()
              setEditing(true)
            }}
            title="Rename this session"
          >
            Rename
          </button>
          <button
            className="hist-btn"
            onClick={(ev) => {
              ev.stopPropagation()
              onResume(entry)
            }}
            title="Resume this session in a live agent"
          >
            Resume
          </button>
          <button
            className="hist-btn"
            onClick={(ev) => {
              ev.stopPropagation()
              setMenu((m) => !m)
            }}
            title="Move to a group"
          >
            ···
          </button>
        </div>
      )}

      {menu && (
        <div className="hist-menu" onClick={(e) => e.stopPropagation()} onMouseLeave={() => setMenu(false)}>
          <div className="grp-menu-label">Move to group</div>
          {groups.length === 0 && <p className="grp-empty">No groups yet</p>}
          {groups.map((g) => (
            <button
              key={g.id}
              className={`grp-menu-item grp-${g.color} ${groupId === g.id ? 'is-on' : ''}`}
              onClick={() => {
                onAssign(entry.sessionId, g.id)
                setMenu(false)
              }}
            >
              <span className="grp-dot" />
              {g.name}
              {groupId === g.id && <span className="model-check">✓</span>}
            </button>
          ))}
          {groupId && (
            <button
              className="grp-menu-item"
              onClick={() => {
                onAssign(entry.sessionId, null)
                setMenu(false)
              }}
            >
              Remove from group
            </button>
          )}
        </div>
      )}
    </div>
  )
}

interface GroupHeaderProps {
  group: SessionGroup
  count: number
  dropActive: boolean
  profiles: AgentProfile[]
  onToggle: () => void
  onRename: (name: string) => void
  onColor: (c: GroupColor) => void
  onProfile: (id: string | null) => void
  onNewChat: () => void
  onUngroupAll: () => void
  onDelete: () => void
  onDragStart: () => void
  onDragEnd: () => void
  onMove: (delta: -1 | 1) => void
  canMoveUp: boolean
  canMoveDown: boolean
}

function GroupHeader({
  group,
  count,
  dropActive,
  profiles,
  onToggle,
  onRename,
  onColor,
  onProfile,
  onNewChat,
  onUngroupAll,
  onDelete,
  onDragStart,
  onDragEnd,
  onMove,
  canMoveUp,
  canMoveDown,
}: GroupHeaderProps): React.ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(group.name)
  const [menu, setMenu] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commit = (): void => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== group.name) onRename(next)
    else setDraft(group.name)
  }

  return (
    <div
      className={`grp-head grp-${group.color} ${dropActive ? 'is-drop' : ''}`}
      // The header is the drag handle. The body stays undraggable so session
      // rows keep their own drag behaviour.
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.setData(GROUP_DRAG_TYPE, group.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      title="Drag to reorder"
    >
      <button className="grp-caret" onClick={onToggle} title={group.collapsed ? 'Expand' : 'Collapse'}>
        {group.collapsed ? '▸' : '▾'}
      </button>
      <span className="grp-dot" />
      {editing ? (
        <input
          ref={inputRef}
          className="grp-name-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft(group.name)
              setEditing(false)
            }
          }}
        />
      ) : (
        <span className="grp-name" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
          {group.name}
        </span>
      )}
      <span className="grp-count">{count}</span>
      <button
        className="grp-new"
        onClick={onNewChat}
        title={
          group.profileId
            ? `New chat with the ${profiles.find((p) => p.id === group.profileId)?.name ?? 'group'} profile`
            : 'New chat in this group'
        }
      >
        +
      </button>
      <button className="grp-menu-btn" onClick={() => setMenu((m) => !m)} title="Group options">
        ···
      </button>

      {menu && (
        <div className="grp-menu" onMouseLeave={() => setMenu(false)}>
          <div className="grp-swatches">
            {GROUP_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch grp-${c} ${group.color === c ? 'is-on' : ''}`}
                onClick={() => {
                  onColor(c)
                  setMenu(false)
                }}
                title={c}
              />
            ))}
          </div>
          <button
            className="grp-menu-item"
            onClick={() => {
              setEditing(true)
              setMenu(false)
            }}
          >
            Rename
          </button>
          <div className="grp-menu-label">Default profile</div>
          <select
            className="grp-profile-select"
            value={group.profileId ?? ''}
            onChange={(e) => onProfile(e.target.value || null)}
          >
            <option value="">None</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <button className="grp-menu-item" disabled={!canMoveUp} onClick={() => onMove(-1)}>
            Move up
          </button>
          <button className="grp-menu-item" disabled={!canMoveDown} onClick={() => onMove(1)}>
            Move down
          </button>

          <button
            className="grp-menu-item"
            onClick={() => {
              onUngroupAll()
              setMenu(false)
            }}
          >
            Ungroup all
          </button>
          <button
            className="grp-menu-item is-danger"
            onClick={() => {
              onDelete()
              setMenu(false)
            }}
          >
            Delete group
          </button>
        </div>
      )}
    </div>
  )
}

interface Props {
  home: string
  activeSessionId: string | null
  onOpen: (entry: HistoryEntry) => void
  onResume: (entry: HistoryEntry) => void
  onNew: () => void
  onNewInGroup: (profileId: string | null | undefined) => void
  /** Bumped when a session starts or finishes a turn, to refresh the list. */
  activityKey: number
  onClose: () => void
  /** Sessions with work in flight, marked so they are visible while hidden. */
  busySessionIds: string[]
  /** Sessions holding an answer that has not been read yet. */
  unreadSessionIds: string[]
  /** Incremented by the host (Cmd+G) to create a group. */
  newGroupSignal: number
}

export function Sidebar({
  home,
  activeSessionId,
  onOpen,
  onResume,
  onNew,
  onNewInGroup,
  activityKey,
  onClose,
  busySessionIds,
  unreadSessionIds,
  newGroupSignal,
}: Props): React.ReactElement {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [groups, setGroups] = useState<SessionGroup[]>([])
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [dragging, setDragging] = useState<string | null>(null)
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<AgentProfile[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [openBuckets, setOpenBuckets] = useState<Record<Bucket, boolean>>({
    today: true,
    week: false,
    before: false,
  })

  useEffect(() => {
    void Promise.all([desk.historyList({ limit: 120 }), desk.groupsRead(), desk.profilesRead()]).then(
      ([e, g, pr]) => {
        setEntries(e)
        setGroups(g)
        setProfiles(pr)
        setLoading(false)
      },
    )
  }, [])

  const reload = useCallback(async () => {
    setRefreshing(true)
    try {
      setEntries(await desk.historyList({ limit: 120 }))
    } finally {
      setRefreshing(false)
    }
  }, [])

  // A session that just started is not in the list yet, and a finished turn
  // changes its timestamp and order. Debounced because a busy turn can bump
  // activityKey several times, and a full re-read walks every transcript.
  const firstActivity = useRef(true)
  useEffect(() => {
    if (firstActivity.current) {
      firstActivity.current = false
      return
    }
    const t = window.setTimeout(() => void reload(), 1200)
    return () => window.clearTimeout(t)
  }, [activityKey, reload])

  /** Single write path so the on-disk file always matches what is rendered. */
  const persist = useCallback((next: SessionGroup[]) => {
    setGroups(next)
    void desk.groupsWrite(next)
  }, [])

  const byId = useMemo(() => new Map(entries.map((e) => [e.sessionId, e])), [entries])

  const matches = useCallback(
    (e: HistoryEntry) => {
      const q = filter.toLowerCase()
      if (!q) return true
      return e.title.toLowerCase().includes(q) || e.cwd.toLowerCase().includes(q)
    },
    [filter],
  )

  const groupedIds = useMemo(() => new Set(groups.flatMap((g) => g.sessionIds)), [groups])
  const ungrouped = useMemo(
    () => entries.filter((e) => !groupedIds.has(e.sessionId) && matches(e)),
    [entries, groupedIds, matches],
  )

  const buckets = useMemo(() => {
    const now = Date.now()
    const out: Record<Bucket, HistoryEntry[]> = { today: [], week: [], before: [] }
    for (const e of ungrouped) out[bucketOf(e.modifiedMs, now)].push(e)
    return out
  }, [ungrouped])

  // ---- group mutations ---------------------------------------------------

  const newGroup = useCallback(() => {
    const used = new Set(groups.map((g) => g.color))
    const color = GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[groups.length % GROUP_COLORS.length]
    persist([
      ...groups,
      {
        id: crypto.randomUUID(),
        name: `Group ${groups.length + 1}`,
        color,
        collapsed: false,
        sessionIds: [],
      },
    ])
  }, [groups, persist])

  // Held in a ref so the signal effect does not re-fire when groups change.
  const newGroupRef = useRef<() => void>(() => undefined)
  newGroupRef.current = newGroup
  const firstGroupSignal = useRef(true)
  useEffect(() => {
    if (firstGroupSignal.current) {
      firstGroupSignal.current = false
      return
    }
    newGroupRef.current()
  }, [newGroupSignal])

  const patch = useCallback(
    (id: string, fn: (g: SessionGroup) => SessionGroup) =>
      persist(groups.map((g) => (g.id === id ? fn(g) : g))),
    [groups, persist],
  )

  const assign = useCallback(
    (sessionId: string, groupId: string | null) => {
      // Remove from every group first so a session lives in exactly one.
      const cleaned = groups.map((g) => ({ ...g, sessionIds: g.sessionIds.filter((s) => s !== sessionId) }))
      persist(
        groupId === null
          ? cleaned
          : cleaned.map((g) => (g.id === groupId ? { ...g, sessionIds: [sessionId, ...g.sessionIds] } : g)),
      )
    },
    [groups, persist],
  )

  /** Move a group so it lands at another group's position. */
  const reorder = useCallback(
    (srcId: string, destId: string) => {
      if (srcId === destId) return
      const from = groups.findIndex((g) => g.id === srcId)
      const to = groups.findIndex((g) => g.id === destId)
      if (from === -1 || to === -1) return
      const next = [...groups]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      persist(next)
    },
    [groups, persist],
  )

  const moveGroup = useCallback(
    (id: string, delta: -1 | 1) => {
      const from = groups.findIndex((g) => g.id === id)
      const to = from + delta
      if (from === -1 || to < 0 || to >= groups.length) return
      const next = [...groups]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      persist(next)
    },
    [groups, persist],
  )

  const dropHandlers = (groupId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      // A group being dragged reorders; a session being dragged is filed.
      if (draggingGroup) {
        if (groupId === null) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropTarget(groupId)
        return
      }
      if (!dragging) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropTarget(groupId ?? '__ungrouped__')
    },
    onDragLeave: () => setDropTarget(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      const movedGroup = e.dataTransfer.getData(GROUP_DRAG_TYPE) || draggingGroup
      if (movedGroup && groupId) {
        reorder(movedGroup, groupId)
      } else {
        const sessionId = e.dataTransfer.getData(DRAG_TYPE) || dragging
        if (sessionId) assign(sessionId, groupId)
      }
      setDropTarget(null)
      setDragging(null)
      setDraggingGroup(null)
    },
  })

  const renameEntry = useCallback((entry: HistoryEntry, title: string) => {
    // Optimistic: the SDK appends a customTitle to the transcript, and the next
    // history read picks it up, but the sidebar should not wait for that.
    setEntries((prev) => prev.map((e) => (e.sessionId === entry.sessionId ? { ...e, title } : e)))
    void desk.historyRename(entry.sessionId, title, entry.cwd).catch(() => {
      // Put the old name back if the write failed.
      setEntries((prev) => prev.map((e) => (e.sessionId === entry.sessionId ? { ...e, title: entry.title } : e)))
    })
  }, [])

  const onDragStart = useCallback((id: string) => setDragging(id), [])
  const onDragEnd = useCallback(() => {
    setDragging(null)
    setDropTarget(null)
  }, [])

  const busy = new Set(busySessionIds)
  const unread = new Set(unreadSessionIds)
  /** sessionId -> the group holding it, for the per-row menu. */
  const groupOf = new Map<string, string>()
  for (const g of groups) for (const sid of g.sessionIds) groupOf.set(sid, g.id)

  const rowProps = {
    home,
    groups,
    onAssign: assign,
    onOpen,
    onResume,
    onRename: renameEntry,
    onDragStart,
    onDragEnd,
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <button className="btn btn-primary sidebar-new" onClick={onNew} title="New session (Cmd+T)">
          +
        </button>
        <button className="btn" onClick={newGroup} title="Create a session group (Cmd+G)">
          + Group
        </button>
        <button
          className="btn sidebar-refresh"
          onClick={() => void reload()}
          disabled={refreshing}
          title="Re-read ~/.claude/projects"
        >
          {refreshing ? '·' : '↻'}
        </button>
        <button className="btn sidebar-close" onClick={onClose} title="Hide sessions (Cmd+B)">
          ‹
        </button>
      </div>
      <input
        className="filter"
        placeholder="Search sessions..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <div className="sidebar-list">
        {loading && <p className="panel-hint">Reading ~/.claude/projects...</p>}

        {groups.map((g) => {
          const members = g.sessionIds.map((id) => byId.get(id)).filter((e): e is HistoryEntry => Boolean(e))
          const visible = members.filter(matches)
          // Keep a group on screen while filtering only if something matches,
          // but always show it when the filter is empty so it can be dropped on.
          if (filter && !visible.length) return null
          return (
            <div key={g.id} className={`grp grp-${g.color}`} {...dropHandlers(g.id)}>
              <GroupHeader
                group={g}
                count={members.length}
                dropActive={dropTarget === g.id}
                profiles={profiles}
                onToggle={() => patch(g.id, (x) => ({ ...x, collapsed: !x.collapsed }))}
                onRename={(name) => patch(g.id, (x) => ({ ...x, name }))}
                onColor={(color) => patch(g.id, (x) => ({ ...x, color }))}
                onProfile={(profileId) => patch(g.id, (x) => ({ ...x, profileId }))}
                onNewChat={() => onNewInGroup(g.profileId)}
                onUngroupAll={() => patch(g.id, (x) => ({ ...x, sessionIds: [] }))}
                onDelete={() => persist(groups.filter((x) => x.id !== g.id))}
                onDragStart={() => setDraggingGroup(g.id)}
                onDragEnd={() => {
                  setDraggingGroup(null)
                  setDropTarget(null)
                }}
                onMove={(delta) => moveGroup(g.id, delta)}
                canMoveUp={groups.findIndex((x) => x.id === g.id) > 0}
                canMoveDown={groups.findIndex((x) => x.id === g.id) < groups.length - 1}
              />
              {!g.collapsed && (
                <div className="grp-body">
                  {visible.map((e) => (
                    <SessionRow
                      key={e.sessionId}
                      entry={e}
                      active={activeSessionId === e.sessionId}
                      busy={busy.has(e.sessionId)}
                      unread={unread.has(e.sessionId)}
                      groupId={groupOf.get(e.sessionId) ?? null}
                      {...rowProps}
                    />
                  ))}
                  {!members.length && <p className="grp-empty">Drag here, or use ··· on a session</p>}
                </div>
              )}
            </div>
          )
        })}

        <div
          className={`ungrouped ${dropTarget === '__ungrouped__' ? 'is-drop' : ''}`}
          {...dropHandlers(null)}
        >
          {groups.length > 0 && ungrouped.length > 0 && <div className="grp-divider">Ungrouped</div>}
          {!loading && !ungrouped.length && !groups.length && <p className="panel-hint">No sessions found.</p>}

          {BUCKET_LABELS.map(({ key, label }) => {
            const items = buckets[key]
            if (!items.length) return null
            const open = openBuckets[key]
            return (
              <div key={key} className="time-sec">
                <button
                  className="time-sec-head"
                  onClick={() => setOpenBuckets((b) => ({ ...b, [key]: !b[key] }))}
                >
                  <span className="grp-caret">{open ? '▾' : '▸'}</span>
                  <span className="time-sec-label">{label}</span>
                  <span className="time-sec-n">{items.length}</span>
                </button>
                {open &&
                  items.map((e) => (
                    <SessionRow
                      key={e.sessionId}
                      entry={e}
                      active={activeSessionId === e.sessionId}
                      busy={busy.has(e.sessionId)}
                      unread={unread.has(e.sessionId)}
                      groupId={groupOf.get(e.sessionId) ?? null}
                      {...rowProps}
                    />
                  ))}
              </div>
            )
          })}
        </div>
      </div>

    </aside>
  )
}
