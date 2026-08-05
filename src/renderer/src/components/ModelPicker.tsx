import { useEffect, useRef, useState } from 'react'
import type { ModelOption } from '../../../shared/types.js'
import { desk } from '../lib/api.js'

interface Props {
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

function short(model: string | null): string {
  if (!model) return 'model'
  // claude-sonnet-5 -> sonnet, claude-opus-5[1m] -> opus
  const m = model.match(/claude-([a-z]+)/)
  return m ? m[1] : model
}

export function ModelPicker({ current, live, onChange }: Props): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<ModelOption[]>([])
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    void desk.models().then((m) => {
      setModels(m.length ? m : FALLBACK)
      setLoading(false)
    })
  }, [open, live])

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
      <button className="model-btn" onClick={() => setOpen((o) => !o)} title="Change model">
        {short(current)}
        <span className="model-caret">▾</span>
      </button>

      {open && (
        <div className="model-menu">
          {loading && <div className="model-loading">Loading models...</div>}
          {!loading && !live && (
            <div className="model-loading">
              No session yet, so these are aliases. The next session starts on your pick.
            </div>
          )}
          {list.map((m) => {
            const isCurrent = current === m.value || short(current) === short(m.value)
            return (
              <button
                key={m.value}
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
            )
          })}
        </div>
      )}
    </div>
  )
}
