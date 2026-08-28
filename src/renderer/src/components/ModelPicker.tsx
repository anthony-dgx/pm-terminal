import { Fragment, useEffect, useRef, useState } from 'react'
import type { ModelOption } from '../../../shared/types.js'
import { gatewayModelName, isGatewayModel } from '../../../shared/gateway.js'
import { desk } from '../lib/api.js'

interface Props {
  clientId: string
  current: string | null
  /** Models are only listable from a running session; falls back to aliases. */
  live: boolean
  onChange: (model: string) => void
}

/**
 * Aliases always work, even before a session exists to ask for the real list.
 * The SDK resolves them to whatever the current model generation is.
 */
const FALLBACK: ModelOption[] = [
  { value: 'opus', displayName: 'Opus', description: 'Most capable' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Balanced' },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest' },
]

/**
 * The short label on the button. Anchored to the three Claude families on
 * purpose: an unanchored `claude-([a-z]+)` renders `claude-deepseek-v4-flash` as
 * "deepseek", and worse, collapses every gateway model whose name starts the
 * same way onto one label, which then makes two rows tick as current.
 */
function short(model: string | null): string {
  if (!model) return 'model'
  const gateway = gatewayModelName(model)
  if (gateway) return gateway
  // claude-sonnet-5 -> sonnet, claude-opus-5[1m] -> opus
  const m = model.match(/^claude-(opus|sonnet|haiku)/)
  return m ? m[1] : model
}

export function ModelPicker({ clientId, current, live, onChange }: Props): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<ModelOption[]>([])
  const [loading, setLoading] = useState(false)
  const [gatewayReady, setGatewayReady] = useState(true)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    void Promise.all([desk.models(clientId), desk.gatewayInstalled()]).then(([m, installed]) => {
      setModels(m.length ? m : FALLBACK)
      setGatewayReady(installed)
      setLoading(false)
    })
  }, [open, live, clientId])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const list = models.length ? models : FALLBACK

  return (
    <div className="model-picker" ref={ref}>
      <button className="model-btn" onClick={() => setOpen((o) => !o)} title={`Change model (${short(current)})`}>
        {/* Wrapped so it can ellipsise rather than wrap. See ProfilePicker. */}
        <span className="model-label">{short(current)}</span>
        <span className="model-caret">▾</span>
      </button>

      {open && (
        <div className="model-menu model-menu-scroll">
          {loading && <div className="model-loading">Loading models...</div>}
          {!loading && !live && (
            <div className="model-loading">
              No session yet, so these are aliases. The next session starts on your pick.
            </div>
          )}
          {!loading && !gatewayReady && (
            <div className="model-loading">
              Datadog AI Gateway models need its proxy installed. Only Claude models are listed.
            </div>
          )}
          {list.map((m, i) => {
            const isCurrent = current === m.value || short(current) === short(m.value)
            // One header above the first gateway row. Both lists arrive already
            // grouped, natives first, so a boundary test is enough.
            const startsGateway = isGatewayModel(m.value) && !isGatewayModel(list[i - 1]?.value)
            return (
              // A Fragment, not a wrapper element: `position: sticky` on the
              // group header is bounded by its parent, so inside a wrapper it
              // would scroll away with its own row instead of holding.
              <Fragment key={m.value}>
                {startsGateway && <div className="model-group">Datadog AI Gateway</div>}
                <button
                  className={`model-item ${isCurrent ? 'is-on' : ''}`}
                  onClick={() => {
                    onChange(m.value)
                    setOpen(false)
                  }}
                >
                  <span className="model-item-name">
                    {m.displayName}
                    {isCurrent && <span className="model-check">✓</span>}
                  </span>
                  <span className="model-item-desc">{m.description}</span>
                </button>
              </Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}
