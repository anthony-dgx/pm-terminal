import { useEffect, useRef } from 'react'
import type { PermissionAnswer, PermissionRequest } from '../../../shared/types.js'
import { CopyButton } from './Copy.js'

interface Props {
  request: PermissionRequest
  onAnswer: (answer: PermissionAnswer) => void
}

/** Pull the most decision-relevant field out of the tool input for display. */
function subject(request: PermissionRequest): string {
  const i = request.input
  const v =
    (i.command as string) ?? (i.file_path as string) ?? (i.path as string) ?? (i.url as string) ?? ''
  return String(v)
}

export function PermissionPrompt({ request, onAnswer }: Props): React.ReactElement {
  const allowRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    allowRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onAnswer({ behavior: 'deny' })
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onAnswer({ behavior: 'allow' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onAnswer])

  const text = subject(request)

  return (
    <div className="perm">
      <div className="perm-head">
        <span className="perm-icon">!</span>
        <span className="perm-title">{request.title ?? `Allow ${request.toolName}?`}</span>
        <CopyButton text={() => JSON.stringify(request.input, null, 2)} label="Copy input" />
      </div>

      {text && <pre className="perm-subject">{text}</pre>}
      {request.decisionReason && <p className="perm-reason">{request.decisionReason}</p>}
      {request.blockedPath && (
        <p className="perm-reason">
          Outside allowed directories: <code>{request.blockedPath}</code>
        </p>
      )}

      <div className="perm-actions">
        <button ref={allowRef} className="btn btn-allow" onClick={() => onAnswer({ behavior: 'allow' })}>
          Allow <kbd>⌘↵</kbd>
        </button>
        {request.hasSuggestions && (
          <button className="btn" onClick={() => onAnswer({ behavior: 'allow', remember: true })}>
            Always allow
          </button>
        )}
        <button className="btn btn-deny" onClick={() => onAnswer({ behavior: 'deny' })}>
          Deny <kbd>esc</kbd>
        </button>
        <button
          className="btn btn-deny"
          onClick={() => onAnswer({ behavior: 'deny', message: 'Denied and interrupted.', interrupt: true })}
        >
          Deny and stop
        </button>
      </div>
    </div>
  )
}
