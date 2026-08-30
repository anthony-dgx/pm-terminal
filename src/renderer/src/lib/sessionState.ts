/*
 * One flat status object per session.
 *
 * The shell redesign asks every surface — session rows, the title bar counts,
 * the inspector — to answer the same question: what is this agent doing right
 * now, and does it want me? Before this, the answer was spread across three
 * places (`Conversation` in App, `HistoryEntry` in the Sidebar, `UsageView` in
 * the Inspector) and no single object could be handed to a row.
 *
 * `SessionVitals` is that object. App derives one per conversation and passes
 * the map down, so a row renders from data instead of re-deriving status from
 * four booleans.
 */

import type { PermissionRequest, SessionInfo, Turn } from '../../../shared/types.js'

/**
 * Four states, in priority order. The two that need a human sort above the two
 * that do not, everywhere they are listed.
 *
 *   needs_you — answered, or asked something, and nobody has looked
 *   running   — work in flight
 *   blocked   — stopped on something the agent cannot resolve alone
 *   done      — finished and read
 */
export type SessionState = 'needs_you' | 'running' | 'blocked' | 'done'

/** Sort key: attention first, then activity, then history. */
export const STATE_ORDER: Record<SessionState, number> = {
  needs_you: 0,
  blocked: 1,
  running: 2,
  done: 3,
}

export const STATE_LABEL: Record<SessionState, string> = {
  needs_you: 'WAITING ON YOU',
  blocked: 'BLOCKED',
  running: 'RUNNING',
  done: 'DONE',
}

/** How a live line should be colored. Amber only ever means "a human is needed". */
export type LineKind = 'attn' | 'tool' | 'done' | 'none'

export interface SessionVitals {
  /** Conversation id — the key events are filed under. */
  id: string
  sessionId: string | null
  state: SessionState
  title: string
  cwd: string
  /** What the agent is doing right now, one line, already trimmed. */
  lastLine: string
  lastLineKind: LineKind
  /** Epoch ms the session first started, 0 when it never has. */
  startedAt: number
  /** Human elapsed since `startedAt`: 'now', '4m', '2h'. */
  elapsed: string
  /** Real step counts only. Null when there is nothing truthful to show. */
  progress: { done: number; total: number } | null
  turns: number
  tokens: number
  cost: number
  contextUsed: number
  contextLimit: number
  model: string | null
  unread: boolean
}

/** The shape of a conversation this module needs. Structural, so App owns the real type. */
export interface VitalsSource {
  id: string
  sessionId: string | null
  entry: { sessionId: string; title: string; cwd: string; modifiedMs: number } | null
  started: boolean
  turns: Turn[]
  streamBuffers: Record<string, string>
  permissions: PermissionRequest[]
  info: SessionInfo | null
  awaiting: boolean
  awaitSince: number
  unread: boolean
  input: string
  cwd: string
  model: string | null
}

/** Per-session figures, fetched from main and cached in App. */
export interface VitalsUsage {
  tokens: number
  cost: number
  turns: number
  contextUsed: number
  contextLimit: number
}

export const EMPTY_USAGE: VitalsUsage = {
  tokens: 0,
  cost: 0,
  turns: 0,
  contextUsed: 0,
  contextLimit: 0,
}

/**
 * Which of the four states a conversation is in.
 *
 * Order matters. A session that is working is running even if an older answer
 * is still unread, because the live thing is the more useful thing to show;
 * but a permission prompt outranks that, since it is the one case where the
 * agent has stopped and is explicitly waiting on a person.
 */
export function deriveState(c: VitalsSource): SessionState {
  if (c.permissions.length > 0) return 'needs_you'
  if (c.info?.status === 'error') return 'blocked'
  if (c.awaiting) return 'running'
  if (c.unread) return 'needs_you'
  // An assistant turn that ended with a question is waiting on a reply just as
  // much as a permission prompt is, and is the single most common way a session
  // stalls without anyone noticing.
  //
  // Only for a session that is actually live, though. Merely opening a year-old
  // transcript that happens to close on a question mark is not someone waiting
  // on you: it used to jump the row into "Needs you" and inflate the titlebar
  // count the moment you clicked it.
  if (c.started && c.turns.length && endsWithQuestion(c.turns)) return 'needs_you'
  if (c.turns.length) return 'done'
  return 'done'
}

/** True when the last assistant turn ends on a question mark. */
function endsWithQuestion(turns: Turn[]): boolean {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t.role === 'user') return false
    if (t.role !== 'assistant' || t.streaming) continue
    const text = textOf(t).trimEnd()
    return text.endsWith('?')
  }
  return false
}

function textOf(t: Turn): string {
  return t.blocks
    .map((b) => (b.kind === 'text' ? b.text : ''))
    .join(' ')
    .trim()
}

/**
 * The one line a session row shows under its title.
 *
 * Preference order is what a person scanning the list actually wants: why it
 * stopped, then what it is doing, then how it ended.
 */
