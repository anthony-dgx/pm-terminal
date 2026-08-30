import { useState } from 'react'
import type { Block, Turn } from '../../../shared/types.js'
import { desk } from '../lib/api.js'
import { fmtCost, fmtTokens } from '../lib/sessionState.js'
import { CopyButton } from './Copy.js'
import { Markdown } from './Markdown.js'
import {
  ReviewContext,
  baseName,
  docTitle,
  draftOf,
  isMarkdownPath,
  looksLikeDocument,
  useReview,
} from '../review.js'

/** Compact one-line summary of a tool call, for the collapsed header. */
function toolSummary(name: string, input: Record<string, unknown>): string {
  const first =
    (input.command as string) ??
    (input.file_path as string) ??
    (input.pattern as string) ??
    (input.path as string) ??
    (input.query as string) ??
    (input.prompt as string) ??
    ''
  const text = String(first).replace(/\s+/g, ' ').trim()
  return text.length > 110 ? `${text.slice(0, 110)}...` : text
}

/**
 * The markdown file a tool call read, or null if it did not read one.
 *
 * Only `Read`, and only once it has come back. A file the agent failed to read
 * has nothing to show, and offering to open it would just fail again.
 */
function readMarkdownPath(block: Extract<Block, { kind: 'tool' }>): string | null {
  if (block.name !== 'Read' || block.result === undefined || block.isError) return null
  const path = typeof block.input.file_path === 'string' ? block.input.file_path : ''
  return path && isMarkdownPath(path) ? path : null
}

