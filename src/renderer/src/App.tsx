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
import { Inspector } from './components/Inspector.js'
import { PermissionPrompt } from './components/PermissionPrompt.js'
import { Sidebar } from './components/Sidebar.js'
import { TurnView } from './components/TurnView.js'
import { CopyButton } from './components/Copy.js'
import { Kroks, type KroksReaction } from './components/Kroks.js'
import { Player } from './components/Player.js'
import { ModelPicker } from './components/ModelPicker.js'
import { Composer } from './components/Composer.js'
import { ProfilePicker } from './components/Profiles.js'
import { Thinking, phaseOf } from './components/Thinking.js'

type Mode = { kind: 'live' } | { kind: 'archive'; entry: HistoryEntry }

/** The model a recorded session last ran on, from its assistant turns. */
function modelOfTurns(turns: Turn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const m = turns[i].model
    if (m) return m
  }
  return null
}

export function App(): React.ReactElement {
  const [env, setEnv] = useState<{
    home: string
    defaultCwd: string
    defaultModel: string | null
    defaultProfileId: string | null
    inspectorOpen: boolean
    sidebarOpen: boolean
    claudePath: string | null
  } | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [profilesKey, setProfilesKey] = useState(0)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [info, setInfo] = useState<SessionInfo | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [streamBuffers, setStreamBuffers] = useState<Record<string, string>>({})
  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const [notices, setNotices] = useState<{ level: string; text: string }[]>([])
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<Mode>({ kind: 'live' })
  const [cwd, setCwd] = useState('')
  const [inspectorKey, setInspectorKey] = useState(0)
  const [busy, setBusy] = useState(false)
  // True from pressing enter until the reply completes, so the indicator covers
  // the dead air before the first token as well as the streaming itself.
  const [awaiting, setAwaiting] = useState(false)
  const [awaitSince, setAwaitSince] = useState(0)
  // Kroks reacts to what the agent is doing: a chirp when you send, a meow when
  // a turn lands or permission is needed, fast tail while a turn is in flight.
  const [kroks, setKroks] = useState<KroksReaction>(null)
  const kroksSeq = useRef(0)
  const poke = useCallback((kind: 'meow' | 'perk') => {
    setKroks({ kind, seq: ++kroksSeq.current })
  }, [])

  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  useEffect(() => {
    void desk.env().then((e) => {
      setEnv(e)
      setCwd(e.defaultCwd)
      setModel(e.defaultModel)
      setProfileId(e.defaultProfileId)
      setInspectorOpen(e.inspectorOpen)
      setSidebarOpen(e.sidebarOpen)
    })
  }, [])

  // ---- main-process event stream ----------------------------------------

  useEffect(() => {
    return desk.onEvent((e: MainEvent) => {
      switch (e.type) {
        case 'turn': {
          setTurns((prev) => {
            const i = prev.findIndex((t) => t.id === e.turn.id)
            if (i === -1) return [...prev, e.turn]
            const next = [...prev]
            next[i] = e.turn
            return next
          })
          // A turn that just stopped streaming is a finished reply: meow.
          if (e.turn.role === 'assistant' && e.turn.streaming === false) {
            poke('meow')
            setAwaiting(false)
          }
          // Authoritative blocks arrived and already contain everything streamed
          // so far, so drop the draft. Later deltas refill it for the next
          // assistant message in the same turn.
          setStreamBuffers((prev) => {
            if (!(e.turn.id in prev)) return prev
            const next = { ...prev }
            delete next[e.turn.id]
            return next
          })
          break
        }
        case 'turn-delta':
          setStreamBuffers((prev) => ({ ...prev, [e.turnId]: (prev[e.turnId] ?? '') + e.text }))
          break
        case 'session':
          setInfo(e.info)
          setBusy(e.info.status === 'starting')
          // Never leave the indicator spinning after a dead session.
          if (e.info.status === 'error' || e.info.status === 'closed') setAwaiting(false)
          break
        case 'permission':
          setPermissions((prev) => [...prev, e.request])
          poke('meow')
          break
        case 'permission-resolved':
          setPermissions((prev) => prev.filter((p) => p.id !== e.id))
          break
        case 'inspector-dirty':
          setInspectorKey((k) => k + 1)
          break
        case 'notice':
          setNotices((prev) => [...prev.slice(-4), { level: e.level, text: e.text }])
          break
      }
    })
  }, [poke])

  // ---- autoscroll, but only while the user is already at the bottom ------

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [turns, streamBuffers])

  const toggleInspector = useCallback(() => {
    setInspectorOpen((open) => {
      const next = !open
      void desk.setInspectorOpen(next)
      return next
    })
  }, [])

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      const next = !open
      void desk.setSidebarOpen(next)
      return next
    })
  }, [])

  // Cmd/Ctrl+B for sessions, Cmd/Ctrl+I for the inspector.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'i') {
        e.preventDefault()
        toggleInspector()
      } else if (k === 'b') {
        e.preventDefault()
        toggleSidebar()
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

  const ensureSession = useCallback(
    async (resume?: string, sessionCwd?: string, overrideProfileId?: string | null) => {
      const started = await desk.startSession({
        cwd: sessionCwd ?? cwd,
        resume,
        model: model ?? undefined,
        // Explicit override wins, else the group's default, else the last used.
        profileId: overrideProfileId !== undefined ? overrideProfileId : profileId,
      })
      setInfo(started)
      return started
    },
    [cwd, model, profileId],
  )

  const submit = useCallback(
    async (images: Attachment[] = []) => {
    const text = input.trim()
    if ((!text && !images.length) || busy) return
    setInput('')
    if (mode.kind === 'archive') {
      // Typing into an opened session continues it. The transcript stays on
      // screen: clearing it here used to make the history vanish mid-send.
      await ensureSession(mode.entry.sessionId, mode.entry.cwd)
      setMode({ kind: 'live' })
    } else if (!info || info.status === 'closed' || info.status === 'error') {
      await ensureSession()
    }
    poke('perk')
    setAwaitSince(Date.now())
    setAwaiting(true)
    await desk.send(text, images)
    },
    [input, busy, mode, info, ensureSession, poke],
  )

  const changeModel = useCallback((next: string) => {
    setModel(next)
    // Applies to the live session immediately; otherwise it is remembered for
    // the next one. Either way the choice persists across restarts.
    void desk.setModel(next).then((updated) => {
      if (updated) setInfo(updated)
    })
  }, [])

  const stop = useCallback(() => {
    void desk.interrupt()
    setAwaiting(false)
  }, [])

  const answerPermission = useCallback((id: string, answer: PermissionAnswer) => {
    void desk.answerPermission(id, answer)
  }, [])

  const openArchive = useCallback(async (entry: HistoryEntry) => {
    const t = await desk.historyRead(entry.projectSlug, entry.sessionId)
    setTurns(t)
    setStreamBuffers({})
    setAwaiting(false)
    setCwd(entry.cwd)
    // Continuing should stay on the model the session was already using.
    const was = modelOfTurns(t)
    if (was) setModel(was)
    setMode({ kind: 'archive', entry })
  }, [])

  const resumeSession = useCallback(
    async (entry: HistoryEntry) => {
      const t = await desk.historyRead(entry.projectSlug, entry.sessionId)
      setTurns(t)
      setStreamBuffers({})
      setCwd(entry.cwd)
      const was = modelOfTurns(t)
      if (was) setModel(was)
      setMode({ kind: 'live' })
      await ensureSession(entry.sessionId, entry.cwd)
      setInspectorKey((k) => k + 1)
    },
    [ensureSession],
  )

  const newSession = useCallback(() => {
    setAwaiting(false)
    setTurns([])
    setStreamBuffers({})
    setPermissions([])
    setMode({ kind: 'live' })
    setInfo(null)
  }, [])

  const pickDir = useCallback(async () => {
    const dir = await desk.pickDir()
    if (dir) {
      setCwd(dir)
      newSession()
    }
  }, [newSession])

  // Everything you typed in this session, oldest first, including prompts
  // rehydrated from a resumed transcript.
  const userPrompts = useMemo(
    () =>
      turns
        .filter((t) => t.role === 'user')
        .map((t) => t.blocks.filter((b) => b.kind === 'text').map((b) => (b.kind === 'text' ? b.text : '')).join('\n'))
        .filter((t) => t.trim().length > 0),
    [turns],
  )

  const copyConversation = useCallback(
    () =>
      turns
        .map((t) => {
          const body = t.blocks
            .filter((b) => b.kind === 'text')
            .map((b) => (b.kind === 'text' ? b.text : ''))
            .join('\n\n')
          return `## ${t.role === 'user' ? 'You' : 'Claude'}\n\n${body}`
        })
        .join('\n\n'),
    [turns],
  )

  if (!env) return <div className="boot">Loading...</div>

  const shortCwd = cwd.startsWith(env.home) ? `~${cwd.slice(env.home.length)}` : cwd
  const statusLabel = mode.kind === 'archive' ? 'opened' : (info?.status ?? 'idle')

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-left">
          <span className="app-name">Claude Desk</span>
          <button className="cwd-btn" onClick={() => void pickDir()} title="Change working directory">
            {shortCwd}
          </button>
        </div>
        <div className="titlebar-right">
          <span className={`status status-${statusLabel}`}>{statusLabel}</span>
          <ProfilePicker
            current={profileId}
            refreshKey={profilesKey}
            onChange={(id) => setProfileId(id)}
          />
          <ModelPicker
            current={info?.model ?? model}
            live={info?.status === 'running'}
            onChange={changeModel}
          />
          <CopyButton text={copyConversation} label="Copy conversation" />
          {awaiting && (
            <button className="btn btn-deny" onClick={stop}>
              Stop
            </button>
          )}
        </div>
      </header>

      {!env.claudePath && (
        <div className="banner banner-error">
          Could not find the <code>claude</code> binary. Set <code>CLAUDE_DESK_CLI_PATH</code> and restart.
        </div>
      )}
      {info?.error && <div className="banner banner-error">{info.error}</div>}
      {mode.kind === 'archive' && (
        <div className="banner">
          Viewing <strong>{mode.entry.title}</strong>. Type below to continue this session.
        </div>
      )}

      <div className="body">
        <div className={`leftcol ${sidebarOpen ? '' : 'is-collapsed'}`}>
          {sidebarOpen ? (
            <Sidebar
              home={env.home}
              activeSessionId={mode.kind === 'archive' ? mode.entry.sessionId : info?.sessionId ?? null}
              onOpen={(e) => void openArchive(e)}
              onResume={(e) => void resumeSession(e)}
              onNew={newSession}
              activityKey={inspectorKey}
              onNewInGroup={(gProfileId) => {
                newSession()
                setProfileId(gProfileId ?? null)
              }}
              onClose={toggleSidebar}
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
            <Player />
            <Kroks
              reaction={kroks}
              working={info?.status === 'running' && turns.some((t) => t.streaming === true)}
            />
          </div>
        </div>

        <main className="chat">
          <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
            {!turns.length && (
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
            {turns.map((t) => (
              <TurnView key={t.id} turn={t} streamBuffer={streamBuffers[t.id]} />
            ))}
            {awaiting && !permissions.length && (
              <Thinking
                phase={phaseOf(
                  turns,
                  info?.status === 'starting',
                  Object.values(streamBuffers).some((v) => v.length > 0),
                )}
                since={awaitSince}
                onStop={stop}
              />
            )}
          </div>

          {permissions.length > 0 && (
            <div className="perm-stack">
              {permissions.map((p) => (
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
            value={input}
            onChange={setInput}
            onSubmit={(images) => void submit(images)}
            placeholder={
              mode.kind === 'archive' ? 'Continue this session...' : 'Message Claude...'
            }
            disabled={busy}
            skillsKey={inspectorKey}
            working={awaiting}
            history={userPrompts}
          />
        </main>

        {inspectorOpen ? (
          <Inspector
            refreshKey={inspectorKey}
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
  )
}
