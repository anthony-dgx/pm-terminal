import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateProgress, UpdateStatus } from '../../../shared/types.js'
import { desk } from '../lib/api.js'

/**
 * A line at the foot of the side panel saying whether the app is current.
 *
 * There is no release feed behind this. It compares the commit the running
 * bundle was built from against `origin/main` in the clone it was built in, so
 * "behind" means "your clone's main has moved on", which for this app is the
 * same thing.
 */
export function UpdateRow({ busy }: { busy: number }): React.ReactElement | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Two lines, not one: the step is what is happening, the tail is the build
  // talking. Folding them into one state made every npm line erase the step.
  const [step, setStep] = useState<{ text: string; error: boolean } | null>(null)
  const [tail, setTail] = useState('')
  const [running, setRunning] = useState(false)
  const started = useRef(false)

  useEffect(
    () =>
      desk.onUpdateProgress((p: UpdateProgress) => {
        if (p.type === 'output') setTail(p.text)
        else if (p.type === 'step') setStep({ text: p.text, error: false })
        else setStep({ text: p.text, error: !p.ok })
      }),
    [],
  )

  useEffect(() => {
    if (started.current) return
    started.current = true
    // Sequential, not concurrent. Fired together, the cached read can land
    // *after* the check and overwrite a fresh answer with a stale one - which
    // it does whenever the check returns without touching the network, meaning
    // most launches. Paint the cached one, then let the check replace it.
    void (async () => {
      setStatus(await desk.updateStatus())
      setStatus(await desk.updateCheck(false))
    })()
  }, [])

  const check = useCallback(() => {
    setChecking(true)
    void desk
      .updateCheck(true)
      .then(setStatus)
      .finally(() => setChecking(false))
  }, [])

  const apply = useCallback(() => {
    setConfirming(false)
    setRunning(true)
    setTail('')
    setStep({ text: 'Starting...', error: false })
    // The app quits itself on success, so there is no resolved branch to
    // handle. A rejection means nothing was touched.
    void desk.updateApply().catch(() => setRunning(false))
  }, [])

  if (!status) return null

  const label =
    status.state === 'behind'
      ? `${status.behind} commit${status.behind === 1 ? '' : 's'} behind`
      : status.state === 'current'
        ? 'Up to date'
        : status.state === 'dirty-build'
          ? 'Built from local changes'
          : 'Version unknown'

  return (
    <div className={`upd ${status.state === 'behind' ? 'is-behind' : ''}`}>
      <div className="upd-line">
        <span className="upd-label">{label}</span>
        <span className="upd-commit" title={`Built ${status.builtAt}\nFrom ${status.repo}`}>
          {status.commit || '?'}
        </span>
        {!running && (
          <button className="upd-check" onClick={check} disabled={checking} title="Check for updates">
            {checking ? '…' : '↻'}
          </button>
        )}
        {!running && status.state === 'behind' && status.canUpdate && (
          <button className="upd-go" onClick={() => setConfirming(true)}>
            Update
          </button>
        )}
      </div>

      {status.detail && !running && <div className="upd-detail">{status.detail}</div>}

      {confirming && (
        <div className="upd-confirm">
          {/* The bundle cannot be replaced while it is running, so this is a
              quit, not a background download. Anything mid-turn dies with it. */}
          <p>
            Updating rebuilds the app from {status.repo} and restarts it.
            {busy > 0 && (
              <>
                {' '}
                <strong>
                  {busy} session{busy === 1 ? ' is' : 's are'} still working and will be stopped.
                </strong>
              </>
            )}
          </p>
          <div className="upd-actions">
            <button className="upd-go" onClick={apply}>
              Update and restart
            </button>
            <button onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      )}

      {running && step && (
        <div className="upd-progress">
          <div className={`upd-step ${step.error ? 'is-error' : ''}`}>{step.text}</div>
          {tail && <pre className="upd-tail">{tail}</pre>}
        </div>
      )}
    </div>
  )
}
