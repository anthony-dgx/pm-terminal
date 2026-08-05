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
        <span className="tool-actions" onClick={(e) => e.stopPropagation()}>
          <CopyButton text={() => JSON.stringify(block.input, null, 2)} label="Input" title="Copy tool input JSON" />
          {!pending && (
            /* Copies the full result even when the view is collapsed or the
               terminal would have truncated it. */
            <CopyButton text={() => result} label="Output" title="Copy full tool output" />
          )}
        </span>
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
        <span className="tool-actions" onClick={(e) => e.stopPropagation()}>
          <CopyButton text={text} />
        </span>
      </div>
      {open && <pre className="tool-pre thinking-pre">{text}</pre>}
    </div>
  )
}

/** Whole-turn markdown, for pasting a full reply into Slack or Confluence. */
function turnToMarkdown(turn: Turn, streamBuffer?: string): string {
  const parts: string[] = []
  for (const b of turn.blocks) {
    if (b.kind === 'text') parts.push(b.text)
    else if (b.kind === 'image') parts.push('[image]')
    else if (b.kind === 'thinking') continue
    else if (b.kind === 'tool') parts.push(`\`${b.name}\`: ${toolSummary(b.name, b.input)}`)
  }
  if (!turn.blocks.length && streamBuffer) parts.push(streamBuffer)
  return parts.join('\n\n').trim()
}

interface TurnViewProps {
  turn: Turn
  /** Live text for a turn that has not yet received its authoritative blocks. */
  streamBuffer?: string
}

export function TurnView({ turn, streamBuffer }: TurnViewProps): React.ReactElement {
  const isUser = turn.role === 'user'

  return (
    <div className={`turn turn-${turn.role}`}>
      <div className="turn-gutter">
        <span className="turn-role">{isUser ? 'You' : 'Claude'}</span>
        <span className="turn-actions">
          <CopyButton
            text={() => turnToMarkdown(turn, streamBuffer)}
            label="Copy turn"
            title="Copy the whole turn as markdown"
          />
        </span>
      </div>

      <div className="turn-body">
        {turn.blocks.map((b, i) => {
          if (b.kind === 'text') return <Markdown key={i} source={b.text} />
          if (b.kind === 'thinking') return <ThinkingView key={i} text={b.text} />
          if (b.kind === 'image') return <ImageBlockView key={i} block={b} />
          return <ToolBlockView key={b.id} block={b} />
        })}
        {/* Text still streaming after the already-finalized blocks above. */}
        {streamBuffer && <Markdown source={streamBuffer} />}
        {turn.streaming && <span className="caret-blink" />}
      </div>
    </div>
  )
}