function ToolBlockView({ block }: { block: Extract<Block, { kind: 'tool' }> }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const result = block.result ?? ''
  const resultLines = result ? result.split('\n').length : 0
  const pending = block.result === undefined

  const openReview = useReview()
  const mdPath = readMarkdownPath(block)

  // Read from disk rather than lifted out of the tool result, which arrives
  // line-numbered and truncated. The file is the document; the tool output is a
  // rendering of part of it.
  const openFile = (path: string): void => {
    void desk
      .readMarkdown(path)
      .then((text) => openReview?.(docTitle(text, baseName(path)), text, path))
      .catch(() => setFailed(true))
  }

  return (
    <div className={`tool ${block.isError ? 'is-error' : ''} ${pending ? 'is-pending' : ''}`}>
      <div className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
        <span className="tool-name">{block.name}</span>
        <span className="tool-summary">{toolSummary(block.name, block.input)}</span>
        {/* Never opened for you. Claude reads markdown constantly and for its
            own reasons, so an automatic window would be mostly interruption. */}
        {openReview && mdPath && (
          <button
            className="tool-open"
            title={failed ? 'Could not read that file' : `Open ${baseName(mdPath)} in the reader`}
            onClick={(e) => {
              e.stopPropagation()
              openFile(mdPath)
            }}
          >
            {failed ? 'Unreadable' : 'Open'}
          </button>
        )}
        {pending ? (
          <span className="tool-status">running</span>
        ) : (
          <span className="tool-status">
            {resultLines > 0 ? `${resultLines} lines` : 'done'}
            {block.durationMs !== undefined ? ` · ${(block.durationMs / 1000).toFixed(1)}s` : ''}
          </span>
        )}
      </div>

      {open && (
        <div className="tool-body">
          <div className="tool-section-label">Input</div>
          <pre className="tool-pre">{JSON.stringify(block.input, null, 2)}</pre>
          {!pending && (
            <>
              <div className="tool-section-label">
                Output {block.isError ? <span className="err-tag">error</span> : null}
              </div>
              <pre className="tool-pre">{result || '(empty)'}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ImageBlockView({ block }: { block: Extract<Block, { kind: 'image' }> }): React.ReactElement {
  const [full, setFull] = useState(false)
  const src = `data:${block.mediaType};base64,${block.data}`
  return (
    <img
      className={`turn-image ${full ? 'is-full' : ''}`}
      src={src}
      alt="attached"
      onClick={() => setFull((f) => !f)}
      title={full ? 'Click to shrink' : 'Click to enlarge'}
    />
  )
}

/**
 * Reasoning, collapsed to a pill that sits in the flow of the reply.
 *
 * It reads as a footnote rather than a section: one line you can pop open, not
 * a panel you have to scroll past to reach the answer.
 */
function ThinkingView({ text }: { text: string }): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        className="tx-think"
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Hide the reasoning' : 'Show the reasoning'}
      >
        {open ? '▾' : '▸'} thought
      </button>
      {open && <pre className="tx-think-text">{text}</pre>}
    </>
  )
}

/**
 * Everything the agent did to get to the answer, folded behind one line.
 *
 * Tool calls used to sit inline and dominate the transcript. The answer is what
 * you are reading for, so the work is one click away instead.
 */
function Activity({ tools }: { tools: Extract<Block, { kind: 'tool' }>[] }): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  if (!tools.length) return null

  const running = tools.some((b) => b.result === undefined)
  const seconds = tools.reduce((sum, b) => sum + (b.durationMs ?? 0), 0) / 1000
  const names = [...new Set(tools.map((b) => b.name))]

  return (
    <div className={`tx-activity ${open ? 'is-open' : ''}`}>
      <button className="tx-activity-head" onClick={() => setOpen((o) => !o)}>
        <span className="tx-caret">{open ? '▾' : '▸'}</span>
        <span className="tx-activity-label">
          {tools.length} step{tools.length === 1 ? '' : 's'}
        </span>
        {!open && names.length > 0 && (
          <span className="tx-activity-names">{names.slice(0, 3).join(', ')}</span>
        )}
        {running ? (
          <span className="tx-activity-time is-running">running</span>
        ) : (
          seconds > 0 && <span className="tx-activity-time">{seconds.toFixed(1)}s</span>
        )}
      </button>

      {open && (
        <div className="tx-activity-body">
          {tools.map((b) => (
            <ToolBlockView key={b.id} block={b} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Just the answer, for the one copy button that matters. */
function answerText(turn: Turn, streamBuffer?: string): string {
  const text = turn.blocks
    .filter((b) => b.kind === 'text')
    .map((b) => (b.kind === 'text' ? b.text : ''))
    .join('\n\n')
    .trim()
  return text || (streamBuffer ?? '').trim()
}

/**
 * Per-turn figures, when the caller happens to know them.
 *
 * Every field is optional and every missing one is simply left out. Main tallies
 * tokens and cost per *session*, not per turn, so in practice only `durationMs`
 * arrives — measured by the host from the turn's own timestamp to the moment it
 * stopped streaming. A guessed `4.1K in` would read exactly like a real one,
 * which is worse than a shorter line.
 */
export interface TurnUsage {
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  /** Wall clock the turn took, measured by whoever watched it finish. */
  durationMs?: number
}

interface TurnViewProps {
  turn: Turn
  /** Live text for a turn that has not yet received its authoritative blocks. */
  streamBuffer?: string
  /**
   * What the turn cost. A `Turn` carries no token or dollar figures of its own,
   * only tool durations, so anything beyond wall-clock time has to be handed
   * down. Whatever is missing is left out rather than printed as a zero — a
   * confident `0.0K in · $0.00` is worse than no line at all.
   */
  usage?: TurnUsage
}

/** The footer figures, in the order the handoff prints them. Empty means silent. */
function usageParts(usage: TurnUsage | undefined, seconds: number | null): string[] {
  const parts: string[] = []
  if (usage?.inputTokens) parts.push(`${fmtTokens(usage.inputTokens)} in`)
  if (usage?.outputTokens) parts.push(`${fmtTokens(usage.outputTokens)} out`)
  if (usage?.costUsd) parts.push(fmtCost(usage.costUsd))
  if (seconds !== null) parts.push(`${seconds.toFixed(1)}s`)
  return parts
}

export function TurnView({ turn, streamBuffer, usage }: TurnViewProps): React.ReactElement {
  const isUser = turn.role === 'user'
  const tools = turn.blocks.filter((b) => b.kind === 'tool')
  const thoughts = turn.blocks.filter((b) => b.kind === 'thinking')
  const said = turn.blocks.filter((b) => b.kind === 'text' || b.kind === 'image')
  const answer = answerText(turn, streamBuffer)
  // Not while streaming: a fence is not closed until it is closed, so a draft
  // detected mid-stream would be half a draft.
  const draft = turn.streaming ? null : draftOf(answer)
  const openReview = useReview()

  // The wall clock for the whole turn, which is a different number from the
  // Activity line's sum of tool durations: that one says how long the tools
  // took, this one how long you waited. Silent when nobody measured it — a turn
  // read back from history has no duration anyone observed.
  const footer = usageParts(usage, usage?.durationMs !== undefined ? usage.durationMs / 1000 : null)

  return (
    <div className={`tx-turn tx-turn-${turn.role}`}>
      {/* The gutter is the only thing naming the speaker: no avatar, no bubble.
          The transcript should read as a document, not as a chat log. */}
      <span className="tx-speaker">{isUser ? 'YOU' : 'CLAUDE'}</span>

      <div className="tx-content">
        {/* The work comes first because it happened first, but folded. */}
        {!isUser && thoughts.map((b, i) => <ThinkingView key={`t${i}`} text={b.text} />)}
        {!isUser && <Activity tools={tools} />}

        {/* No Review button while the turn is still running: a fenced block
            renders as soon as its opening fence arrives, so reviewing here
            would snapshot half a document. */}
        <ReviewContext.Provider value={turn.streaming ? null : openReview}>
          {said.map((b, i) =>
            b.kind === 'text' ? <Markdown key={i} source={b.text} /> : <ImageBlockView key={i} block={b} />,
          )}
          {streamBuffer && <Markdown source={streamBuffer} />}
        </ReviewContext.Provider>
        {turn.streaming && <span className="caret-blink" />}

        {/* Copy is scoped to the draft when there is one, because what you do
            with a draft is paste it somewhere else, and Claude's framing around
            it is not part of what you send. "Copy all" stays for the rest.

            The timing rides along on the right of this row rather than taking a
            line of its own: it is a footnote, and a one-line reply was three
            stacked rows tall before — text, timing, actions. */}
        {!isUser && (answer || footer.length > 0) && (
          <div className="tx-actions">
            {draft ? (
              <>
                <CopyButton text={() => draft} label="Copy draft" title="Copy just the drafted text" />
                <CopyButton
                  text={() => answer}
                  label="Copy all"
                  title="Copy the whole reply, framing included"
                  className="is-quiet"
                />
              </>
            ) : (
              // No answer text means this row exists only to carry the timing.
              answer && <CopyButton text={() => answer} label="Copy answer" />
            )}
            {/* Only on a document. On an ordinary reply there is nothing to
                review, and the button used to be on every single one. */}
            {openReview && !turn.streaming && looksLikeDocument(answer) && (
              <button
                className="msg-action"
                onClick={() => openReview(docTitle(answer, 'Answer'), answer)}
              >
                Review
              </button>
            )}
            {footer.length > 0 && <span className="tx-usage">{footer.join(' · ')}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
