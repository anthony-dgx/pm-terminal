import { useEffect, useState } from 'react'
import type { Turn } from '../../../shared/types.js'

/**
 * What the agent is doing right now, in words.
 *
 * The gap between pressing enter and the first token can be several seconds
 * (spawning the CLI, connecting MCP servers, thinking, running a tool) and the
 * status chip in the titlebar is too small and too far away to notice.
 */
export function phaseOf(turns: Turn[], starting: boolean, streamingText: boolean): string {
  if (starting) return 'Starting session'

  // A tool block with no result yet is the thing currently taking the time.
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t.role !== 'assistant') continue
    const pending = t.blocks.find((b) => b.kind === 'tool' && b.result === undefined)
    if (pending && pending.kind === 'tool') return `Running ${pending.name}`
    break
  }

  return streamingText ? 'Writing' : 'Thinking'
}

interface Props {
  phase: string
  /** Epoch ms the current request started, for the elapsed counter. */
  since: number
  onStop: () => void
}

export function Thinking({ phase, since, onStop }: Props): React.ReactElement {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(t)
  }, [])

  const secs = Math.max(0, (now - since) / 1000)

  return (
    // One line on the reading measure, not a boxed banner: the agent working is
    // the normal case, so it announces itself the way every other status in the
    // shell does — a pulsing violet dot and mono text.
    <div className="tx-thinking" role="status" aria-live="polite">
      <span className="dot dot-running" aria-hidden="true" />
      <span className="tx-thinking-phase">{phase}</span>
      <span className="tx-thinking-elapsed">{secs < 10 ? secs.toFixed(1) : Math.round(secs)}s</span>
      <button className="obtn tx-thinking-stop" onClick={onStop}>
        Stop
      </button>
    </div>
  )
}
