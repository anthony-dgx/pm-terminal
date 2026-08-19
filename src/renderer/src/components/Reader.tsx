import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from './Markdown.js'
import { CopyButton } from './Copy.js'
import { clearMarks, markQuote } from '../lib/highlight.js'
import { ReviewContext, type ReviewComment, type ReviewDoc, type ReviewRound } from '../review.js'

const MAX_QUOTE = 300

/** Nearest ancestor that carries a block index, or null if outside the doc. */
function blockOf(node: Node | null, root: HTMLElement): HTMLElement | null {
  let el = node instanceof HTMLElement ? node : (node?.parentElement ?? null)
  while (el && el !== root) {
    if (el.dataset.block !== undefined) return el
    el = el.parentElement
  }
  return null
}

interface Draft {
  blockIndex: number
  quote: string
}

interface ReaderProps {
  doc: ReviewDoc
  rounds: ReviewRound[]
  onChange: (comments: ReviewComment[]) => void
  onSend: () => void
  onClose: () => void
  /** True while the conversation is waiting on the agent. */
  busy?: boolean
  /** Own window rather than an overlay: no app titlebar above it. */
  standalone?: boolean
  /** A round is in flight, for the status line. */
  waiting?: boolean
  error?: string | null
  /**
   * The agent's prose reply, shown when it answered with something other than a
   * document. In a detached window there is no transcript for that to land in,
   * and swapping it in would destroy the document - so it shows here instead.
   */
  reply?: string | null
  onDismissReply?: () => void
}

