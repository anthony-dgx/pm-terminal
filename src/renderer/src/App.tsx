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
    input: '',
    cwd: '',
    model: null,
    profileId: null,
    ...over,
  }
}

/** The model a recorded session last ran on, from its assistant turns. */
function modelOfTurns(turns: Turn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const m = turns[i].model
    if (m) return m
  }
  return null
}

/**
 * What to call an open conversation in the switcher. History gives recorded
 * ones a real title, but a conversation started here has none until it is
 * saved, so fall back to what was actually asked in it.
 */
function conversationTitle(c: Conversation): string {
  if (c.entry?.title) return c.entry.title
  for (const t of c.turns) {
    if (t.role !== 'user') continue
    const text = t.blocks
      .map((b) => (b.kind === 'text' ? b.text : ''))
      .join(' ')
      .trim()
    if (text) return text.length > 80 ? `${text.slice(0, 80)}...` : text
  }
  // A draft in the composer is the only signal left on a tab never sent.
  const draft = c.input.trim()
  if (draft) return draft.length > 80 ? `${draft.slice(0, 80)}...` : draft
  return 'New session'
}

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
  const [inspectorFocus, setInspectorFocus] = useState<{ tab: InspectorTab; nonce: number } | null>(
    null,
  )
  const focusNonce = useRef(1)
  // Bumped to ask the sidebar to create a group; it owns the group state.
  const [newGroupSignal, setNewGroupSignal] = useState(0)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [kroks, setKroks] = useState<KroksReaction>(null)
  const kroksSeq = useRef(0)
  const poke = useCallback((kind: 'meow' | 'perk') => {
    setKroks({ kind, seq: ++kroksSeq.current })
  }, [])

  const scrollRef = useRef<HTMLDivElement>(null)
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
            return { ...c, turns, streamBuffers, awaiting: done ? false : c.awaiting }
          })
          if (e.turn.role === 'assistant' && e.turn.streaming === false && isActive()) poke('meow')
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
          if (isActive()) setInspectorKey((k) => k + 1)
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      switch (e.key.toLowerCase()) {
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
        case 'f':
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
  }, [toggleInspector, toggleSidebar])

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
        setActiveId(existing.id)
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
      setActiveId(next.id)
    },
    [conversations, env],
  )

  /**
   * The conversations already on screen, for the switcher. These are the ones
   * the sidebar cannot show: an unsaved tab has no history row yet.
   */
  const openItems = useMemo<SwitcherItem[]>(
    () =>
      Object.values(conversations).map((c) => ({
        key: c.id,
        title: conversationTitle(c),
        cwd: c.cwd,
        detail: c.entry?.firstPrompt ?? c.input,
        sessionId: c.sessionId ?? c.entry?.sessionId ?? null,
        open: true,
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
      else setActiveId(item.key)
    },
    [openEntry],
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
      setActiveId(id)
      const started = await desk.startSession(id, {
        cwd: entry.cwd,
        resume: entry.sessionId,
        model: existing?.model ?? undefined,
        profileId: existing?.profileId ?? env?.defaultProfileId ?? null,
      })
      patch(id, (c) => ({ ...c, info: started, started: true }))
      setInspectorKey((k) => k + 1)
    },
    [conversations, env, patch],
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
      setActiveId(next.id)
    },
    [env, conversations, activeId],
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

  /** Session ids with work in flight, so the sidebar can mark them. */
  const busySessionIds = useMemo(
    () =>
      Object.values(conversations)
        .filter((c) => c.awaiting)
        .map((c) => c.sessionId ?? c.entry?.sessionId ?? '')
        .filter(Boolean),
    [conversations],
  )

  if (!env || !conv) return <div className="boot">Loading...</div>

  const shortCwd = conv.cwd.startsWith(env.home) ? `~${conv.cwd.slice(env.home.length)}` : conv.cwd
  const viewingArchive = Boolean(conv.entry) && !conv.started
  const statusLabel = viewingArchive ? 'opened' : (conv.info?.status ?? 'idle')
  const otherBusy = Object.values(conversations).filter((c) => c.awaiting && c.id !== activeId).length

  return (
    <ReviewContext.Provider value={openReview}>
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-left">
          {/* Its own class, not part of `.app-name`: the word is hidden in a
              narrow window, and the mark is what still says which app this is. */}
          <img className="app-mark" src={logo} alt="" />
          <span className="app-name">Atelier</span>
          <button className="cwd-btn" onClick={() => void pickDir()} title="Change working directory">
            {shortCwd}
          </button>
          <ThemePicker current={theme} onChange={chooseTheme} />
        </div>
        <div className="titlebar-right">
          {otherBusy > 0 && (
            <span className="status status-elsewhere" title="Other sessions are still working">
              {winWidth >= 900 ? `${otherBusy} running elsewhere` : otherBusy}
            </span>
          )}
          <span className={`status status-${statusLabel}`}>{statusLabel}</span>
          <ProfilePicker
            current={conv.profileId}
            refreshKey={profilesKey}
            onChange={(id) => patch(activeId, (c) => ({ ...c, profileId: id }))}
          />
          <ModelPicker
            clientId={activeId}
            current={conv.info?.model ?? conv.model}
            live={conv.info?.status === 'running'}
            onChange={changeModel}
          />
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
              onOpen={(e) => void openEntry(e)}
              onResume={(e) => void resumeEntry(e)}
              onNew={() => newConversation()}
              activityKey={inspectorKey}
              onNewInGroup={(gProfileId) => newConversation(gProfileId ?? null)}
              onClose={toggleSidebar}
              newGroupSignal={newGroupSignal}
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
              variant={theme.startsWith('cowboy') ? 'horse' : 'cat'}
            />
          </div>
        </div>

        <main className="chat">
          <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
            {!conv.turns.length && (
              <div className="empty">
                <h2>New session</h2>
                <p>
                  Running in <code>{shortCwd}</code> with your real skills, plugins, and MCP servers loaded.
                </p>
                <p className="panel-hint">
                  Every code block, tool output, and table below gets its own copy button.
                </p>
              </div>
            )}
            {conv.turns.map((t) => (
              <TurnView key={t.id} turn={t} streamBuffer={conv.streamBuffers[t.id]} />
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

          {notices.length > 0 && (
            <div className="notices">
              {notices.map((n, i) => (
                <div key={i} className={`notice notice-${n.level}`}>
                  {n.text}
                </div>
              ))}
              <button className="linkish" onClick={() => setNotices([])}>
                dismiss
              </button>
            </div>
          )}

          <Composer
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
