import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Markdown, blockSources, replaceBlock } from './Markdown.js'
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
  /**
   * Apply an inline edit: the whole document with one block rewritten, and the
   * comments with their anchors moved to match. Absent makes the document
   * read-only, which is what a caller that has nowhere to put an edit wants.
   */
  onEdit?: (snapshot: string, comments: ReviewComment[]) => void
  /** Where the last edit went, or why it did not. Shown in the header. */
  saveNote?: string | null
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
  onEdit,
  saveNote,
}: ReaderProps): React.ReactElement {
  const docRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [body, setBody] = useState('')
  const [active, setActive] = useState<string | null>(null)
  /** The block being edited, by the same index comments are anchored to. */
  const [editing, setEditing] = useState<number | null>(null)
  const [editText, setEditText] = useState('')

  const comments = doc.comments
  const ordered = useMemo(
    () => [...comments].sort((a, b) => a.blockIndex - b.blockIndex),
    [comments],
  )

  // Selection becomes a draft card in the rail, the way Docs puts the box in
  // the margin. No floating bubble to position, and nothing to mis-place when
  // the document scrolls.
  //
  // Read on mouseup and keyup, not on `selectionchange`. `selectionchange` fires
  // on the first character of a drag, which opened the draft card immediately;
  // its autoFocus textarea then took focus and the browser dropped the drag
  // half-done, so a comment could only ever quote one letter. mouseup is the
  // point where a selection is actually finished.
  useEffect(() => {
    const onDone = (): void => {
      const root = docRef.current
      if (!root) return
      const sel = document.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
      // Selecting inside the inline editor is editing, not commenting.
      if (document.activeElement instanceof HTMLTextAreaElement) return
      const quote = sel.toString().replace(/\s+/g, ' ').trim()
      if (!quote) return
      const block = blockOf(sel.getRangeAt(0).startContainer, root)
      if (!block) return
      const index = Number(block.dataset.block)
      if (!Number.isInteger(index)) return
      setDraft({ blockIndex: index, quote: quote.slice(0, MAX_QUOTE) })
    }
    // Releasing the mouse over the rail leaves the old document range live,
    // which would otherwise reopen a draft on top of the one being typed. Not
    // needed for keyup: with no focusable document, its target is the body.
    const onMouseUp = (e: MouseEvent): void => {
      const root = docRef.current
      if (root && e.target instanceof Node && !root.contains(e.target)) return
      onDone()
    }
    // Keyboard selection ends on the keyup of the arrow, so it needs its own
    // hook. Gated on Shift to keep plain cursor movement out of it.
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.shiftKey || e.key === 'Shift' || (e.key === 'a' && (e.metaKey || e.ctrlKey))) onDone()
    }
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('keyup', onKeyUp)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('keyup', onKeyUp)
    }
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
    // these marks, and the new text needs marking from scratch. `editing` is
    // there for the same reason at one block's scale: entering or leaving the
    // editor swaps that block's DOM out, taking its marks with it.
  }, [ordered, doc.snapshot, editing])

  useEffect(() => {
    const root = docRef.current
    if (!root) return
    root.querySelectorAll<HTMLElement>('mark.rc-mark').forEach((m) => {
      m.classList.toggle('is-active', m.dataset.commentId === active)
    })
  }, [active, ordered])

  // Escape backs out of the editor before it backs out of the window, so a
  // stray keypress mid-edit does not throw the whole document away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (editing !== null) setEditing(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, editing])

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

  const startEdit = useCallback((index: number, source: string): void => {
    setEditing(index)
    setEditText(source.replace(/\s*$/, ''))
    // Otherwise the selection that put the cursor in the block is still live,
    // and the comment draft it raised sits in the rail over the editor.
    setDraft(null)
    document.getSelection()?.removeAllRanges()
  }, [])

  const commitEdit = useCallback((): void => {
    if (editing === null || !onEdit) return
    const before = blockSources(doc.snapshot).length
    const next = replaceBlock(doc.snapshot, editing, editText)
    // Editing a block can split it in two or merge it away, which moves every
    // block after it. Comments anchored past the edit have to move by the same
    // amount or their highlights land on the wrong paragraph. Comments on the
    // edited block itself keep their index: the quote may no longer be in the
    // text, in which case the highlight is skipped and the card stays in the
    // rail, which is the same degradation the reader already accepts.
    const shift = blockSources(next).length - before
    const moved = shift
      ? comments.map((c) => (c.blockIndex > editing ? { ...c, blockIndex: c.blockIndex + shift } : c))
      : comments
    setEditing(null)
    onEdit(next, moved)
  }, [editing, editText, onEdit, doc.snapshot, comments])

  const renderBlock = useCallback(
    (index: number, source: string, rendered: React.ReactNode): React.ReactNode => {
      // No editing while a round is in flight. The reply replaces the whole
      // document, so anything typed in the meantime is lost the moment it lands.
      if (!onEdit || busy) return rendered
      if (index !== editing) {
        return (
          <>
            {rendered}
            <button
              className="md-edit"
              title="Edit this block"
              onClick={() => startEdit(index, source)}
            >
              Edit
            </button>
          </>
        )
      }
      return (
        <div className="md-editor">
          {/* The block's markdown source, not its rendered text. Editing the
              rendering would need a way back to markdown that does not exist. */}
          <textarea
            className="md-editor-input"
            autoFocus
            value={editText}
            rows={Math.min(24, editText.split('\n').length + 1)}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                commitEdit()
              }
            }}
          />
          <div className="md-editor-actions">
            <span className="md-editor-hint">Cmd+Enter to apply, Esc to discard</span>
            <button className="rc-cancel" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="rc-save" onClick={commitEdit}>
              Apply
            </button>
          </div>
        </div>
      )
    },
    [editing, editText, onEdit, busy, startEdit, commitEdit],
  )

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
        {saveNote && <div className="reader-save">{saveNote}</div>}
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
            <Markdown source={doc.snapshot} anchored renderBlock={renderBlock} />
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
            <div className="rc-empty">
              Select text in the document to comment on it.
              {onEdit && ' Hover a paragraph and click Edit to change it yourself.'}
            </div>
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
