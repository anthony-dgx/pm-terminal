import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  GROUP_COLORS,
  type AgentProfile,
  type GroupColor,
  type HistoryEntry,
  type SessionGroup,
} from '../../../shared/types.js'
import { desk } from '../lib/api.js'
import {
  STATE_ORDER,
  elapsedLabel,
  fmtTokens,
  searchText,
  shortenPath,
  type SessionVitals,
} from '../lib/sessionState.js'

const DRAG_TYPE = 'application/x-claude-session'
const GROUP_DRAG_TYPE = 'application/x-claude-group'

/**
 * Below this, a query is not worth reading 120 transcripts for: two characters
 * match almost everything, so the scan would cost a lot to narrow nothing.
 */
const DEEP_MIN = 3

/** Transcripts read at once during a deep scan. */
const DEEP_CHUNK = 6

/**
 * Per-session cap on cached transcript text. Smaller than the live
 * conversations' cap because the scan holds one of these for every recorded
 * session at once.
 */
const DEEP_CAP = 80_000

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
  // Everything in the history buckets has already finished, so today's bucket
  // reads as the third status section rather than as a plain date range.
  { key: 'today', label: 'Done today' },
  { key: 'week', label: 'This week' },
  { key: 'before', label: 'Before' },
]

/** Attention first, then the freshest work. Same order every list uses. */
function byStateThenRecency(a: SessionVitals, b: SessionVitals): number {
  return STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.startedAt - a.startedAt
}

/** A group header: eyebrow, neutral count, and a rule that eats the rest. */
function SectionHead({ label, count }: { label: string; count: number }): React.ReactElement {
  return (
    <div className="sx-sec">
      <span className="eyebrow">{label}</span>
      <span className="sx-sec-n">{count}</span>
      <div className="rule" />
    </div>
  )
}

interface VitalsRowProps {
  vitals: SessionVitals
  home: string
  selected: boolean
  onSelect: (id: string) => void
  onDragStart: (sessionId: string) => void
  onDragEnd: () => void
}

/**
 * A row for a conversation that is open right now. It answers the only two
 * questions worth asking of a live agent — what is it doing, and does it want
 * me — before it says anything about where or when.
 */
