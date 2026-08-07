import { useState } from 'react'
import type { Block, Turn } from '../../../shared/types.js'
import { CopyButton } from './Copy.js'
import { Markdown } from './Markdown.js'

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

function ToolBlockView({ block }: { block: Extract<Block, { kind: 'tool' }> }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const result = block.result ?? ''
  const resultLines = result ? result.split('\n').length : 0
  const pending = block.result === undefined

  return (
    <div className={`tool ${block.isError ? 'is-error' : ''} ${pending ? 'is-pending' : ''}`}>
      <div className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
        <span className="tool-name">{block.name}</span>
        <span className="tool-summary">{toolSummary(block.name, block.input)}</span>
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

function ThinkingView({ text }: { text: string }): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking">
      <div className="thinking-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
        <span>Thinking</span>
      </div>
      {open && <pre className="tool-pre thinking-pre">{text}</pre>}
    </div>
  )
}

/**
 * Everything the agent did to get to the answer, folded behind one line.
 *
 * Tool calls and reasoning used to sit inline and dominate the transcript. The
 * answer is what you are reading for, so the work is one click away instead.
 */
function Activity({ blocks }: { blocks: Block[] }): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  const tools = blocks.filter((b) => b.kind === 'tool')
  if (!blocks.length) return null

  const running = tools.some((b) => b.kind === 'tool' && b.result === undefined)
  const seconds = tools.reduce((sum, b) => sum + (b.kind === 'tool' ? (b.durationMs ?? 0) : 0), 0) / 1000
  const names = [...new Set(tools.map((b) => (b.kind === 'tool' ? b.name : '')))].filter(Boolean)

  const label = tools.length
    ? `${tools.length} step${tools.length === 1 ? '' : 's'}`
    : 'Thought about it'

  return (
    <div className={`activity ${open ? 'is-open' : ''}`}>
      <button className="activity-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
        <span className="activity-label">{label}</span>
        {!open && names.length > 0 && <span className="activity-names">{names.slice(0, 3).join(', ')}</span>}
        {running ? (
          <span className="activity-time is-running">running</span>
        ) : (
          seconds > 0 && <span className="activity-time">{seconds.toFixed(1)}s</span>
        )}
      </button>

      {open && (
        <div className="activity-body">
          {blocks.map((b, i) =>
            b.kind === 'tool' ? (
              <ToolBlockView key={b.id} block={b} />
            ) : b.kind === 'thinking' ? (
              <ThinkingView key={i} text={b.text} />
            ) : null,
          )}
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

interface TurnViewProps {
  turn: Turn
  /** Live text for a turn that has not yet received its authoritative blocks. */
  streamBuffer?: string
}

export function TurnView({ turn, streamBuffer }: TurnViewProps): React.ReactElement {
  const isUser = turn.role === 'user'
  const work = turn.blocks.filter((b) => b.kind === 'tool' || b.kind === 'thinking')
  const said = turn.blocks.filter((b) => b.kind === 'text' || b.kind === 'image')
  const answer = answerText(turn, streamBuffer)

  return (
    <div className={`msg msg-${turn.role}`}>
      {!isUser && <div className="msg-avatar" aria-hidden="true">C</div>}

      <div className="msg-main">
        <div className="msg-who">{isUser ? 'You' : 'Claude'}</div>

        <div className="msg-bubble">
          {/* The work comes first because it happened first, but folded. */}
          {!isUser && <Activity blocks={work} />}

          {said.map((b, i) =>
            b.kind === 'text' ? <Markdown key={i} source={b.text} /> : <ImageBlockView key={i} block={b} />,
          )}
          {streamBuffer && <Markdown source={streamBuffer} />}
          {turn.streaming && <span className="caret-blink" />}
        </div>

        {/* One button, on the answer, which is the thing worth copying. */}
        {!isUser && answer && (
          <div className="msg-actions">
            <CopyButton text={() => answer} label="Copy answer" />
          </div>
        )}
      </div>

      {isUser && <div className="msg-avatar msg-avatar-you" aria-hidden="true">Y</div>}
    </div>
  )
}
