import { useEffect, useRef, useState } from 'react'
import { useMenuPlacement } from '../lib/menuPlacement.js'

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
  { id: 'default', name: 'Default', note: 'Violet on near-black', swatch: ['#0e0b14', '#9c43fe'] },
  // The palette Atelier shipped with before the shell redesign. Kept as a
  // first-class choice so the new look is a change of default, not a loss.
  { id: 'classic', name: 'Classic', note: 'The original neutral slate', swatch: ['#14151a', '#7aa2f7'] },
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
      { id: 'cowboy-sheriffs-gold', name: "Sheriff's Gold", note: 'Charred leather and warm badge gold', swatch: ['#1c1714', '#e0a84e'] },
    ],
  },
  { id: 'dracula', name: 'Dracula', note: 'Dark, with a lively purple accent', swatch: ['#282a36', '#bd93f9'] },
  { id: 'zed-mono-slab', name: 'Zed Mono Slab', note: 'Warm slab brown, cream, muted accents', swatch: ['#191411', '#82a8c4'] },
  {
    id: 'base16',
    name: 'Base16',
    note: 'Pick a flavor',
    swatch: ['#181818', '#7CAFC2'],
    flavors: [
      { id: 'base16-default-dark', name: 'Dark', note: 'The original, dark', swatch: ['#181818', '#7CAFC2'] },
      { id: 'base16-default-light', name: 'Light', note: 'The original, light', swatch: ['#f8f8f8', '#547784'] },
      { id: 'base16-frontier-dark', name: 'Frontier Dark', note: 'Cowboy edition, dark', swatch: ['#15110f', '#6E91A8'] },
      { id: 'base16-frontier-light', name: 'Frontier Light', note: 'Cowboy edition, light', swatch: ['#f4e7ce', '#3c6c88'] },
    ],
  },
  {
    id: 'solarized',
    name: 'Solarized',
    note: 'Pick a flavor',
    swatch: ['#002b36', '#3794d6'],
    flavors: [
      { id: 'solarized-dark', name: 'Dark', note: 'The original, dark', swatch: ['#002b36', '#3794d6'] },
      { id: 'solarized-light', name: 'Light', note: 'The original, light', swatch: ['#fdf6e3', '#2075b0'] },
      { id: 'solarized-desert-dark', name: 'Desert Dark', note: 'Cowboy edition, dark', swatch: ['#14282a', '#5b93ad'] },
      { id: 'solarized-desert-light', name: 'Desert Light', note: 'Cowboy edition, light', swatch: ['#f3e8cd', '#347089'] },
    ],
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    note: 'Pick a flavor',
    swatch: ['#282828', '#63999b'],
    flavors: [
      { id: 'gruvbox-dark', name: 'Dark', note: 'The original, dark', swatch: ['#282828', '#63999b'] },
      { id: 'gruvbox-light', name: 'Light', note: 'The original, light', swatch: ['#fbf1c7', '#3d7578'] },
      { id: 'gruvbox-cattle-drive-dark', name: 'Cattle Drive Dark', note: 'Cowboy edition, dark', swatch: ['#211813', '#628992'] },
      { id: 'gruvbox-cattle-drive-light', name: 'Cattle Drive Light', note: 'Cowboy edition, light', swatch: ['#f6e6c5', '#3d6e78'] },
    ],
  },
  {
    id: 'nord',
    name: 'Nord',
    note: 'Pick a flavor',
    swatch: ['#2e3440', '#81A1C1'],
    flavors: [
      { id: 'nord-dark', name: 'Dark', note: 'The original, dark', swatch: ['#2e3440', '#81A1C1'] },
      { id: 'nord-light', name: 'Light', note: 'The original, light', swatch: ['#eceff4', '#4f6c90'] },
      { id: 'nord-prairie-night', name: 'Prairie Night', note: 'Cowboy edition, dark', swatch: ['#20262a', '#7491a5'] },
      { id: 'nord-prairie-day', name: 'Prairie Day', note: 'Cowboy edition, light', swatch: ['#ede8d9', '#4d6c81'] },
    ],
  },
  {
    // 'tokyo', not 'tokyo-night': the faithful dark flavor owns that id, and
    // findTheme matches group ids first, so sharing it would resolve the saved
    // theme to this group - which is a submenu, not something selectable.
    id: 'tokyo',
    name: 'Tokyo Night',
    note: 'Pick a flavor',
    swatch: ['#1a1b26', '#7AA2F7'],
    flavors: [
      { id: 'tokyo-night', name: 'Night', note: 'The original, dark', swatch: ['#1a1b26', '#7AA2F7'] },
      { id: 'tokyo-night-day', name: 'Day', note: 'The original, light', swatch: ['#e1e2e7', '#2462b6'] },
      { id: 'tokyo-night-neon-saloon', name: 'Neon Saloon', note: 'Cowboy edition, dark', swatch: ['#171722', '#728FC5'] },
      { id: 'tokyo-day-desert-neon', name: 'Desert Neon', note: 'Cowboy edition, light', swatch: ['#eee6d7', '#44679c'] },
    ],
  },
]

function findTheme(id: string): ThemeDef | undefined {
  for (const t of THEMES) {
    if (t.id === id) return t
    const flavor = t.flavors?.find((f) => f.id === id)
    if (flavor) return flavor
  }
  return undefined
}

/**
 * A theme group's flavors. Its own component so that each submenu measures
 * itself on mount: it is the innermost thing on screen and therefore the first
 * to run out of window.
 */
function Submenu({
  flavors,
  current,
  onPick,
}: {
  flavors: ThemeDef[]
  current: string
  onPick: (id: string) => void
}): React.ReactElement {
  // Submenus grow rightwards out of the parent menu, so 'right' is preferred
  // and the flip puts them on the parent's left instead. Capping the height is
  // safe here — a flavor list has no absolutely positioned children of its own.
  const placement = useMenuPlacement(true, 'right', true)
  return (
    <div
      className={`model-menu model-menu-wide theme-submenu ${placement.flipX ? 'is-flip-x' : ''}`}
      ref={placement.ref}
      style={placement.maxHeight ? { maxHeight: placement.maxHeight, overflowY: 'auto' } : undefined}
    >
      {flavors.map((f) => (
        <button
          key={f.id}
          className={`model-item ${current === f.id ? 'is-on' : ''}`}
          onClick={() => onPick(f.id)}
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
  )
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
  // The trigger is the last control in the titlebar, so the menu is anchored to
  // its right edge and grows left. It only flips if that runs out of window.
  const menu = useMenuPlacement(open, 'left')

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
        <div
          className={`model-menu model-menu-wide ${menu.flipX ? 'is-flip-x' : ''}`}
          ref={menu.ref}
          style={menu.maxHeight ? { maxHeight: menu.maxHeight, overflowY: 'auto' } : undefined}
        >
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
                  <Submenu
                    flavors={t.flavors}
                    current={current}
                    onPick={(id) => {
                      onChange(id)
                      setOpen(false)
                      setSubOpen(null)
                    }}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