function VitalsRow({
  vitals,
  home,
  selected,
  onSelect,
  onDragStart,
  onDragEnd,
}: VitalsRowProps): React.ReactElement {
  const needsHuman = vitals.state === 'needs_you' || vitals.state === 'blocked'
  // A live session is pulled out of the time buckets and rendered here instead,
  // so without this it could not be filed into a group at all — and a running
  // session is the one you most want to organise. Only possible once the CLI
  // has reported an id, which is what groups key on.
  const canDrag = Boolean(vitals.sessionId)
  return (
    <div
      className={`sx-row ${selected ? 'is-selected' : ''}`}
      onClick={() => onSelect(vitals.id)}
      title={`${vitals.title}\n${shortenPath(vitals.cwd, home)}`}
      draggable={canDrag}
      onDragStart={(e) => {
        if (!vitals.sessionId) return
        e.dataTransfer.setData(DRAG_TYPE, vitals.sessionId)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart(vitals.sessionId)
      }}
      onDragEnd={onDragEnd}
    >
      <div className="sx-row-top">
        <span className={`dot ${needsHuman ? 'dot-attn' : 'dot-running'}`} />
        <span className="sx-title">{vitals.title}</span>
        <span className="sx-elapsed">{vitals.elapsed}</span>
      </div>

      {vitals.lastLine ? (
        <div className={`sx-live ${vitals.lastLineKind === 'attn' ? 'is-attn' : ''}`}>
          {vitals.lastLine}
        </div>
      ) : null}

      {needsHuman ? (
        <div className="sx-meta">
          <span className="sx-path">{shortenPath(vitals.cwd, home)}</span>
          {vitals.tokens > 0 ? <span className="sx-tok">{fmtTokens(vitals.tokens)}</span> : null}
        </div>
      ) : // Only ever a real step count: a bar with nothing behind it is a lie,
      // and the redesign removed the indeterminate crawl on purpose.
      vitals.progress ? (
        <div className="track">
          <span
            style={{ width: `${Math.round((vitals.progress.done / vitals.progress.total) * 100)}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}

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
  /** Single-line form for the finished sessions in the time buckets. */
  dense?: boolean
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
  dense,
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

  const titleInput = (
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
  )

  return (
    <div
      // `hist` stays on dense rows: it carries the hover actions, the move-to
      // menu and the drag affordance, which the redesign keeps as they are.
      className={
        dense
          ? `hist sx-row-done ${active ? 'is-selected' : ''} ${unread ? 'is-unread' : ''}`
          : `hist ${active ? 'is-active' : ''} ${unread ? 'is-unread' : ''}`
      }
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
      title={dense ? `${entry.title}\n${shortenPath(entry.cwd, home)}` : undefined}
    >
      {dense ? (
        <>
          {/* A finished session says everything it has to say on one line. */}
          <span className={`dot ${busy ? 'dot-running' : unread ? 'dot-attn' : 'dot-done'}`} />
          {editing ? (
            titleInput
          ) : (
            <span
              className="sx-title"
              onDoubleClick={(e) => {
                e.stopPropagation()
                setEditing(true)
              }}
            >
              {entry.title}
            </span>
          )}
          <span className="sx-elapsed">{elapsedLabel(entry.modifiedMs)}</span>
        </>
      ) : (
        <>
          {editing ? (
            titleInput
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
            <span className="hist-cwd">{shortenPath(entry.cwd, home)}</span>
            {busy ? <span className="hist-busy" title="Working in this session">working</span> : null}
            {/* Only when idle: while it is still working, "working" is the truer
                label and two badges on one row is noise. */}
            {unread && !busy ? (
              <span className="hist-new" title="Answered while you were elsewhere">
                <span className="pip" />
                new
              </span>
            ) : null}
            <span>{elapsedLabel(entry.modifiedMs)}</span>
          </div>
        </>
      )}
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
  /** Live status for every conversation currently open, unsorted. */
  vitals: SessionVitals[]
  /** Conversation id on screen (NOT a sessionId). */
  activeConversationId: string
  /** Switch to an already-open conversation by conversation id. */
  onSelectConversation: (id: string) => void
  /** Short build sha for the footer, may be empty. */
  build?: string
  /**
   * Flattened, already lower-cased transcript text per open conversation, keyed
   * by conversation id. Searching a live agent's output needs the turns App
   * holds; the sidebar only ever has history rows.
   */
  searchTextById?: Record<string, string>
  /** Attached to the search field so the host's `/` and Cmd+F can focus it. */
  searchRef?: React.Ref<HTMLInputElement>
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
  vitals,
  activeConversationId,
  onSelectConversation,
  build,
  searchTextById,
  searchRef,
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

  // ---- search ------------------------------------------------------------

  /*
   * The handoff asks search to match titles, working directories *and*
   * transcript output. The three sources of that text are very different in
   * cost, so they are searched in three tiers:
   *
   *   1. Title, path and opening prompt of a recorded session — in hand already.
   *   2. Flattened transcripts of the open conversations — handed down by App,
   *      cached there against the turns array.
   *   3. Full transcripts of recorded sessions — one file read each, so only on
   *      a query worth it, lazily, cached, and never on the keystroke itself.
   */

  /** The query, debounced. Clearing is instant; typing is not. */
  const [query, setQuery] = useState('')
  useEffect(() => {
    const next = filter.trim().toLowerCase()
    if (!next) {
      setQuery('')
      return
    }
    const t = window.setTimeout(() => setQuery(next), 160)
    return () => window.clearTimeout(t)
  }, [filter])

  /** Tier 1: everything a history row already carries. */
  const shallowMatch = useCallback(
    (e: HistoryEntry, q: string) =>
      e.title.toLowerCase().includes(q) ||
      e.cwd.toLowerCase().includes(q) ||
      // The opening prompt is transcript output, and it was already loaded.
      e.firstPrompt.toLowerCase().includes(q),
    [],
  )

  /** sessionId -> flattened transcript, for every recorded session ever scanned. */
  const deepCache = useRef(new Map<string, string>())
  const [deepHits, setDeepHits] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    if (query.length < DEEP_MIN) {
      setDeepHits(new Set())
      setScanning(false)
      return
    }
    let cancelled = false
    const q = query
    const hits = new Set<string>()

    // Only sessions a cheap match cannot already reach.
    const candidates = entries.filter((e) => !shallowMatch(e, q))
    // Anything read for an earlier query stays in memory, so refining a query
    // over the same corpus costs nothing.
    const unread = candidates.filter((e) => {
      const cached = deepCache.current.get(e.sessionId)
      if (cached === undefined) return true
      if (cached.includes(q)) hits.add(e.sessionId)
      return false
    })
    setDeepHits(new Set(hits))

    if (!unread.length) {
      setScanning(false)
      return
    }
    setScanning(true)
    void (async () => {
      for (let i = 0; i < unread.length && !cancelled; i += DEEP_CHUNK) {
        const slice = unread.slice(i, i + DEEP_CHUNK)
        const texts = await Promise.all(
          slice.map(async (e) => {
            try {
              return searchText(await desk.historyRead(e.projectSlug, e.sessionId), DEEP_CAP)
            } catch {
              // An unreadable transcript is cached as empty rather than retried
              // on every keystroke.
              return ''
            }
          }),
        )
        if (cancelled) return
        let added = false
        slice.forEach((e, j) => {
          deepCache.current.set(e.sessionId, texts[j])
          if (texts[j].includes(q)) {
            hits.add(e.sessionId)
            added = true
          }
        })
        // Results appear as they are found rather than after the whole sweep.
        if (added) setDeepHits(new Set(hits))
      }
      if (!cancelled) setScanning(false)
    })()

    return () => {
      cancelled = true
    }
  }, [query, entries, shallowMatch])

  const matches = useCallback(
    (e: HistoryEntry) => {
      if (!query) return true
      return shallowMatch(e, query) || deepHits.has(e.sessionId)
    },
    [query, shallowMatch, deepHits],
  )

  // ---- live status sections ----------------------------------------------

  const vitalsMatches = useCallback(
    (v: SessionVitals) => {
      if (!query) return true
      return (
        v.title.toLowerCase().includes(query) ||
        v.cwd.toLowerCase().includes(query) ||
        v.lastLine.toLowerCase().includes(query) ||
        // Already lower-cased upstream.
        (searchTextById?.[v.id]?.includes(query) ?? false)
      )
    },
    [query, searchTextById],
  )

  // Blocked belongs under NEEDS YOU: from the list's point of view both mean a
  // person has to do something before the agent moves again.
  const needsYou = useMemo(
    () =>
      vitals
        .filter((v) => (v.state === 'needs_you' || v.state === 'blocked') && vitalsMatches(v))
        .sort(byStateThenRecency),
    [vitals, vitalsMatches],
  )
  const running = useMemo(
    () => vitals.filter((v) => v.state === 'running' && vitalsMatches(v)).sort(byStateThenRecency),
    [vitals, vitalsMatches],
  )

  /**
   * Sessions already accounted for above. A row that is live says more than the
   * history entry behind it, so the history sections drop the duplicate rather
   * than listing the same session twice with two different stories.
   */
  const liveSessionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const v of vitals) if (v.state !== 'done' && v.sessionId) ids.add(v.sessionId)
    return ids
  }, [vitals])

  const groupedIds = useMemo(() => new Set(groups.flatMap((g) => g.sessionIds)), [groups])
  const ungrouped = useMemo(
    () =>
      entries.filter(
        (e) => !groupedIds.has(e.sessionId) && !liveSessionIds.has(e.sessionId) && matches(e),
      ),
    [entries, groupedIds, liveSessionIds, matches],
  )

  const buckets = useMemo(() => {
    const now = Date.now()
    const out: Record<Bucket, HistoryEntry[]> = { today: [], week: [], before: [] }
    for (const e of ungrouped) out[bucketOf(e.modifiedMs, now)].push(e)
    return out
  }, [ungrouped])

  /**
   * The footer counts the corpus, not the view: it is there to say how much
   * history exists behind the list, so a filter must not change it.
   */
  const archive = useMemo(() => {
    const now = Date.now()
    let week = 0
    let before = 0
    for (const e of entries) {
      const b = bucketOf(e.modifiedMs, now)
      if (b === 'week') week++
      else if (b === 'before') before++
    }
    return { week, before }
  }, [entries])

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

  /** How many grouped sessions survive the query, for the empty state. */
  const groupHits = useMemo(
    () =>
      groups.reduce(
        (n, g) =>
          n +
          g.sessionIds.filter((id) => {
            const e = byId.get(id)
            return Boolean(e) && matches(e as HistoryEntry)
          }).length,
        0,
      ),
    [groups, byId, matches],
  )

  /**
   * The whole column came back empty. Distinct from "this section is empty":
   * only then is it worth saying anything, and what to say depends on whether a
   * query is what emptied it.
   */
  const nothingVisible =
    !loading && !needsYou.length && !running.length && !groupHits && !ungrouped.length

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
    <aside className="sidebar sx-sidebar">
      <div className="sx-head">
        <div className="sx-search">
          <span className="sx-slash">/</span>
          <input
            ref={searchRef}
            className="sx-search-input"
            placeholder="Search sessions, paths, output…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              // Escape hands the keyboard back rather than leaving you stuck in
              // a field you only meant to glance at.
              if (e.key !== 'Escape') return
              if (filter) setFilter('')
              else e.currentTarget.blur()
            }}
          />
          <span className="keyhint">⌘K</span>
        </div>
        <button className="sx-new" onClick={onNew} title="New session (Cmd+T)">
          ＋
        </button>
      </div>

      {/* Kept off the header row: it is a search field and one primary action,
          and three more glyphs beside them is the chrome the redesign trims. */}
      <div className="sx-tools">
        <button className="sx-tool" onClick={newGroup} title="Create a session group (Cmd+G)">
          ＋ Group
        </button>
        <button
          className="sx-tool sx-tool-end"
          onClick={() => void reload()}
          disabled={refreshing}
          title="Re-read ~/.claude/projects"
        >
          {refreshing ? '·' : '↻'}
        </button>
        <button className="sx-tool" onClick={onClose} title="Hide sessions (Cmd+B)">
          ‹
        </button>
      </div>

      <div className="sidebar-list">
        {loading && <p className="sx-note">Reading ~/.claude/projects…</p>}

        {/* Say when the slow tier is running: a search that is still reading
            transcripts must not look like a search that found nothing. */}
        {scanning && <p className="sx-note">Reading transcripts…</p>}

        {/* Status first: the open conversations, sorted so anything waiting on
            a person is the first thing in the column. */}
        {needsYou.length > 0 && (
          <>
            <SectionHead label="Needs you" count={needsYou.length} />
            {needsYou.map((v) => (
              <VitalsRow
                key={v.id}
                vitals={v}
                home={home}
                selected={v.id === activeConversationId}
                onSelect={onSelectConversation}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
              />
            ))}
          </>
        )}

        {running.length > 0 && (
          <>
            <SectionHead label="Running" count={running.length} />
            {running.map((v) => (
              <VitalsRow
                key={v.id}
                vitals={v}
                home={home}
                selected={v.id === activeConversationId}
                onSelect={onSelectConversation}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
              />
            ))}
          </>
        )}

        {groups.map((g) => {
          // Same de-dupe the time buckets apply: a session that is currently
          // live already has a status row at the top of the column, and listing
          // its history entry here too showed it twice with two different
          // stories. The count still reflects real membership.
          const members = g.sessionIds
            .map((id) => byId.get(id))
            .filter((e): e is HistoryEntry => Boolean(e) && !liveSessionIds.has(e!.sessionId))
          const visible = members.filter(matches)
          // Keep a group on screen while filtering only if something matches,
          // but always show it when the filter is empty so it can be dropped on.
          if (query && !visible.length) return null
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
                  {!members.length && <p className="sx-note">Drag here, or use ··· on a session</p>}
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

          {/* A query that found nothing and an account with no history are two
              different situations, and only one of them has a way out. */}
          {nothingVisible && !scanning && (
            <div className="sx-empty">
              <span className="eyebrow">{query ? 'No match' : 'No sessions'}</span>
              {query ? (
                <>
                  <p className="sx-note">
                    Nothing in titles, paths or transcript output matches “{filter.trim()}”.
                  </p>
                  <button className="obtn" onClick={() => setFilter('')}>
                    Clear search
                  </button>
                </>
              ) : (
                <>
                  <p className="sx-note">Nothing recorded in ~/.claude/projects yet.</p>
                  <button className="pbtn" onClick={onNew}>
                    ＋ New session
                  </button>
                </>
              )}
            </div>
          )}

          {BUCKET_LABELS.map(({ key, label }) => {
            const items = buckets[key]
            if (!items.length) return null
            const open = openBuckets[key]
            return (
              <div key={key} className="time-sec">
                <button
                  className="sx-sec"
                  onClick={() => setOpenBuckets((b) => ({ ...b, [key]: !b[key] }))}
                >
                  <span className="sx-sec-caret">{open ? '▾' : '▸'}</span>
                  <span className="eyebrow">{label}</span>
                  <span className="sx-sec-n">{items.length}</span>
                  <div className="rule" />
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
                      dense
                      {...rowProps}
                    />
                  ))}
              </div>
            )
          })}
        </div>
      </div>

      <div className="sx-foot">
        <span>This week {archive.week}</span>
        <span>Before {archive.before}</span>
        <div className="sx-foot-gap" />
        {build ? <span>{build}</span> : null}
      </div>
    </aside>
  )
}
