import { createContext, useContext } from 'react'
import { marked } from 'marked'

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
  /**
   * The file this document came from, when it came from one. Set only for a
   * document opened off disk, and it is what makes inline edits savable: with
   * no path there is nowhere to write, so the reader stays read-only.
   */
  path?: string
}

/** A batch that has already been sent. Kept for the whole conversation. */
export interface ReviewRound {
  at: string
  comments: ReviewComment[]
}

/** Opens the reader. Provided by App, called from deep inside the transcript. */
export type OpenReview = (title: string, snapshot: string, path?: string) => void

export const ReviewContext = createContext<OpenReview | null>(null)

export function useReview(): OpenReview | null {
  return useContext(ReviewContext)
}

/** A fenced block worth previewing: it holds a document, not code. */
export function isMarkdownLang(lang?: string): boolean {
  const l = (lang ?? '').trim().toLowerCase()
  return l === 'md' || l === 'markdown'
}

/** A path the reader can open: markdown, since that is all it renders. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path.trim())
}

/** Last path segment, for a window title. */
export function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/**
 * The part of an answer that is meant to be sent on, or null if the whole
 * answer is that part.
 *
 * Asking for a draft gets back the draft wrapped in Claude explaining it: "here
 * is a version you could send", then the text, then an offer to adjust the tone.
 * Only the middle is wanted, and pasting the rest into Slack is the thing this
 * is meant to stop.
 *
 * The discriminator is the fence, not the prose. Claude fences a deliverable it
 * expects you to take away, and trying instead to recognise the framing prose
 * around it would be an open-ended guess. Exactly one fenced block means the
 * fence is the deliverable; zero or several and there is nothing unambiguous to
 * narrow to, so the answer is copied whole as before.
 */
export function draftOf(answer: string): string | null {
  const tokens = marked.lexer(answer).filter((t) => t.type !== 'space')
  const fenced = tokens.filter((t) => t.type === 'code')
  if (fenced.length !== 1) return null
  // Nothing around the fence means the fence is already the whole answer, and a
  // second button copying the identical text would just be noise.
  if (tokens.length === 1) return null
  const body = 'text' in fenced[0] ? String(fenced[0].text).trim() : ''
  return body || null
}

/**
 * Whether an answer is a document, and so worth opening in the reader.
 *
 * Not "is it markdown": all prose is valid markdown, which is why the button
 * used to appear on every reply. The test is structural. A document has a
 * heading and several blocks under it; an answer to a question does not, however
 * long it runs.
 *
 * A lone fenced block is excluded on purpose even when it holds a document,
 * because that fence renders its own Review button and two buttons on one
 * answer would open the same text twice.
 */
export function looksLikeDocument(source: string): boolean {
  const tokens = marked.lexer(source).filter((t) => t.type !== 'space')
  if (tokens.length < 3) return false
  if (tokens.every((t) => t.type === 'code')) return false
  return tokens.some((t) => t.type === 'heading')
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

/**
 * A fence long enough to wrap this text without one of its own closing it.
 *
 * Three backticks is not safe for a document that contains a code block, and a
 * document that contains a four-backtick block is not hypothetical either -
 * that is what the agent's own replies look like.
 */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  return '`'.repeat(Math.max(4, longest + 1))
}

/** Every comment in one prompt, with the document they are about. */
export function composeReviewPrompt(comments: ReviewComment[], document: string): string {
  const n = comments.length
  const count = `${n} comment${n === 1 ? '' : 's'}`
  const fence = fenceFor(document)

  return [
    `I reviewed the document below and left ${count} on it. Rewrite it applying every one,`,
    `and give me the full updated markdown - not a diff, not a summary of what changed.`,
    // The document has to be in the message, not assumed to be in context. It
    // often is not: it may have been read off disk rather than written here, and
    // even when the agent did write it, I have since edited it by hand. Asking
    // it to rewrite "the document you wrote" then silently discards those edits.
    '',
    'This is the current version, which is the one to rewrite:',
    '',
    fence + 'markdown',
    document,
    fence,
    '',
    // Without this, the same request comes back three different ways: bare,
    // wrapped in prose, or fenced. The reply is parsed to swap the document in
    // place, so the delimiter has to be stated, not guessed.
    // The same fence the document is quoted in above. Asking for a fixed four
    // backticks would be wrong for a document that already contains a run that
    // long, and the reply would close early and come back truncated.
    `Reply with the document only, wrapped in a single ${fence}markdown fence (${fence.length} backticks, so any`,
    'code block inside it still works). Write nothing before or after the fence.',
    // The app has no dialog for the agent's question tool, so a turn that
    // reaches for it hangs with nothing to click - and this window has no
    // composer to rescue it from either.
    'If something is unclear, make your best call rather than asking - do not use your question tool.',
    '',
    numbered(comments),
  ].join('\n')
}
