import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/**
 * Keep a dropdown inside the window.
 *
 * Every menu in the shell hangs off a trigger that sits in the titlebar's
 * right-hand cluster, so the naive placement (grow right, grow down) walks off
 * the edge of a narrow window. The theme picker was the worst case: its menu
 * grew right from the last control in the bar, and its flavor submenus grew
 * right again from there, so both were half off-screen.
 *
 * Rather than hard-coding a side per call site — which is what produced the
 * bug, since the "correct" side depends on where the window edge happens to be
 * — measure once on open and flip only when the preferred side does not fit.
 *
 * The measurement runs in a layout effect so the flip is applied before paint;
 * a menu that renders in the wrong place and jumps is worse than one that is
 * merely clipped.
 */

/** Breathing room to leave between a menu and the window edge. */
const MARGIN = 8

export interface MenuPlacement {
  /** Attach to the menu element itself. */
  ref: (el: HTMLDivElement | null) => void
  /** True when the preferred side overflowed and the menu was flipped. */
  flipX: boolean
  /** Set when the menu is taller than the space below it. */
  maxHeight: number | null
}

/**
 * @param open      Whether the menu is currently rendered.
 * @param preferred Which way the menu grows before any flip. `'right'` means
 *                  it is anchored left and extends rightwards (submenus);
 *                  `'left'` means anchored right, extending leftwards (the
 *                  top-level menus hanging off the titlebar).
 */
export function useMenuPlacement(
  open: boolean,
  preferred: 'left' | 'right' = 'left',
  /**
   * Whether to cap the height when the menu is taller than the space below it.
   *
   * Off by default, and it must stay off for any menu that hosts an absolutely
   * positioned submenu: a scroll container clips absolute descendants, which is
   * the bug commit 1ffee99 fixed by making `.model-menu-scroll` opt-in. Setting
   * max-height inline here would route around that and trap the flavor lists
   * inside their parent again.
   */
  capHeight = false,
): MenuPlacement {
  const [flipX, setFlipX] = useState(false)
  const [maxHeight, setMaxHeight] = useState<number | null>(null)
  const elRef = useRef<HTMLDivElement | null>(null)

  const measure = useCallback(() => {
    const el = elRef.current
    if (!el) return

    // Measure unflipped, so the decision is made against the real preferred
    // position rather than against last open's outcome — then put the class
    // straight back. Leaving the DOM un-flipped and waiting for `setFlipX` to
    // restore it is wrong: if the recomputed value equals current state React
    // bails out of the re-render, and the menu silently un-flips. That is
    // reachable on the resize listener below.
    const wasFlipped = el.classList.contains('is-flip-x')
    el.classList.remove('is-flip-x')
    const r = el.getBoundingClientRect()
    if (wasFlipped) el.classList.add('is-flip-x')
    const vw = window.innerWidth
    const vh = window.innerHeight

    const overflowsRight = r.right > vw - MARGIN
    const overflowsLeft = r.left < MARGIN

    // Only flip if the other side actually has more room. Flipping a menu that
    // is simply wider than the window just moves the clipping to the far edge.
    let next = false
    if (preferred === 'right' && overflowsRight) next = r.left - MARGIN >= r.width
    else if (preferred === 'left' && overflowsLeft) next = vw - MARGIN - r.right >= r.width
    setFlipX(next)

    const room = vh - r.top - MARGIN
    setMaxHeight(capHeight && r.height > room ? Math.max(160, room) : null)
  }, [preferred, capHeight])

  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      elRef.current = el
      if (el) measure()
    },
    [measure],
  )

  useLayoutEffect(() => {
    if (!open) {
      setFlipX(false)
      setMaxHeight(null)
      return
    }
    measure()
    // A resize while the menu is open can invalidate the choice either way.
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, measure])

  return { ref, flipX, maxHeight }
}
