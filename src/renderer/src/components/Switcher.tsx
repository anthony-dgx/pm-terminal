import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HistoryEntry } from '../../../shared/types.js'
import { desk } from '../lib/api.js'
import { STATE_LABEL, type SessionState } from '../lib/sessionState.js'

/**
 * Deeper than the sidebar's 120. This is the "find any session" surface, so a
 * session it cannot reach is a bug in the feature. The footer says how many
 * were loaded, because a silent cap reads as "searched everything".
 */
const LIMIT = 400

/** Rows shown at once. The list is keyboard-driven, so a long one is noise. */
const MAX_ROWS = 40

/** A session you can jump to, from either source. */
export interface SwitcherItem {
  /** Conversation id for an open one, session id for a recorded one. */
  key: string
  title: string
  cwd: string
  /** Matched on too, so "the one where I asked about pricing" is findable. */
  detail: string
  /** Null for a conversation that has not started, so has no session yet. */
  sessionId: string | null
  open: boolean
  /**
   * Status of an open conversation. Absent for a recorded session: a transcript
   * on disk is not in any state, it is just a transcript.
   */
  state?: SessionState
  /** Open and holding an answer nobody has read. Never true for a recorded one. */
  unread?: boolean
  /** Sort key within a section. */
  at: number
  entry: HistoryEntry | null
}

/** Stopped on a person, either by asking or by failing. */
function needsAttention(item: SwitcherItem): boolean {
  return item.state === 'needs_you' || item.state === 'blocked'
}

/** The dot classes are shared with the session rows, so the two agree on colour. */
function dotClass(item: SwitcherItem): string {
  if (needsAttention(item)) return 'dot-attn'
  if (item.state === 'running') return 'dot-running'
  return 'dot-done'
}

/**
 * Score a session against the query. Title beats directory beats first prompt,
 * and a prefix beats a substring, so typing a project name surfaces the
 * sessions named after it before ones that merely mention it.
 *
 * Mirrors the intent of `rank()` in Composer.tsx so both pickers feel the same.
 */
function score(item: SwitcherItem, q: string): number {
  const title = item.title.toLowerCase()
  const cwd = item.cwd.toLowerCase()
  const detail = item.detail.toLowerCase()
  if (title.startsWith(q)) return 0
  if (title.includes(q)) return 1
  // The last path segment is what people think of as the project.
  if (cwd.slice(cwd.lastIndexOf('/') + 1).startsWith(q)) return 2
  if (cwd.includes(q)) return 3
  if (detail.includes(q)) return 4
  return -1
}

interface Props {
  /** Conversations already on screen, including ones never started. */
  openItems: SwitcherItem[]
  onPick: (item: SwitcherItem) => void
  onClose: () => void
  home: string
}

