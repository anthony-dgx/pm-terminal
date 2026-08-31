import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Attachment,
  HistoryEntry,
  MainEvent,
  PermissionAnswer,
  PermissionRequest,
  SessionInfo,
  Turn,
} from '../../shared/types.js'
import { desk } from './lib/api.js'
import { Inspector, type Tab as InspectorTab } from './components/Inspector.js'
import { PermissionPrompt } from './components/PermissionPrompt.js'
import { Sidebar } from './components/Sidebar.js'
import { TurnView } from './components/TurnView.js'
import { Kroks, type KroksReaction } from './components/Kroks.js'
import { Player } from './components/Player.js'
import { ModelPicker } from './components/ModelPicker.js'
import { Composer } from './components/Composer.js'
import { ProfilePicker } from './components/Profiles.js'
import { Switcher, type SwitcherItem } from './components/Switcher.js'
import { Thinking, phaseOf } from './components/Thinking.js'
import { ThemePicker } from './components/ThemePicker.js'
import { ReviewContext } from './review.js'
import {
  EMPTY_USAGE,
  deriveState,
  deriveTitle,
  deriveVitals,
  searchText,
  shortenPath,
  type SessionVitals,
  type VitalsUsage,
} from './lib/sessionState.js'
import logo from './assets/logo.png'

/**
 * One conversation on screen. Several can exist at once and each keeps its own
 * transcript, prompts, and in-flight state, so an agent working in one is never
 * rendered into another and switching away does not disturb it.
 */
interface Conversation {
  /** Stable key. Also the id the main process files events under. */
  id: string
  /** Claude's own session id, once the CLI reports it. */
  sessionId: string | null
  /** Set when opened from history, for the banner and for continuing it. */
  entry: HistoryEntry | null
  /** True once a prompt has been sent and a real agent session exists. */
  started: boolean
  turns: Turn[]
  streamBuffers: Record<string, string>
  permissions: PermissionRequest[]
  info: SessionInfo | null
  awaiting: boolean
  awaitSince: number
  /**
   * An answer arrived while this conversation was not the one on screen. Set
   * when a turn finishes elsewhere, cleared the moment you switch to it. Never
   * persisted: a stale flag from yesterday says nothing useful.
   */
  unread: boolean
  input: string
  cwd: string
  model: string | null
  profileId: string | null
}

function blankConversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: crypto.randomUUID(),
    sessionId: null,
    entry: null,
    started: false,
    turns: [],
    streamBuffers: {},
    permissions: [],
    info: null,
    awaiting: false,
    awaitSince: 0,
    unread: false,
    input: '',
    cwd: '',
    model: null,
    profileId: null,
    ...over,
  }
}

/**
 * 'claude-sonnet-4-5-20250929' -> 'sonnet 4.5'. The spend split is read at a
 * glance in a 352px column, so the id is more than it can carry.
 */