export function Reader({
  doc,
  rounds,
  onChange,
  onSend,
  onClose,
  busy,
  standalone,
  waiting,
  error,
  reply,
  onDismissReply,
}: ReaderProps): React.ReactElement {
  const docRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [body, setBody] = useState('')
  const [active, setActive] = useState<string | null>(null)

  const comments = doc.comments
  const ordered = useMemo(
    () => [...comments].sort((a, b) => a.blockIndex - b.blockIndex),
    [comments],
  )

  // Selection becomes a draft card in the rail, the way Docs puts the box in
  // the margin. No floating bubble to position, and nothing to mis-place when
  // the document scrolls.
  useEffect(() => {
    const onSelect = (): void => {
      const root = docRef.current
      if (!root) return
      const sel = document.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
      const quote = sel.toString().replace(/\s+/g, ' ').trim()
      if (!quote) return
      const block = blockOf(sel.getRangeAt(0).startContainer, root)
      if (!block) return
      const index = Number(block.dataset.block)
      if (!Number.isInteger(index)) return
      setDraft({ blockIndex: index, quote: quote.slice(0, MAX_QUOTE) })
    }
    document.addEventListener('selectionchange', onSelect)
    return () => document.removeEventListener('selectionchange', onSelect)
  }, [])

  // Re-highlight from scratch whenever the comment set changes. Safe to mutate
  // this DOM: the snapshot is frozen while the reader is open, so React never
  // re-renders the blocks underneath us.
  useEffect(() => {
    const root = docRef.current
    if (!root) return
    clearMarks(root)
    for (const c of ordered) {
      const block = root.querySelector<HTMLElement>(`[data-block="${c.blockIndex}"]`)
      if (block) markQuote(block, c.quote, c.id)
    }
    // Snapshot is in the deps because a rewrite replaces the blocks underneath
    // these marks, and the new text needs marking from scratch.
  }, [ordered, doc.snapshot])

  useEffect(() => {
    const root = docRef.current
    if (!root) return
    root.querySelectorAll<HTMLElement>('mark.rc-mark').forEach((m) => {
      m.classList.toggle('is-active', m.dataset.commentId === active)
    })
  }, [active, ordered])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const commit = useCallback((): void => {
    if (!draft || !body.trim()) return
    const comment: ReviewComment = {
      id: `rc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      blockIndex: draft.blockIndex,
      quote: draft.quote,
      body: body.trim(),
      at: new Date().toISOString(),
    }
    onChange([...comments, comment])
    setDraft(null)
    setBody('')
    document.getSelection()?.removeAllRanges()
  }, [draft, body, comments, onChange])

  const remove = useCallback(
    (id: string): void => onChange(comments.filter((c) => c.id !== id)),
    [comments, onChange],
  )

  const focus = useCallback((id: string): void => {
    setActive(id)
    docRef.current
      ?.querySelector<HTMLElement>(`mark.rc-mark[data-comment-id="${id}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [])

  const onDocClick = useCallback((e: React.MouseEvent): void => {
    const mark = (e.target as HTMLElement).closest<HTMLElement>('mark.rc-mark')
    if (mark?.dataset.commentId) setActive(mark.dataset.commentId)
  }, [])

  const n = comments.length

  return (
    <div
      className={`reader ${standalone ? 'is-standalone' : ''}`}
      role="dialog"
      aria-label="Document review"
    >
      <div className="reader-head">
        <div className="reader-title">{doc.title}</div>
        <div className="reader-count">
          {n} comment{n === 1 ? '' : 's'}
        </div>
        <div className="reader-actions">
          <CopyButton text={() => doc.snapshot} label="Copy" />
          <button className="reader-btn is-primary" disabled={!n || busy} onClick={onSend}>
            Ready for changes
          </button>
          <button className="reader-close" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
      </div>

      <div className="reader-body">
        <div className="reader-doc" ref={docRef} onClick={onDocClick}>
          {/* Null provider so a fenced markdown block inside the document does
              not offer to open a second reader on top of this one. */}
          <ReviewContext.Provider value={null}>
            <Markdown source={doc.snapshot} anchored />
          </ReviewContext.Provider>
        </div>

        <div className="reader-rail">
          {waiting && (
            <div className="rc-status">
              Applying your comments. The document updates here when it comes back.
            </div>
          )}

          {error && <div className="rc-status is-error">{error}</div>}

          {reply && (
            <div className="rc-reply">
              <div className="rc-reply-head">
                <span>Claude</span>
                <button className="rc-cancel" onClick={onDismissReply}>
                  Dismiss
                </button>
              </div>
              <div className="rc-reply-body">
                {/* Null provider: a fence in the reply must not offer to open
                    yet another review window on top of this one. */}
                <ReviewContext.Provider value={null}>
                  <Markdown source={reply} />
                </ReviewContext.Provider>
              </div>
            </div>
          )}

          {draft && (
            <div className="rc-card is-draft">
              <div className="rc-quote">{draft.quote}</div>
              <textarea
                className="rc-input"
                autoFocus
                placeholder="Comment"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    commit()
                  }
                }}
              />
              <div className="rc-card-actions">
                <button
                  className="rc-cancel"
                  onClick={() => {
                    setDraft(null)
                    setBody('')
                  }}
                >
                  Cancel
                </button>
                <button className="rc-save" disabled={!body.trim()} onClick={commit}>
                  Comment
                </button>
              </div>
            </div>
          )}

          {ordered.map((c) => (
            <div
              key={c.id}
              className={`rc-card ${active === c.id ? 'is-active' : ''}`}
              onClick={() => focus(c.id)}
            >
              <div className="rc-quote">{c.quote}</div>
              <div className="rc-body">{c.body}</div>
              <div className="rc-card-actions">
                <button
                  className="rc-cancel"
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(c.id)
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}

          {!n && !draft && (
            <div className="rc-empty">Select text in the document to comment on it.</div>
          )}

          {rounds.length > 0 && (
            <div className="rc-rounds">
              {rounds.map((r, i) => (
                <details key={r.at} className="rc-round">
                  <summary>
                    Round {i + 1} · {r.comments.length} sent
                  </summary>
                  {r.comments.map((c) => (
                    <div key={c.id} className="rc-card is-past">
                      <div className="rc-quote">{c.quote}</div>
                      <div className="rc-body">{c.body}</div>
                    </div>
                  ))}
                </details>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
