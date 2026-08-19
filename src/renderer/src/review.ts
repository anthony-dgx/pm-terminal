import { createContext, useContext } from 'react'

/** One comment, anchored to a rendered block and to the text quoted inside it. */
export interface ReviewComment {
  id: string
  /** Index into the reader's filtered top-level token list. */
  blockIndex: number
  /** The text that was selected. Sent to the agent verbatim. */
  quote: string
  body: string
  at: string
}

/** The document currently open in the reader, plus its live comments. */
export interface ReviewDoc {
  title: string
  /**
   * The markdown as it was when the reader opened. Comments belong to this
   * exact string - the whole point of the feature is that the agent rewrites
   * the document, at which point every block index is meaningless.
   */
  snapshot: string
  comments: ReviewComment[]
}

/** A batch that has already been sent. Kept for the whole conversation. */
export interface ReviewRound {
  at: string
  comments: ReviewComment[]
}

/** Opens the reader. Provided by App, called from deep inside the transcript. */
export type OpenReview = (title: string, snapshot: string) => void

export const ReviewContext = createContext<OpenReview | null>(null)

export function useReview(): OpenReview | null {
  return useContext(ReviewContext)
}

/** A fenced block worth previewing: it holds a document, not code. */
export function isMarkdownLang(lang?: string): boolean {
  const l = (lang ?? '').trim().toLowerCase()
  return l === 'md' || l === 'markdown'
}

/** First heading, falling back to the first non-empty line, for the header. */
export function docTitle(source: string, fallback = 'Document'): string {
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    const text = heading ? heading[1] : line
    return text.length > 60 ? `${text.slice(0, 60)}...` : text
  }
  return fallback
}

/**
 * Not a markdown list on purpose. `1.` with an indented body parses as a loose
 * list item, and the sent message renders in the transcript with a blank line
 * inside every comment. Plain lines read the same to the agent and look right.
 */
function numbered(comments: ReviewComment[]): string {
  return comments
    .map((c, i) => `Comment ${i + 1}, on "${c.quote}":\n${c.body}`)
    .join('\n\n')
}

/** Every comment in one prompt. */
export function composeReviewPrompt(comments: ReviewComment[]): string {
  const n = comments.length
  const count = `${n} comment${n === 1 ? '' : 's'}`

  return [
    `I reviewed the document you wrote and left ${count} on it. Rewrite it applying every one,`,
    `and give me the full updated markdown - not a diff, not a summary of what changed.`,
    // Without this, the same request comes back three different ways: bare,
    // wrapped in prose, or fenced. The reply is parsed to swap the document in
    // place, so the delimiter has to be stated, not guessed.
    'Reply with the document only, wrapped in a single ````markdown fence (four backticks, so any',
    'code block inside it still works). Write nothing before or after the fence.',
    // The app has no dialog for the agent's question tool, so a turn that
    // reaches for it hangs with nothing to click - and this window has no
    // composer to rescue it from either.
    'If something is unclear, make your best call rather than asking - do not use your question tool.',
    '',
    numbered(comments),
  ].join('\n')
}