function shortModel(id: string | null): string {
  if (!id) return 'default'
  const m = id.match(/(opus|sonnet|haiku)-?(\d+)[-.]?(\d+)?/i)
  if (!m) return id.replace(/^claude-/, '').replace(/-\d{8}$/, '')
  return `${m[1].toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

/**
 * Whether the keystroke is already going somewhere that wants characters.
 *
 * Guards the bare-key shortcuts. Covers the switcher's input and the sidebar's
 * own search field as well as the composer, so `/` never fights with typing.
 */
function isTypingTarget(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/** The model a recorded session last ran on, from its assistant turns. */
/**
 * Whether a model string names a real model rather than one of the picker's
 * "let something else decide" sentinels. Those are fine as a *setting*, but
 * they are not an answer to "which model spent this money".
 */
function isRealModel(id: string | null | undefined): id is string {
  return Boolean(id) && id !== 'default' && id !== 'inherit'
}

function modelOfTurns(turns: Turn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const m = turns[i].model
    if (m) return m
  }
  return null
}

// Naming a conversation now lives in lib/sessionState, next to the rest of the
// derived status, so the switcher and the session rows cannot drift apart on
// what a session is called.

export function App(): React.ReactElement {
  const [env, setEnv] = useState<{
    home: string
    defaultCwd: string
    defaultModel: string | null
    defaultProfileId: string | null
    inspectorOpen: boolean
    sidebarOpen: boolean
    theme: string
    claudePath: string | null
  } | null>(null)

  const [conversations, setConversations] = useState<Record<string, Conversation>>({})
  const [activeId, setActiveId] = useState<string>('')

  const [profilesKey, setProfilesKey] = useState(0)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [theme, setTheme] = useState('default')
  const [winWidth, setWinWidth] = useState(() => window.innerWidth)
  const [notices, setNotices] = useState<{ level: string; text: string }[]>([])
  const [inspectorKey, setInspectorKey] = useState(0)
  /** Bumped for any conversation, so the sessions list stays in step. */
  const [activityKey, setActivityKey] = useState(0)
  const [inspectorFocus, setInspectorFocus] = useState<{ tab: InspectorTab; nonce: number } | null>(
    null,
  )
  const focusNonce = useRef(1)
  // Bumped to ask the sidebar to create a group; it owns the group state.
  const [newGroupSignal, setNewGroupSignal] = useState(0)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  /**
   * Tokens, cost and context per conversation.
   *
   * Main tallies these per session but only ever answered when the panel asked,
   * so nothing outside the panel could show a figure. The shell now reads spend
   * in three places at once (title bar, session rows, inspector footer), so it
   * is pulled here once and shared rather than fetched per component.
   */
  const [usageById, setUsageById] = useState<Record<string, VitalsUsage>>({})
  /**
   * How long each assistant turn took, in ms, keyed by turn id.
   *
   * The only per-turn figure that genuinely exists: main accumulates tokens and
   * cost per session, so there is nothing to hand a single turn beyond the wall
   * clock this window watched pass. Measured from the turn's own `at` to the
   * moment it stopped streaming.
   */
  const [turnMs, setTurnMs] = useState<Record<string, number>>({})
  /** Short commit of the running build, for the sessions footer. */
  const [build, setBuild] = useState('')
  /**
   * Ticks so the elapsed columns age on their own. Session rows show '4m', and
   * without this they would keep saying 'now' until some other state changed.
   */
  const [nowTick, setNowTick] = useState(0)
  const [kroks, setKroks] = useState<KroksReaction>(null)
  const kroksSeq = useRef(0)
  const poke = useCallback((kind: 'meow' | 'perk') => {
    setKroks({ kind, seq: ++kroksSeq.current })
  }, [])

  const scrollRef = useRef<HTMLDivElement>(null)
  /** The sessions column's search field, so `/` and Cmd+F can put focus in it. */
  const searchRef = useRef<HTMLInputElement>(null)
  const pinnedRef = useRef(true)
  const newConversationRef = useRef<(profileId?: string | null) => void>(() => undefined)
  const sidebarPrefRef = useRef(true)
  const inspectorPrefRef = useRef(true)

  /** Update one conversation without touching any other. */
  const patch = useCallback((id: string, fn: (c: Conversation) => Conversation) => {
    setConversations((prev) => {
      const c = prev[id]
      if (!c) return prev
      return { ...prev, [id]: fn(c) }
    })
  }, [])

  /**
   * The one way to change which conversation is on screen. Every caller goes
   * through here so the unread mark is cleared in a single place: showing a
   * conversation is what "reading it" means.
   */
  const select = useCallback(
    (id: string) => {
      setActiveId(id)
      patch(id, (c) => (c.unread ? { ...c, unread: false } : c))
    },
    [patch],
  )

  useEffect(() => {
    void desk.env().then((e) => {
      setEnv(e)
      setInspectorOpen(e.inspectorOpen)
      setSidebarOpen(e.sidebarOpen)
      inspectorPrefRef.current = e.inspectorOpen
      sidebarPrefRef.current = e.sidebarOpen
      setTheme(e.theme)
      const first = blankConversation({
        cwd: e.defaultCwd,
        model: e.defaultModel,
        profileId: e.defaultProfileId,
      })
      setConversations({ [first.id]: first })
      setActiveId(first.id)
    })
  }, [])

  // ---- main-process event stream -----------------------------------------
  // Every event carries the conversation it belongs to. Events for a
  // conversation that is not on screen still update its stored state, so
  // switching back shows everything that happened while it was hidden.

  useEffect(() => {
    return desk.onEvent((clientId: string, e: MainEvent) => {
      const isActive = (): boolean => clientId === activeIdRef.current

      switch (e.type) {
        case 'turn': {
          patch(clientId, (c) => {
            const i = c.turns.findIndex((t) => t.id === e.turn.id)
            const turns = i === -1 ? [...c.turns, e.turn] : c.turns.map((t, j) => (j === i ? e.turn : t))
            const streamBuffers = { ...c.streamBuffers }
            delete streamBuffers[e.turn.id]
            const done = e.turn.role === 'assistant' && e.turn.streaming === false
            return {
              ...c,
              turns,
              streamBuffers,
              awaiting: done ? false : c.awaiting,
              // An answer that landed on screen has been read by definition.
              unread: done && !isActive() ? true : c.unread,
            }
          })
          if (e.turn.role === 'assistant' && e.turn.streaming === false) {
            // Recorded once and never revised: a late tool result re-emits a
            // finished turn, and the second timestamp would be meaningless.
            const startedAt = Date.parse(e.turn.at)
            if (!Number.isNaN(startedAt)) {
              setTurnMs((prev) =>
                prev[e.turn.id] !== undefined
                  ? prev
                  : { ...prev, [e.turn.id]: Math.max(0, Date.now() - startedAt) },
              )
            }
            if (isActive()) poke('meow')
          }
          break
        }
        case 'turn-delta':
          patch(clientId, (c) => ({
            ...c,
            streamBuffers: { ...c.streamBuffers, [e.turnId]: (c.streamBuffers[e.turnId] ?? '') + e.text },
          }))
          break
        case 'session':
          patch(clientId, (c) => ({
            ...c,
            info: e.info,
            sessionId: e.info.sessionId ?? c.sessionId,
            awaiting: e.info.status === 'error' || e.info.status === 'closed' ? false : c.awaiting,
          }))
          break
        case 'permission':
          patch(clientId, (c) => ({ ...c, permissions: [...c.permissions, e.request] }))
          poke('meow')
          break
        case 'permission-resolved':
          patch(clientId, (c) => ({ ...c, permissions: c.permissions.filter((p) => p.id !== e.id) }))
          break
        case 'inspector-dirty':
          // The panel describes the session on screen, so it only refreshes for
          // that one. The sessions list describes all of them: a session that
          // started or answered while hidden has no row yet, and without a row
          // there is nothing to mark as unread.
          if (isActive()) setInspectorKey((k) => k + 1)
          setActivityKey((k) => k + 1)
          break
        case 'notice':
          setNotices((prev) => [...prev.slice(-4), { level: e.level, text: e.text }])
          break
      }
    })
  }, [patch, poke])

  // The event handler is registered once, so it reads the active id from a ref.
  const activeIdRef = useRef('')
  activeIdRef.current = activeId

  const conv = conversations[activeId]

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [conv?.turns, conv?.streamBuffers])

  // Fold the side panels away as the window narrows, and bring back whatever
  // was open once there is room again. Crossing the threshold is what acts, so
  // you can still force a panel open by hand at any width.
  useEffect(() => {
    const SIDEBAR_MIN = 700
    const INSPECTOR_MIN = 1040
    let wasNarrowSidebar = window.innerWidth < SIDEBAR_MIN
    let wasNarrowInspector = window.innerWidth < INSPECTOR_MIN

    const onResize = (): void => {
      const w = window.innerWidth
      setWinWidth(w)

      const narrowSidebar = w < SIDEBAR_MIN
      if (narrowSidebar !== wasNarrowSidebar) {
        wasNarrowSidebar = narrowSidebar
        // Never persisted: this is a reaction to size, not a preference.
        setSidebarOpen(narrowSidebar ? false : sidebarPrefRef.current)
      }

      const narrowInspector = w < INSPECTOR_MIN
      if (narrowInspector !== wasNarrowInspector) {
        wasNarrowInspector = narrowInspector
        setInspectorOpen(narrowInspector ? false : inspectorPrefRef.current)
      }
    }
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // The whole UI is built on CSS variables, so a theme is just a palette swap
  // driven by a data attribute on the root element.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const chooseTheme = useCallback((next: string) => {
    setTheme(next)
    void desk.setTheme(next)
  }, [])

  useEffect(() => {
    void desk.updateStatus().then((s) => setBuild(s.commit.slice(0, 7)))
  }, [])

  // 30s is fine: the labels are 'now' / '4m' / '2h', so a finer clock would
  // re-render the whole list to produce the same string.
  useEffect(() => {
    const t = setInterval(() => setNowTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  /**
   * Keep the per-session figures fresh.
   *
   * Refetched whenever the agent reports activity, and on a slow timer while
   * anything is in flight, because tokens keep climbing during a turn without
   * any event firing. Only started sessions are asked: main has no tally for a
   * conversation that never ran, and asking would just log a miss.
   */
  const startedIds = useMemo(
    () =>
      Object.values(conversations)
        .filter((c) => c.started)
        .map((c) => c.id)
        .sort()
        .join(','),
    [conversations],
  )
  const anyAwaiting = useMemo(
    () => Object.values(conversations).some((c) => c.awaiting),
    [conversations],
  )

  useEffect(() => {
    const ids = startedIds ? startedIds.split(',') : []
    if (!ids.length) return
    let cancelled = false

    const pull = async (): Promise<void> => {
      const rows = await Promise.all(
        ids.map(async (id) => {
          const [u, ctx] = await Promise.all([desk.usage(id), desk.contextUsage(id)])
          const usage: VitalsUsage = {
            tokens: (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0),
            cost: u?.totalCostUsd ?? 0,
            turns: u?.turns ?? 0,
            contextUsed: ctx?.totalTokens ?? 0,
            contextLimit: ctx?.contextWindow ?? 0,
          }
          return [id, usage] as const
        }),
      )
      if (cancelled) return
      setUsageById((prev) => {
        const next = { ...prev }
        for (const [id, usage] of rows) next[id] = usage
        return next
      })
    }

    void pull()
    if (!anyAwaiting) return () => {
      cancelled = true
    }
    const t = setInterval(() => void pull(), 5_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [startedIds, anyAwaiting, activityKey])

  const toggleInspector = useCallback(() => {
    setInspectorOpen((open) => {
      const next = !open
      inspectorPrefRef.current = next
      void desk.setInspectorOpen(next)
      return next
    })
  }, [])

  /**
   * Show the panel on a given tab, from somewhere that is not the tab bar. The
   * nonce is what lets the same request work twice in a row.
   */
  const focusInspector = useCallback((tab: InspectorTab) => {
    setInspectorOpen(true)
    inspectorPrefRef.current = true
    void desk.setInspectorOpen(true)
    setInspectorFocus({ tab, nonce: focusNonce.current++ })
  }, [])

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      const next = !open
      sidebarPrefRef.current = next
      void desk.setSidebarOpen(next)
      return next
    })
  }, [])

  /**
   * Put the caret in the sessions search field.
   *
   * Reveals the column first if it is hidden: focusing a field nobody can see
   * would swallow the next keystrokes into nothing. The field may only mount on
   * the following frame, hence the short retry rather than a single focus call.
   */
  const focusSearch = useCallback(() => {
    setSidebarOpen((open) => {
      if (!open) {
        sidebarPrefRef.current = true
        void desk.setSidebarOpen(true)
      }
      return true
    })
    const attempt = (left: number): void => {
      const el = searchRef.current
      if (el) {
        el.focus()
        el.select()
        return
      }
      if (left > 0) requestAnimationFrame(() => attempt(left - 1))
    }
    requestAnimationFrame(() => attempt(3))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      /*
       * Bare `/` belongs to the composer's skill autocomplete — that is what it
       * has always done and what the README documents. The handoff also wanted
       * `/` to focus search, but that only works if the composer already has
       * focus, which it does not after clicking Stop, Copy, a permission button
       * or anywhere in the transcript. Binding search here meant typing `/` to
       * start a skill silently jumped to the sidebar (and force-opened it).
       *
       * So: put the caret in the composer and let the keystroke through, which
       * opens the skill menu. Search keeps Cmd+K and Cmd+F, both of which the
       * handoff lists too.
       */
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget()) {
        const ta = document.querySelector<HTMLTextAreaElement>('.composer textarea')
        if (ta) {
          // No preventDefault: focusing synchronously lets the '/' land in the
          // textarea, so the menu opens on the same keystroke.
          ta.focus()
          return
        }
        e.preventDefault()
        focusSearch()
        return
      }
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      switch (e.key.toLowerCase()) {
        // Cmd+K opens the palette, which is the "find any session" surface;
        // Cmd+F is the ordinary find gesture and lands in the list's own field.
        // The handoff's "`/` or Cmd+K" allows both, and neither was bound.
        case 'f':
          e.preventDefault()
          focusSearch()
          break
        case 'i':
          e.preventDefault()
          toggleInspector()
          break
        case 'b':
          e.preventDefault()
          toggleSidebar()
          break
        case 't':
          e.preventDefault()
          // Via a ref: the handler is installed before newConversation exists.
          newConversationRef.current()
          break
        case 'k':
          e.preventDefault()
          // Toggle, so the same keystroke that opened it puts it away.
          setSwitcherOpen((o) => !o)
          break
        case 'g':
          e.preventDefault()
          // A group created into a hidden sidebar would be invisible, so
          // reveal it first.
          setSidebarOpen((open) => {
            if (!open) {
              sidebarPrefRef.current = true
              void desk.setSidebarOpen(true)
            }
            return true
          })
          setNewGroupSignal((n) => n + 1)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleInspector, toggleSidebar, focusSearch])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  // ---- actions -----------------------------------------------------------

  /**
   * Send a prompt. Defaults to whatever is in the composer, but callers can
   * pass their own - a review batch is a prompt the user never typed there.
   * Setting `input` and then calling submit would race React's state.
   */
  const submit = useCallback(
    async (images: Attachment[] = [], override?: string) => {
      const c = conversations[activeId]
      if (!c) return
      const fromComposer = override === undefined
      // Guard on the text actually being sent, not on the composer, or a
      // review batch would be swallowed whenever the composer is empty.
      const text = (override ?? c.input).trim()
      if ((!text && !images.length) || c.info?.status === 'starting') return

      // `/mcp` is an interactive screen in the terminal. Through the SDK it only
      // prints a one-line summary and cannot sign in to anything, so intercept it
      // and open the panel, where the live status and the sign-in button live.
      // Anything with arguments (`/mcp reconnect all`) still goes to the agent.
      if (text === '/mcp' && !images.length) {
        if (fromComposer) patch(c.id, (x) => ({ ...x, input: '' }))
        focusInspector('mcp')
        return
      }

      patch(c.id, (x) => ({
        ...x,
        // Only clear the composer if that is where this came from. A review
        // batch must not throw away a draft the user was part way through.
        input: fromComposer ? '' : x.input,
        awaiting: true,
        awaitSince: Date.now(),
        started: true,
      }))

      // Start the agent on first send, or after it died. Resume when this
      // conversation came from an existing transcript.
      const needsStart = !c.started || c.info?.status === 'closed' || c.info?.status === 'error'
      if (needsStart) {
        const started = await desk.startSession(c.id, {
          cwd: c.cwd,
          resume: c.entry?.sessionId,
          model: c.model ?? undefined,
          profileId: c.profileId,
        })
        patch(c.id, (x) => ({ ...x, info: started }))
      }
      poke('perk')
      await desk.send(c.id, text, images)
    },
    [conversations, activeId, patch, poke, focusInspector],
  )

  // ---- review ------------------------------------------------------------

  /**
   * A document opens in its own window, not over the chat.
   *
   * The window sends its comments back into this conversation, so the review
   * rounds still appear in this transcript - but the reading and commenting
   * happen next to the chat rather than on top of it, and the rewritten
   * document returns into that window.
   */
  const openReview = useCallback(
    (title: string, snapshot: string, path?: string) => {
      void desk.readerOpen({ clientId: activeId, title, snapshot, path })
    },
    [activeId],
  )

  const changeModel = useCallback(
    (next: string) => {
      patch(activeId, (c) => ({ ...c, model: next }))
      void desk.setModel(activeId, next).then((updated) => {
        if (updated) patch(activeId, (c) => ({ ...c, info: updated }))
      })
    },
    [activeId, patch],
  )

  const stop = useCallback(() => {
    void desk.interrupt(activeId)
    patch(activeId, (c) => ({ ...c, awaiting: false }))
  }, [activeId, patch])

  const answerPermission = useCallback(
    (id: string, answer: PermissionAnswer) => {
      void desk.answerPermission(activeId, id, answer)
    },
    [activeId],
  )

  /**
   * Show a recorded session. If it is already open in a conversation, switch to
   * that one rather than loading a second copy, so a running agent is never
   * orphaned behind a fresh view of the same transcript.
   */
  const openEntry = useCallback(
    async (entry: HistoryEntry) => {
      const existing = Object.values(conversations).find(
        (c) => c.entry?.sessionId === entry.sessionId || c.sessionId === entry.sessionId,
      )
      if (existing) {
        select(existing.id)
        return
      }
      const t = await desk.historyRead(entry.projectSlug, entry.sessionId)
      const next = blankConversation({
        entry,
        sessionId: entry.sessionId,
        turns: t,
        cwd: entry.cwd,
        model: modelOfTurns(t) ?? env?.defaultModel ?? null,
        profileId: env?.defaultProfileId ?? null,
      })
      setConversations((prev) => ({ ...prev, [next.id]: next }))
      select(next.id)
    },
    [conversations, env, select],
  )

  /**
   * The conversations already on screen, for the switcher. These are the ones
   * the sidebar cannot show: an unsaved tab has no history row yet.
   */
  const openItems = useMemo<SwitcherItem[]>(
    () =>
      Object.values(conversations).map((c) => ({
        key: c.id,
        title: deriveTitle(c),
        cwd: c.cwd,
        detail: c.entry?.firstPrompt ?? c.input,
        sessionId: c.sessionId ?? c.entry?.sessionId ?? null,
        open: true,
        // Lets the palette lift the ones stopped on a person into their own
        // section. Derived here rather than read off `vitals` so this memo does
        // not have to run after it.
        state: deriveState(c),
        unread: c.unread,
        at: c.turns.length ? Date.parse(c.turns[c.turns.length - 1].at) || 0 : 0,
        entry: null,
      })),
    [conversations],
  )

  const pickSession = useCallback(
    (item: SwitcherItem) => {
      setSwitcherOpen(false)
      // An open one is just a switch. A recorded one goes through openEntry,
      // which loads the transcript and de-dupes against what is already open.
      if (item.entry) void openEntry(item.entry)
      else select(item.key)
    },
    [openEntry, select],
  )

  /** Open it and start the agent immediately, without waiting for a prompt. */
  const resumeEntry = useCallback(
    async (entry: HistoryEntry) => {
      const existing = Object.values(conversations).find(
        (c) => c.entry?.sessionId === entry.sessionId || c.sessionId === entry.sessionId,
      )
      const id = existing?.id ?? crypto.randomUUID()
      if (!existing) {
        const t = await desk.historyRead(entry.projectSlug, entry.sessionId)
        setConversations((prev) => ({
          ...prev,
          [id]: blankConversation({
            id,
            entry,
            sessionId: entry.sessionId,
            turns: t,
            cwd: entry.cwd,
            model: modelOfTurns(t) ?? env?.defaultModel ?? null,
            profileId: env?.defaultProfileId ?? null,
          }),
        }))
      }
      select(id)
      const started = await desk.startSession(id, {
        cwd: entry.cwd,
        resume: entry.sessionId,
        model: existing?.model ?? undefined,
        profileId: existing?.profileId ?? env?.defaultProfileId ?? null,
      })
      patch(id, (c) => ({ ...c, info: started, started: true }))
      setInspectorKey((k) => k + 1)
      setActivityKey((k) => k + 1)
    },
    [conversations, env, patch, select],
  )

  const newConversation = useCallback(
    (profileId?: string | null) => {
      if (!env) return
      const next = blankConversation({
        cwd: conversations[activeId]?.cwd || env.defaultCwd,
        model: env.defaultModel,
        profileId: profileId !== undefined ? profileId : env.defaultProfileId,
      })
      setConversations((prev) => ({ ...prev, [next.id]: next }))
      select(next.id)
    },
    [env, conversations, activeId, select],
  )

  newConversationRef.current = newConversation

  const pickDir = useCallback(async () => {
    const dir = await desk.pickDir()
    if (dir) patch(activeId, (c) => ({ ...c, cwd: dir }))
  }, [activeId, patch])

  const userPrompts = useMemo(
    () =>
      (conv?.turns ?? [])
        .filter((t) => t.role === 'user')
        .map((t) =>
          t.blocks
            .filter((b) => b.kind === 'text')
            .map((b) => (b.kind === 'text' ? b.text : ''))
            .join('\n'),
        )
        .filter((t) => t.trim().length > 0),
    [conv?.turns],
  )

  /**
   * One flattened, lower-cased haystack per open conversation, so the sessions
   * column can search what an agent actually said and not just its title.
   *
   * Cached against the `turns` array identity: a stream delta replaces
   * `conversations` many times a second, and re-flattening every transcript on
   * each of those would be the whole cost of the feature. Only the conversation
   * whose turns actually changed is rebuilt.
   */
  const searchCache = useRef(new Map<string, { turns: Turn[]; text: string }>())
  const searchTextById = useMemo(() => {
    const cache = searchCache.current
    const out: Record<string, string> = {}
    for (const c of Object.values(conversations)) {
      const hit = cache.get(c.id)
      if (hit && hit.turns === c.turns) {
        out[c.id] = hit.text
        continue
      }
      const text = searchText(c.turns)
      cache.set(c.id, { turns: c.turns, text })
      out[c.id] = text
    }
    // A closed conversation must not keep its transcript alive in the cache.
    for (const id of [...cache.keys()]) if (!(id in out)) cache.delete(id)
    return out
  }, [conversations])

  /** Session ids with work in flight, so the sidebar can mark them. */
  const busySessionIds = useMemo(
    () =>
      Object.values(conversations)
        .filter((c) => c.awaiting)
        .map((c) => c.sessionId ?? c.entry?.sessionId ?? '')
        .filter(Boolean),
    [conversations],
  )

  /** Session ids holding an answer nobody has looked at yet. */
  const unreadSessionIds = useMemo(
    () =>
      Object.values(conversations)
        .filter((c) => c.unread)
        .map((c) => c.sessionId ?? c.entry?.sessionId ?? '')
        .filter(Boolean),
    [conversations],
  )

  /**
   * One status object per open conversation. Every surface that shows a session
   * — the rows, the title bar counts, the inspector — reads these, so they can
   * never disagree about what an agent is doing.
   */
  const vitals = useMemo<SessionVitals[]>(
    () =>
      Object.values(conversations).map((c) =>
        deriveVitals(c, usageById[c.id] ?? EMPTY_USAGE),
      ),
    // nowTick is a dependency on purpose: it is what ages the elapsed labels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversations, usageById, nowTick],
  )

  const runningCount = vitals.filter((v) => v.state === 'running').length
  /** Blocked counts as needing you: both mean the agent has stopped on a person. */
  const needsYouCount = vitals.filter(
    (v) => v.state === 'needs_you' || v.state === 'blocked',
  ).length

  /**
   * Today's spend, split by model.
   *
   * The point of this figure is which model the money went to, not a time
   * series — an hour-by-hour chart of your own spend answers no question you
   * actually have. Attribution is per conversation, since that is the finest
   * grain main tallies at.
   */
  const spend = useMemo(() => {
    const byModel = new Map<string, { model: string; tokens: number; cost: number }>()
    let tokens = 0
    let cost = 0
    for (const c of Object.values(conversations)) {
      const u = usageById[c.id]
      if (!u || (!u.tokens && !u.cost)) continue
      tokens += u.tokens
      cost += u.cost
      // `default` is the picker's "let the CLI choose" sentinel, not a model. A
      // split chart whose biggest slice is labelled "default" answers nothing,
      // so fall through to what the turns say actually replied.
      const pinned = c.info?.model ?? c.model
      const model = shortModel(isRealModel(pinned) ? pinned : modelOfTurns(c.turns))
      const row = byModel.get(model) ?? { model, tokens: 0, cost: 0 }
      row.tokens += u.tokens
      row.cost += u.cost
      byModel.set(model, row)
    }
    return {
      tokens,
      cost,
      byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
    }
  }, [conversations, usageById])

  if (!env || !conv) return <div className="boot">Loading...</div>

  const shortCwd = shortenPath(conv.cwd, env.home)
  const viewingArchive = Boolean(conv.entry) && !conv.started
  /** The per-session state pill is gone from the bar; the row's dot says it now. */
  const activeVitals = vitals.find((v) => v.id === activeId) ?? null

  return (
    <ReviewContext.Provider value={openReview}>
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-left">
          {/* Its own class, not part of `.app-name`: the word is hidden in a
              narrow window, and the mark is what still says which app this is. */}
          <img className="app-mark" src={logo} alt="" />
          <button className="cwd-btn" onClick={() => void pickDir()} title="Change working directory">
            {shortCwd}
          </button>

          <span className="tb-div" />

          {/*
            Two counts replace the five separate pills this bar used to carry.
            They are the only two questions worth answering from across the
            room: is anything working, and does anything want me. Both are
            absent rather than zeroed when there is nothing to say — a row of
            zeros is chrome competing for attention, which is the thing the
            redesign is trying to remove.
          */}
          {runningCount > 0 && (
            <span className="tb-count" title="Sessions with work in flight">
              <span className="dot dot-running" />
              {winWidth >= 880 ? `${runningCount} running` : runningCount}
            </span>
          )}
          {needsYouCount > 0 && (
            <button
              className="tb-count is-attn"
              onClick={() => setSwitcherOpen(true)}
              title="Sessions waiting on you"
            >
              <span className="dot dot-attn" />
              {winWidth >= 880 ? `${needsYouCount} need you` : needsYouCount}
            </button>
          )}
        </div>
        {/*
         * Order follows the handoff: model, then profile. The theme swatch is
         * an addition the spec does not describe, so it sits outboard of the
         * two session controls rather than between them.
         */}
        <div className="titlebar-right">
          <ModelPicker
            clientId={activeId}
            current={conv.info?.model ?? conv.model}
            live={conv.info?.status === 'running'}
            onChange={changeModel}
          />
          <ProfilePicker
            current={conv.profileId}
            refreshKey={profilesKey}
            onChange={(id) => patch(activeId, (c) => ({ ...c, profileId: id }))}
          />
          <ThemePicker current={theme} onChange={chooseTheme} />
          {conv.awaiting && (
            <button className="btn btn-deny" onClick={stop}>
              Stop
            </button>
          )}
        </div>
      </header>

      {switcherOpen && (
        <Switcher
          openItems={openItems}
          onPick={pickSession}
          onClose={() => setSwitcherOpen(false)}
          home={env.home}
        />
      )}

      {!env.claudePath && (
        <div className="banner banner-error">
          Could not find the <code>claude</code> binary. Set <code>ATELIER_CLI_PATH</code> and restart.
        </div>
      )}
      {conv.info?.error && <div className="banner banner-error">{conv.info.error}</div>}
      {viewingArchive && conv.entry && (
        <div className="banner">
          Viewing <strong>{conv.entry.title}</strong>. Type below to continue this session.
        </div>
      )}

      <div className="body">
        <div className={`leftcol ${sidebarOpen ? '' : 'is-collapsed'}`}>
          {sidebarOpen ? (
            <Sidebar
              home={env.home}
              activeSessionId={conv.sessionId ?? conv.entry?.sessionId ?? null}
              busySessionIds={busySessionIds}
              unreadSessionIds={unreadSessionIds}
              onOpen={(e) => void openEntry(e)}
              onResume={(e) => void resumeEntry(e)}
              onNew={() => newConversation()}
              activityKey={activityKey}
              onNewInGroup={(gProfileId) => newConversation(gProfileId ?? null)}
              onClose={toggleSidebar}
              newGroupSignal={newGroupSignal}
              vitals={vitals}
              activeConversationId={activeId}
              onSelectConversation={select}
              build={build}
              searchTextById={searchTextById}
              searchRef={searchRef}
            />
          ) : (
            <button className="sidebar-rail" onClick={toggleSidebar} title="Show sessions (Cmd+B)">
              <span className="inspector-rail-caret">›</span>
              <span className="inspector-rail-label">Sessions</span>
            </button>
          )}

          {/* Kept mounted while collapsed: unmounting the player would tear
              down the YouTube iframe and stop the music. */}
          <div className="left-dock" hidden={!sidebarOpen}>
            <Player theme={theme} />
            <Kroks
              reaction={kroks}
              working={conv.awaiting}
              variant={theme.startsWith('tokyo') ? 'dragon' : theme.startsWith('cowboy') ? 'horse' : 'cat'}
            />
          </div>
        </div>

        <main className="chat">
          <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
            {/*
              The first thing you see in a new session, so it says what this
              session *is* — directory and model — rather than describing the
              app's features. On the transcript's own measure, in the shell's
              eyebrow-and-keyhint vocabulary, not the old centred hero.
            */}
            {!conv.turns.length && (
              <div className="tx-empty">
                <span className="eyebrow">New session</span>
                <div className="rule" />
                <p className="tx-empty-say">
                  <code>{shortCwd}</code> · {shortModel(conv.info?.model ?? conv.model)} · your real
                  skills, plugins and MCP servers
                </p>
                <div className="tx-keys">
                  <span className="keyhint">⌘K</span> switch session ·{' '}
                  <span className="keyhint">/</span> search titles, paths and output ·{' '}
                  <span className="keyhint">⏎</span> send
                </div>
              </div>
            )}
            {conv.turns.map((t) => (
              <TurnView
                key={t.id}
                turn={t}
                streamBuffer={conv.streamBuffers[t.id]}
                // Duration only: tokens and cost are tallied per session, so
                // there is no honest per-turn figure to pass for them.
                usage={turnMs[t.id] !== undefined ? { durationMs: turnMs[t.id] } : undefined}
              />
            ))}
            {conv.awaiting && !conv.permissions.length && (
              <Thinking
                phase={phaseOf(
                  conv.turns,
                  conv.info?.status === 'starting',
                  Object.values(conv.streamBuffers).some((v) => v.length > 0),
                )}
                since={conv.awaitSince}
                onStop={stop}
              />
            )}
          </div>

          {conv.permissions.length > 0 && (
            <div className="perm-stack">
              {conv.permissions.map((p) => (
                <PermissionPrompt key={p.id} request={p} onAnswer={(a) => answerPermission(p.id, a)} />
              ))}
            </div>
          )}

          {/*
            Notices used to stack loose above the composer, each one another
            box competing with the transcript. They are now a single strip on
            the composer itself: the newest thing wrong, dismissible, in the
            one place you are already looking when you go to type.
          */}
          <Composer
            warnings={notices}
            onDismissWarning={(i) => setNotices((prev) => prev.filter((_, j) => j !== i))}
            clientId={activeId}
            cwd={conv.cwd}
            value={conv.input}
            onChange={(v) => patch(activeId, (c) => ({ ...c, input: v }))}
            onSubmit={(images) => void submit(images)}
            placeholder={viewingArchive ? 'Continue this session...' : 'Message Claude...'}
            disabled={conv.info?.status === 'starting'}
            skillsKey={inspectorKey}
            working={conv.awaiting}
            history={userPrompts}
          />
        </main>

        {inspectorOpen ? (
          <Inspector
            clientId={activeId}
            cwd={conv.cwd}
            refreshKey={inspectorKey}
            focus={inspectorFocus ?? undefined}
            busy={Object.values(conversations).filter((c) => c.awaiting).length}
            profilesKey={profilesKey}
            onProfilesChanged={() => setProfilesKey((k) => k + 1)}
            onClose={toggleInspector}
            vitals={vitals}
            spend={spend}
            sessionLabel={activeVitals?.title ?? 'session'}
          />
        ) : (
          <button className="inspector-rail" onClick={toggleInspector} title="Show panel (Cmd+I)">
            <span className="inspector-rail-caret">‹</span>
            <span className="inspector-rail-label">Inspector</span>
          </button>
        )}
      </div>

    </div>
    </ReviewContext.Provider>
  )
}
