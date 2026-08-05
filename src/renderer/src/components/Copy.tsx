import { useCallback, useState } from 'react'
import { desk } from '../lib/api.js'

interface CopyButtonProps {
  /** Called lazily so we never hold a second copy of large tool output in state. */
  text: string | (() => string)
  label?: string
  title?: string
  className?: string
}

/**
 * The core affordance of this app. Every copyable surface gets one, and the
 * copied payload is always the raw source, never the rendered DOM text.
 */
export function CopyButton({ text, label = 'Copy', title, className = '' }: CopyButtonProps): React.ReactElement {
  const [done, setDone] = useState(false)

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const value = typeof text === 'function' ? text() : text
      void desk.copy(value).then(() => {
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      })
    },
    [text],
  )

  return (
    <button className={`copy-btn ${done ? 'is-done' : ''} ${className}`} onClick={onClick} title={title ?? label}>
      {done ? 'Copied' : label}
    </button>
  )
}
