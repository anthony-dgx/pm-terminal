import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, SkillView } from '../../../shared/types.js'
import { desk } from '../lib/api.js'
import { fileToAttachment, imageFilesFrom } from '../lib/images.js'

const MAX_RESULTS = 60

/**
 * Rank skills for a `/query`. Prefix beats namespace-prefix beats substring
 * beats description hit, so `/pm` surfaces `/pm:...` before `/optimize-pm`.
 */
function rank(skills: SkillView[], query: string): SkillView[] {
  const q = query.toLowerCase()
  if (!q) return skills

  const scored: { s: SkillView; score: number }[] = []
  for (const s of skills) {
    const name = s.name.toLowerCase()
    const bare = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
    let score = -1
    if (name.startsWith(q)) score = 0
    else if (bare.startsWith(q)) score = 1
    else if (name.includes(q)) score = 2
    else if (s.description.toLowerCase().includes(q)) score = 3
    if (score >= 0) scored.push({ s, score })
  }
  return scored
    .sort((a, b) => a.score - b.score || a.s.name.length - b.s.name.length || a.s.name.localeCompare(b.s.name))
    .map((x) => x.s)
}

/** The `/token` being typed, or null when the caret is not in one. */
function activeQuery(text: string, caret: number): string | null {
  const before = text.slice(0, caret)
  // A slash command is only a command at the very start of the message.
  const m = before.match(/^\/(\S*)$/)
  return m ? m[1] : null
}

interface Props {
  clientId: string
  /** The session's directory, needed to list skills before a session exists. */
  cwd: string
  value: string
  onChange: (v: string) => void
  onSubmit: (images: Attachment[]) => void
  placeholder: string
  disabled: boolean
  /** Bumped when a session starts, so the live list replaces the pre-session one. */
  skillsKey: number
  /** True while a reply is in flight. */
  working?: boolean
  /** Prompts already sent in this session, oldest first. */
  history: string[]
  /**
   * Everything currently wrong, oldest first. Rendered as a one-line strip
   * above the input showing the newest, with the rest one click away — these
   * are the app's only channel for MCP and SDK failures, so none of them may
   * be silently dropped.
   */
  warnings?: Notice[]
  /** Clears one notice by index. */
  onDismissWarning?: (index: number) => void
}

export interface Notice {
  level: string
  text: string
  fixHref?: string
}

