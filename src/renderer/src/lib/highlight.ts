/**
 * Highlighting a quoted span inside rendered markdown.
 *
 * Two things make the naive version fail on a real document:
 *
 * 1. `**Status:** Under review` renders as `<strong>Status:</strong> Under
 *    review` - two text nodes. Looking for the whole quote inside one node
 *    finds nothing, and a brief is mostly bold labels.
 * 2. A selection is stored with its whitespace collapsed, but the DOM keeps the
 *    source's newlines. So even a single-node quote misses whenever the
 *    paragraph was soft-wrapped.
 * 3. The quote comes from `Selection.toString()`, which puts a line break
 *    between block elements even when there is no whitespace in the markup. Two
 *    adjacent `<li>`s give "first second", while walking raw text nodes gives
 *    "firstsecond". Without a synthetic boundary, no list, table or code block
 *    can ever be highlighted.
 *
 * So: search in collapsed space, keep a map from each collapsed character back
 * to the node and offset it came from, then wrap each node's slice separately.
 * One `<mark>` per node, all sharing the comment id.
 */

interface Slot {
  node: Text
  offset: number
}

interface NodeRange {
  node: Text
  start: number
  end: number
}

/** Where a rendered line break falls, matching what a selection reports. */
const BLOCK = 'p,div,li,pre,tr,td,th,blockquote,h1,h2,h3,h4,h5,h6,figcaption,summary'

function collapse(root: HTMLElement): { norm: string; map: Slot[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let norm = ''
  const map: Slot[] = []
  // Starts true so leading whitespace collapses away entirely.
  let pendingSpace = true
  let lastBlock: Element | null = null

  let node = walker.nextNode() as Text | null
  while (node) {
    // Crossing into a different block reads as a line break to a selection, so
    // it has to read as whitespace here too. The slot points at the first
    // character of the new node, which is where the break sits; a quote is
    // trimmed, so it can never begin or end on this synthetic space.
    const block = node.parentElement?.closest(BLOCK) ?? null
    if (lastBlock && block !== lastBlock && norm && !norm.endsWith(' ')) {
      norm += ' '
      map.push({ node, offset: 0 })
      pendingSpace = true
    }
    lastBlock = block

    const value = node.nodeValue ?? ''
    for (let i = 0; i < value.length; i++) {
      const isSpace = /\s/.test(value[i])
      if (isSpace) {
        if (pendingSpace) continue
        pendingSpace = true
      } else {
        pendingSpace = false
      }
      norm += isSpace ? ' ' : value[i]
      map.push({ node, offset: i })
    }
    node = walker.nextNode() as Text | null
  }

  return { norm, map }
}

/**
 * Wrap the first occurrence of `quote` inside `block`.
 *
 * Returns false when the quote is not there at all, which is the honest
 * outcome for a stale anchor - the caller leaves the comment in the rail
 * without a highlight rather than marking the wrong text.
 */
export function markQuote(block: HTMLElement, quote: string, commentId: string): boolean {
  if (!quote) return false
  const { norm, map } = collapse(block)
  const at = norm.indexOf(quote)
  if (at === -1) return false

  // Group the covered characters by the node they live in. A node's characters
  // are always contiguous in the map, so this yields at most one range each.
  const ranges: NodeRange[] = []
  for (const slot of map.slice(at, at + quote.length)) {
    const last = ranges[ranges.length - 1]
    if (last && last.node === slot.node) last.end = slot.offset + 1
    else ranges.push({ node: slot.node, start: slot.offset, end: slot.offset + 1 })
  }
  if (!ranges.length) return false

  // Back to front: wrapping splits a text node, which would invalidate the
  // offsets of any range still waiting after it.
  for (let i = ranges.length - 1; i >= 0; i--) {
    const { node, start, end } = ranges[i]
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    const mark = document.createElement('mark')
    mark.className = 'rc-mark'
    mark.dataset.commentId = commentId
    try {
      // Each range sits inside a single text node, so this cannot straddle an
      // element boundary - which is what makes surroundContents safe here.
      range.surroundContents(mark)
    } catch {
      return false
    }
  }
  return true
}

/** Undo every highlight, so the next pass starts from clean text. */
export function clearMarks(root: HTMLElement): void {
  root.querySelectorAll('mark.rc-mark').forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark)
    parent.normalize()
  })
}
