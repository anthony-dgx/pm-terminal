import { useEffect, useRef, useState } from 'react'

export interface ThemeDef {
  id: string
  name: string
  note: string
  /** Swatch shown in the menu: background then accent. */
  swatch: [string, string]
}

export const THEMES: ThemeDef[] = [
  { id: 'default', name: 'Default', note: 'Neutral slate', swatch: ['#14151a', '#7aa2f7'] },
  { id: 'catppuccin', name: 'Catppuccin', note: 'Mocha, soft pastels', swatch: ['#1e1e2e', '#89b4fa'] },
  { id: 'cowboy', name: 'Cowboy', note: 'Leather and amber, with a horse', swatch: ['#17110d', '#e0913b'] },
]

export function ThemePicker({
  current,
  onChange,
}: {
  current: string
  onChange: (id: string) => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = THEMES.find((t) => t.id === current) ?? THEMES[0]

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

  return (
    <div className="model-picker" ref={ref}>
      <button className="theme-btn" onClick={() => setOpen((o) => !o)} title={`Theme: ${active.name}`}>
        <span className="theme-dot" style={{ background: active.swatch[1] }} />
      </button>
      {open && (
        <div className="model-menu">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`model-item ${current === t.id ? 'is-on' : ''}`}
              onClick={() => {
                onChange(t.id)
                setOpen(false)
              }}
            >
              <span className="model-item-name">
                <span className="theme-swatch">
                  <i style={{ background: t.swatch[0] }} />
                  <i style={{ background: t.swatch[1] }} />
                </span>
                {t.name}
                {current === t.id && <span className="model-check">✓</span>}
              </span>
              <span className="model-item-desc">{t.note}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