export function Switcher({ openItems, onPick, onClose, home }: Props): React.ReactElement {
  const [query, setQuery] = useState('')
  const [history, setHistory] = useState<HistoryEntry[] | null>(null)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    let live = true
    void desk.historyList({ limit: LIMIT }).then((h) => {
      if (live) setHistory(h)
    })
    return () => {
      live = false
    }
  }, [])

  const items = useMemo<SwitcherItem[]>(() => {
    // An open conversation wins over its own history row: switching to the live
    // one is what you want, and two rows for one session is confusing.
    const seen = new Set(openItems.map((i) => i.sessionId).filter(Boolean) as string[])
    const recorded: SwitcherItem[] = (history ?? [])
      .filter((e) => !seen.has(e.sessionId))
      .map((e) => ({
        key: e.sessionId,
        title: e.title,
        cwd: e.cwd,
        detail: e.firstPrompt,
        sessionId: e.sessionId,
        open: false,
        at: e.modifiedMs,
        entry: e,
      }))
    return [...openItems, ...recorded]
  }, [openItems, history])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      // Unread first, then open, then most recent. The titlebar's "N to read"
      // opens this with no query, so an unread session buried 30 rows down
      // would make that button useless. Array.sort is stable, so everything
      // else keeps the order it already had.
      return [...items].sort((a, b) => Number(!!b.unread) - Number(!!a.unread)).slice(0, MAX_ROWS)
    }
    return items
      .map((item) => ({ item, s: score(item, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s || Number(b.item.open) - Number(a.item.open) || b.item.at - a.item.at)
      .slice(0, MAX_ROWS)
      .map((x) => x.item)
  }, [items, query])

  /**
   * Anything waiting on a person goes first, whatever the query scored it.
   *
   * The handoff's palette leads with a NEEDS ATTENTION section, and the same
   * rule the session column follows applies here: a session that has stopped on
   * you is the one you were looking for more often than not. A stable sort, so
   * relevance still decides the order inside each section.
   */
  const ordered = useMemo(
    () => [...results].sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a))),
    [results],
  )

  /**
   * The rows to draw, each carrying the section header that precedes it — a
   * header only where the section changes, so the flat index the keyboard moves
   * through still lines up with what is on screen.
   */
  const rows = useMemo(() => {
    let previous = ''
    return ordered.map((item) => {
      const section = needsAttention(item)
        ? 'NEEDS ATTENTION'
        : query.trim()
          ? 'SESSIONS'
          : 'RECENT'
      const head = section === previous ? null : section
      previous = section
      return { item, head }
    })
  }, [ordered, query])

  // A query change reshuffles the list, so an old index would point at
  // whatever happens to sit there now.
  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    listRef.current?.querySelector('.switch-item.is-on')?.scrollIntoView({ block: 'nearest' })
  }, [active, rows])

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => (ordered.length ? (i + 1) % ordered.length : 0))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (ordered.length ? (i - 1 + ordered.length) % ordered.length : 0))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const pick = ordered[active]
        if (pick) onPick(pick)
      }
    },
    [ordered, active, onPick, onClose],
  )

  const shorten = (cwd: string): string => (cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd)

  return (
    // Clicking the scrim dismisses, the way Spotlight does.
    <div className="switch-scrim" onMouseDown={onClose}>
      <div className="switch" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="switch-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="Search sessions"
          spellCheck={false}
        />

        <div className="switch-list" ref={listRef}>
          {rows.map(({ item, head }, i) => (
            <Fragment key={item.key}>
              {head && <div className="switch-sec">{head}</div>}
              <button
                className={`switch-item ${i === active ? 'is-on' : ''}`}
                // Enter is the real path; the mouse just needs to agree with it.
                onMouseMove={() => setActive(i)}
                onClick={() => onPick(item)}
              >
                <span className="switch-title">
                  <span className={`dot ${dotClass(item)}`} />
                  {/* Its own element so it can ellipsise. A bare text node in a
                      flex row is an anonymous item that text-overflow cannot
                      reach, which is what broke the titlebar pickers. */}
                  <span className="switch-name">{item.title}</span>
                  {/* The consequence, named inline: on an attention row that is
                      why it stopped, not merely that it is open. */}
                  {item.state && needsAttention(item) ? (
                    <span className="switch-badge is-unread">
                      {STATE_LABEL[item.state].toLowerCase()}
                    </span>
                  ) : (
                    <>
                      {/* `open` and `new` are independent facts — an open
                          session can also have an unread answer. Chaining them
                          into one else-if hid `open` on exactly those rows. */}
                      {item.unread && (
                        <span className="switch-badge is-unread" title="Answered while you were elsewhere">
                          new
                        </span>
                      )}
                      {item.open && <span className="switch-badge">open</span>}
                    </>
                  )}
                </span>
                <span className="switch-cwd">{shorten(item.cwd)}</span>
              </button>
            </Fragment>
          ))}
          {!rows.length && (
            <p className="switch-empty">{history === null ? 'Loading sessions...' : 'Nothing matches.'}</p>
          )}
        </div>

        <div className="switch-foot">
          <span>
            {/* Say the size of the haystack. A capped search that looks
                exhaustive is worse than one that admits its limit. */}
            {history === null ? 'Loading...' : `${items.length} session${items.length === 1 ? '' : 's'}`}
            {history?.length === LIMIT && ` (most recent ${LIMIT})`}
          </span>
          <span className="switch-keys">
            <span className="keyhint">↑↓ move</span>
            <span className="keyhint">⏎ run</span>
            <span className="keyhint">esc to close</span>
          </span>
        </div>
      </div>
    </div>
  )
}
