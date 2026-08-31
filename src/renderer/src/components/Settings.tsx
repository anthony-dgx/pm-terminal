import { useCallback, useEffect, useRef } from 'react'

/**
 * App settings. One page, opened with Cmd+, the way every other Mac app does it.
 *
 * Deliberately thin. The theme, the music player and the two panel toggles all
 * live where you use them - in the title bar, next to the thing they change -
 * and moving them here would make them harder to reach, not easier. What
 * belongs here is what has nowhere else to go: a setting about how the agent
 * behaves, which is not a property of any one conversation.
 */
export function Settings({
  autoMode,
  onAutoMode,
  onClose,
}: {
  autoMode: boolean
  onAutoMode: (on: boolean) => void
  onClose: () => void
}): React.ReactElement {
  const boxRef = useRef<HTMLDivElement>(null)

  // Focus the panel itself, not the switch: landing on the control means a
  // stray space bar toggles Auto-mode on the way in.
  useEffect(() => {
    boxRef.current?.focus()
  }, [])

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [onClose],
  )

  return (
    <div className="modal-backdrop is-top" onClick={onClose}>
      <div
        className="modal settings"
        ref={boxRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="modal-head">
          <h2>Settings</h2>
          <code>⌘,</code>
          <button className="modal-x" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        <div className="set-row">
          <label className="set-switch">
            <input
              type="checkbox"
              checked={autoMode}
              onChange={(e) => onAutoMode(e.target.checked)}
            />
            <span className="set-track" aria-hidden="true" />
            <span className="set-label">
              Auto-mode
              <span className="set-sub">
                Tool calls are accepted for you and reviewed by a second model instead of stopping
                on a prompt. Anything it will not vouch for still comes to you, and anything it
                refuses is reported above the composer. Applies to sessions already open.
              </span>
            </span>
          </label>
        </div>

        <div className="modal-actions">
          <p className="panel-hint">
            {autoMode
              ? 'On. Reviewed automatically - you will still be asked about the risky ones.'
              : 'Off. Every tool call waits for you.'}
          </p>
          <span className="keyhint">esc to close</span>
        </div>
      </div>
    </div>
  )
}
