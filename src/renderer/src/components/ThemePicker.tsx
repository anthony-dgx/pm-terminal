import { useEffect, useRef, useState } from 'react'

export interface ThemeDef {
  id: string
  name: string
  note: string
  /** Swatch shown in the menu: background then accent. */
  swatch: [string, string]
  /** If set, this entry expands into a submenu instead of selecting directly. */
  flavors?: ThemeDef[]
}

export const THEMES: ThemeDef[] = [
  { id: 'default', name: 'Default', note: 'Neutral slate', swatch: ['#14151a', '#7aa2f7'] },
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    note: 'Pick a flavor',
    swatch: ['#1e1e2e', '#89b4fa'],
    flavors: [
      { id: 'catppuccin-latte', name: 'Latte', note: 'Light, warm pastels', swatch: ['#eff1f5', '#1e66f5'] },
      { id: 'catppuccin-frappe', name: 'Frappé', note: 'Muted, cool dark', swatch: ['#303446', '#8caaee'] },
      { id: 'catppuccin-macchiato', name: 'Macchiato', note: 'Balanced dark', swatch: ['#24273a', '#8aadf4'] },
      { id: 'catppuccin-mocha', name: 'Mocha', note: 'Darkest, soft pastels', swatch: ['#1e1e2e', '#89b4fa'] },
    ],
  },
  {
    id: 'cowboy',
    name: 'Cowboy',
    note: 'Pick a flavor',
    swatch: ['#17110d', '#e0913b'],
    flavors: [
      { id: 'cowboy-sundown', name: 'Sundown', note: 'Leather and amber, with a horse', swatch: ['#17110d', '#e0913b'] },
      { id: 'cowboy-high-noon', name: 'High Noon', note: 'Desert daylight, turquoise and terracotta', swatch: ['#211a13', '#3fa9a0'] },
      { id: 'cowboy-saloon-night', name: 'Saloon Night', note: 'Dark wood, brass, and poker felt', swatch: ['#150f0c', '#b8863b'] },
      { id: 'cowboy-prairie-dusk', name: 'Prairie Dusk', note: 'Sunset over the plains, cooler twilight', swatch: ['#1a1620', '#d97a5a'] },
    ],
  },
  { id: 'dracula', name: 'Dracula', note: 'Dark, with a lively purple accent', swatch: ['#282a36', '#bd93f9'] },
]

function findTheme(id: string): ThemeDef | undefined {
  for (const t of THEMES) {
    if (t.id === id) return t
    const flavor = t.flavors?.find((f) => f.id === id)
    if (flavor) return flavor
  }
  return undefined
}

export function ThemePicker({
  current,
  onChange,
}: {
  current: string
  onChange: (id: string) => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [subOpen, setSubOpen] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const active = findTheme(current) ?? THEMES[0]

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

  useEffect(() => {
    if (!open) setSubOpen(null)
  }, [open])

  return (
    <div className="model-picker" ref={ref}>
      <button className="theme-btn" onClick={() => setOpen((o) => !o)} title={`Theme: ${active.name}`}>
        <span className="theme-dot" style={{ background: active.swatch[1] }} />
      </button>
      {open && (
        <div className="model-menu model-menu-left">
          {THEMES.map((t) => {
            const isActiveGroup = t.flavors ? t.flavors.some((f) => f.id === current) : current === t.id
            return (
              <div key={t.id} className="theme-row" onMouseEnter={() => t.flavors && setSubOpen(t.id)}>
                <button
                  className={`model-item ${isActiveGroup ? 'is-on' : ''}`}
                  onClick={() => {
                    if (t.flavors) {
                      setSubOpen((o) => (o === t.id ? null : t.id))
                    } else {
                      onChange(t.id)
                      setOpen(false)
                    }
                  }}
                >
                  <span className="model-item-name">
                    <span className="theme-swatch">
                      <i style={{ background: t.swatch[0] }} />
                      <i style={{ background: t.swatch[1] }} />
                    </span>
                    {t.name}
                    {t.flavors ? (
                      <span className="theme-caret">›</span>
                    ) : (
                      isActiveGroup && <span className="model-check">✓</span>
                    )}
                  </span>
                  <span className="model-item-desc">{t.note}</span>
                </button>
                {t.flavors && subOpen === t.id && (
                  <div className="model-menu theme-submenu">
                    {t.flavors.map((f) => (
                      <button
                        key={f.id}
                        className={`model-item ${current === f.id ? 'is-on' : ''}`}
                        onClick={() => {
                          onChange(f.id)
                          setOpen(false)
                          setSubOpen(null)
                        }}
                      >
                        <span className="model-item-name">
                          <span className="theme-swatch">
                            <i style={{ background: f.swatch[0] }} />
                            <i style={{ background: f.swatch[1] }} />
                          </span>
                          {f.name}
                          {current === f.id && <span className="model-check">✓</span>}
                        </span>
                        <span className="model-item-desc">{f.note}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
