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
  value: string
  onChange: (v: string) => void
  onSubmit: (images: Attachment[]) => void
  placeholder: string
  disabled: boolean
  /** Bumped when a session starts, so the live 150-skill list replaces the disk one. */
  skillsKey: number
  /** True while a reply is in flight. */
  working?: boolean
  /** Prompts already sent in this session, oldest first. */
  history: string[]
}

export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  skillsKey,
  working = false,
  history,
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

  useEffect(() => {
    void desk.skills().then(setSkills)
  }, [skillsKey])

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
        el.setSelectionRange(text.length, text.length)
      })
    },
    [onChange],
  )

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
      if (histIndex.current === null) {
        stashedDraft.current = el.value
        histIndex.current = history.length - 1
      } else if (histIndex.current > 0) {
        histIndex.current -= 1
      }
      recall(history[histIndex.current])
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

  return (
    <div
      className={`composer ${working ? 'is-working' : ''} ${dropping ? 'is-dropping' : ''}`}
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
      <div className="composer-actions">
        <span className="panel-hint">
          Enter to send, Shift+Enter for a newline, <code>/</code> for skills, <code>↑</code> for
          history, paste or drop images
        </span>
        <button
          className="btn btn-primary"
          disabled={(!value.trim() && !images.length) || disabled || working}
          onClick={submit}
        >
          {working ? 'Working...' : 'Send'}
        </button>
      </div>
    </div>
  )
}