export function deriveLastLine(
  c: VitalsSource,
  state: SessionState,
): { text: string; kind: LineKind } {
  if (c.permissions.length > 0) {
    const p = c.permissions[0]
    return { text: `needs permission · ${p.title ?? 'tool use'}`, kind: 'attn' }
  }
  if (state === 'blocked') {
    return { text: c.info?.error ? firstLine(c.info.error) : 'blocked', kind: 'attn' }
  }

  const last = c.turns[c.turns.length - 1]

  if (state === 'running') {
    // A tool in flight is the most specific thing we can say.
    const tool = lastToolName(c.turns)
    if (tool) return { text: `› ${tool}`, kind: 'tool' }
    const streaming = Object.values(c.streamBuffers).some((v) => v.length > 0)
    return { text: streaming ? '› writing…' : '› thinking…', kind: 'tool' }
  }

  if (state === 'needs_you') {
    if (last?.role === 'assistant' && endsWithQuestion(c.turns)) {
      return { text: 'asked you a question', kind: 'attn' }
    }
    return { text: 'answer ready', kind: 'attn' }
  }

  if (last) {
    const text = textOf(last)
    if (text) return { text: `✓ ${firstLine(text)}`, kind: 'done' }
  }
  return { text: '', kind: 'none' }
}

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? ''
  const trimmed = line.trim()
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed
}

/** The most recent tool call, for the live line. */
function lastToolName(turns: Turn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const blocks = turns[i].blocks
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j]
      if (b.kind === 'tool') return b.name
    }
  }
  return null
}

/**
 * Step counts for the progress track, when the agent has actually reported
 * them. Returns null otherwise: the redesign removed the indeterminate crawl,
 * so a bar with nothing real behind it must not be drawn at all.
 */
export function deriveProgress(c: VitalsSource): { done: number; total: number } | null {
  if (!c.awaiting) return null
  for (let i = c.turns.length - 1; i >= 0; i--) {
    for (const b of c.turns[i].blocks) {
      if (b.kind !== 'text') continue
      // Matches 'step 3/11', '3 of 11', '[3/11]'.
      const m = b.text.match(/(?:step\s*)?\[?(\d{1,3})\s*(?:\/|of)\s*(\d{1,3})\]?/i)
      if (m) {
        const done = Number(m[1])
        const total = Number(m[2])
        if (total > 0 && done <= total) return { done, total }
      }
    }
  }
  return null
}

/** When this session first started, for the elapsed readout. */
export function deriveStartedAt(c: VitalsSource): number {
  const first = c.turns[0]
  if (first) {
    const t = Date.parse(first.at)
    if (!Number.isNaN(t)) return t
  }
  if (c.awaitSince) return c.awaitSince
  return c.entry?.modifiedMs ?? 0
}

/** 'now', '4m', '2h', '3d' — short enough for a 10px mono column. */
export function elapsedLabel(since: number, now: number = Date.now()): string {
  if (!since) return ''
  const secs = Math.max(0, Math.round((now - since) / 1000))
  if (secs < 45) return 'now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** 8200 -> '8.2K', 1240000 -> '1.24M'. Nothing below 10px, nothing over 5 chars. */
export function fmtTokens(n: number): string {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Always two decimals: a spend readout that changes width is hard to scan. */
export function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`
}

/**
 * What to call a session. History gives a saved one a real title; one started
 * here has none until it is saved, so fall back to what was actually asked.
 */
export function deriveTitle(c: VitalsSource): string {
  if (c.entry?.title) return c.entry.title
  for (const t of c.turns) {
    if (t.role !== 'user') continue
    const text = textOf(t)
    if (text) return clip(text)
  }
  const draft = c.input.trim()
  if (draft) return clip(draft)
  return 'New session'
}

function clip(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 80)}...` : flat
}

/** Build the full status object for one conversation. */
export function deriveVitals(c: VitalsSource, usage: VitalsUsage = EMPTY_USAGE): SessionVitals {
  const state = deriveState(c)
  const line = deriveLastLine(c, state)
  const startedAt = deriveStartedAt(c)
  return {
    id: c.id,
    sessionId: c.sessionId ?? c.entry?.sessionId ?? null,
    state,
    title: deriveTitle(c),
    cwd: c.cwd,
    lastLine: line.text,
    lastLineKind: line.kind,
    startedAt,
    elapsed: elapsedLabel(startedAt),
    progress: deriveProgress(c),
    turns: usage.turns || c.turns.filter((t) => t.role === 'user').length,
    tokens: usage.tokens,
    cost: usage.cost,
    contextUsed: usage.contextUsed,
    contextLimit: usage.contextLimit,
    model: c.model,
    unread: c.unread,
  }
}

/**
 * Everything a transcript said, flattened to one lower-cased haystack.
 *
 * Search has to reach transcript output — "finding things" is the stated pain
 * point, and a title-and-path search cannot answer "the session where the build
 * failed". Tool output is included because that is usually where the answer is,
 * but each result is clipped: a single `Read` of a large file would otherwise
 * dwarf the entire rest of the session and the string is only ever used for
 * `includes()`.
 *
 * `cap` bounds the whole session. Live conversations get a generous one; the
 * history scan uses a smaller one, because it holds one of these per recorded
 * session at once.
 */
const TOOL_RESULT_CAP = 2_000

export function searchText(turns: Turn[], cap = 200_000): string {
  const parts: string[] = []
  let size = 0
  const push = (s: string): void => {
    if (!s || size >= cap) return
    const text = s.length > cap - size ? s.slice(0, cap - size) : s
    parts.push(text)
    size += text.length
  }

  for (const t of turns) {
    for (const b of t.blocks) {
      switch (b.kind) {
        case 'text':
        case 'thinking':
          push(b.text)
          break
        case 'tool':
          push(b.name)
          for (const v of Object.values(b.input)) if (typeof v === 'string') push(v)
          if (b.result) push(b.result.slice(0, TOOL_RESULT_CAP))
          break
        default:
          // An image carries no searchable text.
          break
      }
    }
    if (size >= cap) break
  }
  return parts.join('\n').toLowerCase()
}

/** Shorten an absolute path against $HOME for display. */
export function shortenPath(p: string, home: string): string {
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p
}
