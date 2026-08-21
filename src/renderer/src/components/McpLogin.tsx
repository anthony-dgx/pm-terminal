import { useCallback, useEffect, useRef, useState } from 'react'
import type { McpLoginEvent } from '../../../shared/types.js'
import { desk } from '../lib/api.js'
import { CopyButton } from './Copy.js'

type Phase = 'confirm' | 'starting' | 'waiting' | 'done'

/**
 * Sign in to one MCP server.
 *
 * The main process runs `claude mcp login <name>` under a pty and streams what
 * it prints. Normally the browser finishes it: the CLI listens on its own
 * loopback callback and this dialog just reports progress. The paste box is the
 * fallback for when the redirect lands somewhere the callback cannot be reached.
 */
export function McpLogin({
  name,
  clientId,
  confirmFirst,
  onClose,
  onAuthenticated,
}: {
  name: string
  clientId: string
  /**
   * Ask before starting, for any server that might already hold a token. The CLI
   * revokes them as its first step, so an accidental click would sign it out.
   */
  confirmFirst: boolean
  /** Called on dismiss, whatever the outcome. */
  onClose: () => void
  /** Called after a successful sign-in, so the panel can refresh and reconnect. */
  onAuthenticated: () => void
}): React.ReactElement {
  const [phase, setPhase] = useState<Phase>(confirmFirst ? 'confirm' : 'starting')
  const [url, setUrl] = useState<string | null>(null)
  const [log, setLog] = useState('')
  const [canPaste, setCanPaste] = useState(false)
  const [pasted, setPasted] = useState('')
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const logRef = useRef<HTMLPreElement>(null)

  // Held in a ref so the effect below depends only on which server is being
  // signed in. A new callback identity from the parent re-running must not
  // restart the flow - that would revoke the tokens a second time.
  const authedRef = useRef(onAuthenticated)
  authedRef.current = onAuthenticated

  // Subscribe always, but only spawn once the flow is actually wanted. On a
  // connected server that is after the user confirms, so opening the dialog and
  // backing out cannot revoke anything.
  const [armed, setArmed] = useState(!confirmFirst)

  useEffect(() => {
    if (!armed) return
    const off = desk.onMcpLogin((e: McpLoginEvent) => {
      // A dialog for a different server should not react. Only one flow runs at
      // a time, but the window can outlive a cancelled one.
      if (e.name !== name) return
      if (e.kind === 'output') setLog((l) => l + e.text)
      if (e.kind === 'url') setUrl(e.url)
      if (e.kind === 'waiting') setPhase('waiting')
      if (e.kind === 'paste-ready') setCanPaste(true)
      if (e.kind === 'done') {
        setPhase('done')
        setResult({ ok: e.ok, message: e.message })
        if (e.ok) authedRef.current()
      }
    })

    desk.mcpLogin(clientId, name).catch((err: unknown) => {
      setPhase('done')
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    })

    return off
  }, [name, clientId, armed])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  const cancel = useCallback(() => {
    // Nothing was ever spawned while unarmed, so there is nothing to cancel.
    if (armed && phase !== 'done') void desk.mcpLoginCancel(name)
    onClose()
  }, [armed, phase, name, onClose])

  const start = useCallback(() => {
    setPhase('starting')
    setArmed(true)
  }, [])

  const submitPasted = (): void => {
    const text = pasted.trim()
    if (!text) return
    void desk.mcpLoginInput(name, text)
    setPasted('')
  }

  return (
    <div className="modal-backdrop" onClick={cancel}>
      <div className="modal mcp-login" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>
            Sign in to <code>{name}</code>
          </h2>
          <button className="modal-x" onClick={cancel} title="Close">
            ×
          </button>
        </div>

        {phase === 'confirm' && (
          <div className="warn-box">
            This server may already be signed in. Signing in again clears whatever tokens it holds
            before it starts, so if you do not finish the browser step it will be left signed out.
          </div>
        )}

        {(phase === 'starting' || phase === 'waiting') && (
          <p className="panel-hint">
            {phase === 'starting'
              ? 'Starting the sign-in...'
              : 'Authorize in the browser tab that just opened. This finishes on its own.'}
          </p>
        )}

        {url && (
          <div className="mcp-login-url">
            <div className="kv">
              <span>authorize</span>
              <code title={url}>{url}</code>
              <CopyButton text={url} />
            </div>
            <button className="btn btn-sm" onClick={() => void desk.openExternal(url)}>
              Open in browser
            </button>
          </div>
        )}

        {result && (
          <div className={result.ok ? 'ok-box' : 'err-box'}>{result.message}</div>
        )}

        {log.trim() && (
          <pre className="mcp-login-log" ref={logRef}>
            {log.trim()}
          </pre>
        )}

        {canPaste && phase !== 'done' && (
          <div className="mcp-login-paste">
            <p className="panel-hint">
              If the browser did not come back on its own, paste the URL it ended on.
            </p>
            <div className="row">
              <input
                className="filter"
                placeholder="http://localhost:3118/callback?code=..."
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submitPasted()
                  }
                }}
              />
              <button className="btn btn-sm" disabled={!pasted.trim()} onClick={submitPasted}>
                Submit
              </button>
            </div>
          </div>
        )}

        <div className="modal-actions">
          {phase === 'confirm' ? (
            <>
              <span className="panel-hint" />
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={start}>
                Sign in anyway
              </button>
            </>
          ) : phase === 'done' ? (
            <button className="btn btn-primary" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <span className="panel-hint">
                Cancelling leaves the server signed out: the CLI clears its old tokens before it
                starts.
              </span>
              <button className="btn" onClick={cancel}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