export function Composer({
  clientId,
  cwd,
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  skillsKey,
  working = false,
  history,
  warnings = [],
  onDismissWarning,
}: Props): React.ReactElement {
  const [skills, setSkills] = useState<SkillView[]>([])
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // Shell-style recall: null means "editing my own draft", otherwise an index
  // into `history`. The draft is stashed so Down can bring it back.
  const histIndex = useRef<number | null>(null)
  const [images, setImages] = useState<Attachment[]>([])
  const [dropping, setDropping] = useState(false)
  const stashedDraft = useRef('')
  const listRef = useRef<HTMLDivElement>(null)
  /**
   * Whether the older notices are showing. Dismissal itself is the owner's job
   * (see `onDismissWarning`): keeping a local "already seen this text" set is
   * what previously made a *recurring* failure — the same MCP server failing on
   * every session start — disappear after the first time, and leaked that
   * suppression across session switches, since this component is not remounted.
   */
  const [showAllWarnings, setShowAllWarnings] = useState(false)

  useEffect(() => {
    void desk.skills(clientId, cwd).then(setSkills)
  }, [skillsKey, clientId, cwd])

  const matches = useMemo(() => (query === null ? [] : rank(skills, query)), [skills, query])
  // Cap what is rendered, but never lie about how many matched.
  const results = useMemo(() => matches.slice(0, MAX_RESULTS), [matches])
  const open = query !== null && results.length > 0

  useEffect(() => {
    setActive(0)
  }, [query])

  // Keep the highlighted row in view while arrowing through a long list.
  useLayoutEffect(() => {
    if (!open) return
    listRef.current?.querySelector('.slash-item.is-on')?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const syncQuery = useCallback((el: HTMLTextAreaElement) => {
    setQuery(activeQuery(el.value, el.selectionStart ?? el.value.length))
  }, [])

  /** Put a recalled prompt in the box with the caret at the end. */
  const recall = useCallback(
    (text: string) => {
      onChange(text)
      requestAnimationFrame(() => {
        const el = taRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(text.length, text.length)
      })
    },
    [onChange],
  )

  /**
   * One step back through the prompt history, shared by Up and the history
   * chip, so both walk the same cursor instead of two competing ones.
   */
  const historyBack = useCallback(() => {
    if (!history.length) return
    if (histIndex.current === null) {
      stashedDraft.current = taRef.current?.value ?? ''
      histIndex.current = history.length - 1
    } else if (histIndex.current > 0) {
      histIndex.current -= 1
    }
    recall(history[histIndex.current])
  }, [history, recall])

  /** Drop text in at the caret, replacing any selection. */
  const insert = useCallback(
    (text: string) => {
      const el = taRef.current
      const start = el?.selectionStart ?? value.length
      const end = el?.selectionEnd ?? value.length
      const next = value.slice(0, start) + text + value.slice(end)
      const caret = start + text.length
      onChange(next)
      requestAnimationFrame(() => {
        el?.focus()
        el?.setSelectionRange(caret, caret)
      })
      return next
    },
    [onChange, value],
  )

  /**
   * The skills chip types the slash for you. A slash is only a command at the
   * very start of the message, so it goes there rather than at the caret, and
   * the menu is opened directly instead of waiting for a keystroke to notice.
   */
  const openSkills = useCallback(() => {
    const next = value.startsWith('/') ? value : `/${value}`
    onChange(next)
    setQuery(activeQuery(next, 1))
    requestAnimationFrame(() => {
      const el = taRef.current
      el?.focus()
      el?.setSelectionRange(1, 1)
    })
  }, [onChange, value])

  const accept = useCallback(
    (skill: SkillView) => {
      // Trailing space unless the skill wants arguments typed right away.
      const next = `/${skill.name} `
      onChange(next)
      setQuery(null)
      requestAnimationFrame(() => {
        const el = taRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(next.length, next.length)
      })
    },
    [onChange],
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => (i + 1) % results.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (i - 1 + results.length) % results.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        // Enter picks the skill instead of sending while the menu is up.
        e.preventDefault()
        accept(results[active])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setQuery(null)
        return
      }
    }
    // History recall, only when the caret could not usefully move instead. Up
    // on the first line and Down on the last line are free; anywhere else the
    // arrows must still move the caret through a multi-line draft.
    const el = e.currentTarget
    const collapsed = el.selectionStart === el.selectionEnd
    const onFirstLine = !el.value.slice(0, el.selectionStart ?? 0).includes('\n')
    const onLastLine = !el.value.slice(el.selectionEnd ?? 0).includes('\n')

    if (e.key === 'ArrowUp' && collapsed && onFirstLine && history.length) {
      e.preventDefault()
      historyBack()
      return
    }

    if (e.key === 'ArrowDown' && collapsed && onLastLine && histIndex.current !== null) {
      e.preventDefault()
      if (histIndex.current < history.length - 1) {
        histIndex.current += 1
        recall(history[histIndex.current])
      } else {
        // Past the newest entry, hand back whatever was being typed.
        histIndex.current = null
        recall(stashedDraft.current)
      }
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const submit = (): void => {
    histIndex.current = null
    stashedDraft.current = ''
    onSubmit(images)
    setImages([])
  }

  const ingest = useCallback(async (files: File[]) => {
    const added = (await Promise.all(files.map(fileToAttachment))).filter((a): a is Attachment => a !== null)
    if (added.length) setImages((prev) => [...prev, ...added])
  }, [])

  // Newest last, and the newest is the one worth showing when collapsed.
  const shownWarnings = showAllWarnings ? [...warnings].reverse() : warnings.slice(-1)
  const hiddenWarnings = warnings.length - shownWarnings.length

  return (
    <div
      className={`composer tx-composer ${working ? 'is-working' : ''} ${dropping ? 'is-dropping' : ''}`}
      onDragOver={(e) => {
        if (!imageFilesFrom(e.dataTransfer).length && !e.dataTransfer?.types.includes('Files')) return
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        const files = imageFilesFrom(e.dataTransfer)
        setDropping(false)
        if (!files.length) return
        e.preventDefault()
        void ingest(files)
      }}
    >
      <div className="tx-measure">
        {open && (
          <div className="slash-menu" ref={listRef}>
            <div className="slash-head">
              {matches.length > results.length
                ? `${results.length} of ${matches.length} skills`
                : `${matches.length} skill${matches.length === 1 ? '' : 's'}`}
              <span className="slash-hint">↑↓ to move · tab or enter to insert · esc to dismiss</span>
            </div>
            {results.map((s, i) => (
              <button
                key={s.name}
                className={`slash-item ${i === active ? 'is-on' : ''}`}
                // mousedown fires before the textarea blurs, so focus is kept.
                onMouseDown={(e) => {
                  e.preventDefault()
                  accept(s)
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="slash-name">
                  /{s.name}
                  {s.argumentHint && <span className="slash-arg">{s.argumentHint}</span>}
                </span>
                <span className="slash-desc">{s.description}</span>
              </button>
            ))}
          </div>
        )}

        {/* Only ever one line, and only when something is actually wrong. It sits
            above the input because it is about the message you are about to
            send, not about the transcript behind it. */}
        {shownWarnings.map((w) => {
          // Index into the real array, so dismissing the right one still works
          // while the list is reversed for display.
          const i = warnings.lastIndexOf(w)
          return (
            <div key={`${i}-${w.text}`} className={`tx-warn is-${w.level}`}>
              {/* `title` matters: the strip is one line by design, and these
                  carry SDK and MCP error strings that would otherwise be
                  clipped with no way to read the rest. */}
              <span className="tx-warn-text" title={w.text}>
                {w.text}
              </span>
              {/* Only offered when there is somewhere to actually go. This used
                  to read "How to fix" on every notice and merely dismiss it. */}
              {w.fixHref && (
                <a className="tx-warn-fix" href={w.fixHref} target="_blank" rel="noreferrer">
                  How to fix
                </a>
              )}
              {hiddenWarnings > 0 && (
                <button className="tx-warn-more" onClick={() => setShowAllWarnings(true)}>
                  +{hiddenWarnings} more
                </button>
              )}
              <button
                className="tx-warn-x"
                onClick={() => {
                  onDismissWarning?.(i)
                  if (warnings.length <= 1) setShowAllWarnings(false)
                }}
                title="Dismiss"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          )
        })}

        {images.length > 0 && (
          <div className="attachments">
            {images.map((a) => (
              <div key={a.id} className="attachment">
                <img src={`data:${a.mediaType};base64,${a.data}`} alt={a.name} />
                <button
                  className="attachment-x"
                  onClick={() => setImages((prev) => prev.filter((x) => x.id !== a.id))}
                  title="Remove"
                >
                  ×
                </button>
                <span className="attachment-dim">
                  {a.width}×{a.height}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="tx-well">
          <textarea
            ref={taRef}
            value={value}
            placeholder={placeholder}
            onChange={(e) => {
              // Typing your own text drops you out of history, so the next Up
              // starts again from the most recent prompt and Down can restore
              // this draft. Recall calls the prop directly and never lands here.
              histIndex.current = null
              onChange(e.target.value)
              syncQuery(e.target)
            }}
            onKeyUp={(e) => syncQuery(e.currentTarget)}
            onClick={(e) => syncQuery(e.currentTarget)}
            onBlur={() => setQuery(null)}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const files = imageFilesFrom(e.clipboardData)
              if (!files.length) return
              // Keep the image, drop the OS-supplied filename text alongside it.
              e.preventDefault()
              void ingest(files)
            }}
            rows={3}
          />
          {/* The chips are the affordances, not a sentence about them: each one
              does the thing it names, so the old paragraph of instructions goes. */}
          <div className="tx-controls">
            <button
              className="tx-chip"
              onMouseDown={(e) => e.preventDefault()}
              onClick={openSkills}
              title="Insert / and list skills"
            >
              / skills
            </button>
            <button
              className="tx-chip"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert('@')}
              title="Insert @ to reference a file"
            >
              @ files
            </button>
            <button
              className="tx-chip"
              onMouseDown={(e) => e.preventDefault()}
              onClick={historyBack}
              disabled={!history.length}
              title="Recall an earlier prompt"
            >
              ↑ history
            </button>
            <div className="tx-controls-gap" />
            <span className="tx-keys">⏎ send · ⇧⏎ newline</span>
            <button
              className="pbtn"
              disabled={(!value.trim() && !images.length) || disabled || working}
              onClick={submit}
            >
              {working ? 'Working...' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
