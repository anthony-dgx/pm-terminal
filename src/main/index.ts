import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AgentSession, resolveClaudeExecutable, type SessionOptions } from './agent.js'
import { configSummary, readMcpFromDisk, readPlugins, readSkillsFromDisk } from './inspect.js'
import { clearWarmInspect, warmInspect, type WarmInspect } from './warm.js'
import { cancelMcpLogin, mcpLoginInProgress, sendMcpLoginInput, startMcpLogin } from './mcpAuth.js'
import { listHistory, readTranscript, renameSession } from './sessions.js'
import { readGroups, writeGroups } from './groups.js'
import { defaultCwd, readPlayer, readPrefs, writePlayer, writePrefs } from './prefs.js'
import { serveRenderer } from './server.js'
import { profilePrompt, readProfiles, writeProfiles } from './profiles.js'
import { migrateUserData } from './migrate.js'
import { applyUpdate, cachedStatus, checkForUpdate, CHECK_TICK_MS } from './update.js'
import type {
  AgentProfile,
  Attachment,
  MainEvent,
  PermissionAnswer,
  SessionGroup,
  UpdateProgress,
} from '../shared/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Chromium blocks audible autoplay without a user gesture, which stops the
// music player from resuming the track you already chose. This is a local app
// playing media the user explicitly configured, so opt out.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

/**
 * Live agent sessions keyed by the renderer's conversation id.
 *
 * One session per window was wrong: opening a second conversation tore down
 * the first, and its in-flight output was applied to whatever happened to be
 * on screen. Sessions now run concurrently and every event they emit is
 * tagged, so the renderer can file it against the right conversation.
 */
const sessions = new Map<string, { session: AgentSession; winId: number }>()

function sessionFor(clientId: string): AgentSession | undefined {
  return sessions.get(clientId)?.session
}

/** Set once the local renderer server is up; see serveRenderer for why. */
let rendererUrl: string | null = null

/**
 * Documents handed to a review window, keyed by that window's id.
 *
 * The renderer cannot be given the document at construction time - it boots
 * asynchronously - so it asks for its own payload once mounted.
 */
const readerDocs = new Map<number, ReaderDoc>()

interface ReaderDoc {
  /** Conversation the document came from. The review window sends into it. */
  clientId: string
  title: string
  snapshot: string
  /**
   * The file on disk this was read from, when it was read from one. Doubles as
   * the write permission for that window: `file:write` accepts this path and
   * nothing else, so a review window can save the document it is showing and
   * cannot be talked into writing anywhere else.
   */
  path?: string
}

/** The only files the reader will read or write. It renders nothing else. */
function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(p.trim())
}

interface WindowOptions {
  /** Route the renderer picks up on boot. '#reader' opens the review view. */
  hash?: string
  title?: string
  width?: number
  height?: number
}

function createWindow(opts: WindowOptions = {}): BrowserWindow {
  const win = new BrowserWindow({
    width: opts.width ?? 1500,
    height: opts.height ?? 950,
    // Low enough to sit in a third of a screen. The renderer folds its side
    // panels away as it narrows so the chat stays usable.
    minWidth: 380,
    minHeight: 420,
    title: opts.title ?? 'Atelier',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#14151a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const hash = opts.hash ?? ''
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void win.loadURL(devUrl + hash)
  else if (rendererUrl) void win.loadURL(rendererUrl + hash)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: hash.slice(1) })

  // Only http(s) and mailto reach the real browser; anything else is dropped
  // rather than handed to the OS.
  const openOutside = (url: string): void => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
  }

  const isOwnPage = (url: string): boolean => {
    if (rendererUrl && url.startsWith(new URL(rendererUrl).origin)) return true
    if (devUrl && url.startsWith(devUrl)) return true
    return url.startsWith('file://')
  }

  // window.open and target=_blank.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url)
    return { action: 'deny' }
  })

  // A plain <a href> in rendered markdown has no target, so it navigates the
  // whole window and the app disappears behind a web page. Send it to the
  // browser instead and stay put.
  win.webContents.on('will-navigate', (event, url) => {
    if (isOwnPage(url)) return
    event.preventDefault()
    openOutside(url)
  })

  // Same for a redirect that only reveals its destination mid-flight.
  win.webContents.on('will-redirect', (event, url) => {
    if (isOwnPage(url)) return
    event.preventDefault()
    openOutside(url)
  })

  win.on('closed', () => {
    readerDocs.delete(win.id)
    for (const [clientId, entry] of sessions) {
      if (entry.winId !== win.id) continue
      entry.session.dispose()
      sessions.delete(clientId)
    }
  })

  return win
}

/**
 * Open a document in its own window, tied to the conversation it came from.
 *
 * No session is bound to this window, so closing it cannot dispose the chat's
 * session in the handler above - the review window sends into an existing
 * conversation and never starts one.
 */
function openReaderWindow(doc: ReaderDoc): number {
  const win = createWindow({
    hash: '#reader',
    title: `Review - ${doc.title}`,
    width: 1180,
    height: 900,
  })
  readerDocs.set(win.id, doc)
  return win.id
}

function windowOf(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

/**
 * Fan a session's events out to every window, tagged with its conversation.
 *
 * This used to target the one window that started the session. A review window
 * opened on a document then saw nothing when it sent comments back, because the
 * reply went to the chat window only. Broadcasting is safe: a renderer that
 * does not know the conversation id ignores the event (see `patch` in App.tsx,
 * which no-ops on an unknown id).
 */
function emitterFor(clientId: string): (e: MainEvent) => void {
  return (e) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('main-event', { clientId, event: e })
    }
  }
}

function registerIpc(): void {
  // ---- session lifecycle -------------------------------------------------

  ipcMain.handle('session:start', async (event, clientId: string, opts: SessionOptions) => {
    const win = windowOf(event)
    if (!win) return null
    // Only this conversation is replaced; anything else stays running.
    sessions.get(clientId)?.session.dispose()
    const resolved: SessionOptions = {
      ...opts,
      profilePrompt: (await profilePrompt(opts.profileId)) ?? undefined,
    }
    const session = new AgentSession(resolved, emitterFor(clientId))
    sessions.set(clientId, { session, winId: win.id })
    // Remember the directory so the next launch loads the same local-scope
    // MCP servers instead of starting empty in the home directory.
    void writePrefs({ lastCwd: opts.cwd, lastProfileId: opts.profileId ?? null })
    return session.getInfo()
  })

  // ---- review windows ----------------------------------------------------

  ipcMain.handle('reader:open', (_e, doc: ReaderDoc) => openReaderWindow(doc))

  /** A review window asking which document it was opened on. */
  ipcMain.handle('reader:doc', (event) => {
    const win = windowOf(event)
    return win ? (readerDocs.get(win.id) ?? null) : null
  })

  /** A markdown file, for opening it in the reader. */
  ipcMain.handle('file:readMarkdown', async (_e, path: string) => {
    if (!isMarkdownPath(path)) throw new Error('The reader only opens markdown files.')
    return await readFile(path, 'utf8')
  })

  /**
   * Save an edited document back to the file it came from.
   *
   * Deliberately narrow. The path has to match the one the calling window was
   * opened on, so this cannot be used as a general write - a review window can
   * only ever save its own document, over the file the user already opened.
   */
  ipcMain.handle('file:writeMarkdown', async (event, path: string, text: string) => {
    const win = windowOf(event)
    const doc = win ? readerDocs.get(win.id) : undefined
    if (!doc?.path || resolve(doc.path) !== resolve(path)) {
      throw new Error('This window cannot write to that file.')
    }
    await writeFile(path, text, 'utf8')
    // The window's own record moves with it, so a later save still matches and
    // a reopen does not resurrect the pre-edit text.
    readerDocs.set(win!.id, { ...doc, snapshot: text })
  })

  ipcMain.handle('session:send', (_e, clientId: string, text: string, images?: Attachment[]) => {
    const session = sessionFor(clientId)
    if (!session) throw new Error('No session started for this conversation.')
    session.send(text, images ?? [])
  })

  ipcMain.handle('session:interrupt', (_e, clientId: string) => {
    sessionFor(clientId)?.interrupt()
  })

  ipcMain.handle('session:info', (_e, clientId: string) => sessionFor(clientId)?.getInfo() ?? null)

  ipcMain.handle('session:turns', (_e, clientId: string) => sessionFor(clientId)?.getTurns() ?? [])

  ipcMain.handle('session:models', async (_e, clientId: string) => (await sessionFor(clientId)?.models()) ?? [])

  ipcMain.handle('session:setModel', async (_e, clientId: string, model: string) => {
    void writePrefs({ lastModel: model })
    const session = sessionFor(clientId)
    return session ? session.setModel(model) : null
  })

  ipcMain.handle('permission:answer', (_e, clientId: string, id: string, answer: PermissionAnswer) => {
    sessionFor(clientId)?.answerPermission(id, answer)
  })

  // ---- inspector ---------------------------------------------------------
  // Live data from the running session when there is one, disk config otherwise.

  ipcMain.handle('inspect:mcp', async (_e, clientId: string) => {
    const session = sessionFor(clientId)
    const cwd = session?.getInfo().cwd
    const disk = await readMcpFromDisk(cwd)
    const live = session ? await session.mcpServers() : []
    if (!live.length) return disk

    // The live list is authoritative for what actually loaded, but it omits
    // every local/project server bound to a different directory. Append those
    // so the panel never hides a configured server - just marks it inactive.
    const liveNames = new Set(live.map((s) => s.name))
    const inactive = disk
      .filter((s) => !liveNames.has(s.name))
      .map((s) => ({ ...s, appliesToCwd: false }))
    return [...live.map((s) => ({ ...s, appliesToCwd: true })), ...inactive]
  })

  ipcMain.handle('mcp:reconnect', async (_e, clientId: string, name: string) => {
    const session = sessionFor(clientId)
    if (!session) throw new Error('Start a session before reconnecting an MCP server.')
    return session.reconnectMcp(name)
  })

  // ---- mcp sign-in -------------------------------------------------------
  // Driven by the CLI under a pty, not the SDK. See src/main/mcpAuth.ts for why.
  // Progress goes back on its own channel to the window that asked, so it does
  // not have to be threaded through the per-conversation event union.

  ipcMain.handle('mcp:login', (e, clientId: string, name: string) => {
    const cwd = sessionFor(clientId)?.getInfo().cwd
    const web = e.sender
    startMcpLogin(name, cwd, (event) => {
      if (!web.isDestroyed()) web.send('mcp-login', event)
    })
  })

  ipcMain.handle('mcp:loginInput', (_e, name: string, text: string) => sendMcpLoginInput(name, text))
  ipcMain.handle('mcp:loginCancel', (_e, name: string) => cancelMcpLogin(name))
  ipcMain.handle('mcp:loginActive', () => mcpLoginInProgress())

  // Skills and agents both come from the CLI's own command list. Order of
  // preference: the live session, then a probe of the tab's directory (see
  // warm.ts - a new tab has no session but the user still needs the picker), and
  // only then the thin disk read.
  const warmFor = async (clientId: string, cwd?: string): Promise<WarmInspect | null> =>
    warmInspect(sessionFor(clientId)?.getInfo().cwd ?? cwd ?? (await defaultCwd()))

  ipcMain.handle('inspect:skills', async (_e, clientId: string, cwd?: string) => {
    const live = await sessionFor(clientId)?.skills()
    if (live && live.length) return live
    const warm = await warmFor(clientId, cwd)
    if (warm?.skills.length) return warm.skills
    return readSkillsFromDisk()
  })

  ipcMain.handle('inspect:agents', async (_e, clientId: string, cwd?: string) => {
    const live = await sessionFor(clientId)?.agents()
    if (live && live.length) return live
    return (await warmFor(clientId, cwd))?.agents ?? []
  })

  // The panel's ↻ should genuinely re-ask the CLI rather than re-read a cached
  // probe, which is the difference between it noticing a just-installed plugin
  // and appearing to do nothing.
  ipcMain.handle('inspect:refresh', () => clearWarmInspect())

  ipcMain.handle('inspect:plugins', () => readPlugins())
  ipcMain.handle('inspect:summary', () => configSummary())

  ipcMain.handle('inspect:context', async (_e, clientId: string) => (await sessionFor(clientId)?.contextUsage()) ?? null)

  ipcMain.handle('inspect:usage', (_e, clientId: string) => sessionFor(clientId)?.usage() ?? null)

  // ---- history -----------------------------------------------------------

  ipcMain.handle('history:list', (_e, opts?: { limit?: number; countMessages?: boolean }) => listHistory(opts))
  ipcMain.handle('history:read', (_e, slug: string, sessionId: string) => readTranscript(slug, sessionId))
  ipcMain.handle('history:rename', (_e, sessionId: string, title: string, dir?: string) =>
    renameSession(sessionId, title, dir),
  )

  // ---- session groups ----------------------------------------------------

  ipcMain.handle('profiles:read', () => readProfiles())
  ipcMain.handle('profiles:write', (_e, profiles: AgentProfile[]) => writeProfiles(profiles))

  ipcMain.handle('groups:read', () => readGroups())
  ipcMain.handle('groups:write', (_e, groups: SessionGroup[]) => writeGroups(groups))

  // ---- music player ------------------------------------------------------

  ipcMain.handle('ui:setInspectorOpen', (_e, open: boolean) => writePrefs({ inspectorOpen: open }))
  ipcMain.handle('ui:setSidebarOpen', (_e, open: boolean) => writePrefs({ sidebarOpen: open }))
  ipcMain.handle('ui:setTheme', (_e, theme: string) => writePrefs({ theme }))

  ipcMain.handle('player:read', () => readPlayer())
  ipcMain.handle('player:write', (_e, next: { url?: string; volume?: number }) => writePlayer(next))

  // ---- host helpers ------------------------------------------------------

  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle('dialog:pickDir', async (event) => {
    const win = windowOf(event)
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      defaultPath: homedir(),
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('shell:openPath', (_e, path: string) => shell.openPath(path))
  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))

  // Cheap: reads the baked commit and whatever the last check found. The
  // renderer calls this on boot, then asks for a real check separately.
  ipcMain.handle('update:status', () => cachedStatus())

  ipcMain.handle('update:check', (_e, force: boolean) => checkForUpdate(force))

  ipcMain.handle('update:apply', async (event) => {
    const win = windowOf(event)
    const send = (p: UpdateProgress): void => {
      if (win && !win.isDestroyed()) win.webContents.send('update-progress', p)
    }
    try {
      await applyUpdate(send)
    } catch (err) {
      send({ type: 'done', ok: false, text: (err as Error).message })
      throw err
    }
    // The swap script is waiting on this process to exit before it can replace
    // the bundle we are running from. Give the renderer a moment to paint the
    // last line first.
    setTimeout(() => app.quit(), 800)
  })

  ipcMain.handle('env:info', async () => ({
    home: homedir(),
    defaultCwd: await defaultCwd(),
    defaultModel: (await readPrefs()).lastModel ?? null,
    defaultProfileId: (await readPrefs()).lastProfileId ?? null,
    inspectorOpen: (await readPrefs()).inspectorOpen ?? true,
    sidebarOpen: (await readPrefs()).sidebarOpen ?? true,
    theme: (await readPrefs()).theme ?? 'default',
    claudePath: resolveClaudeExecutable() ?? null,
  }))
}

void app.whenReady().then(async () => {
  // First, before anything reads state. The app was renamed, which moved the
  // userData directory, so this carries the old one's contents across. Doing it
  // after `createWindow` or after the update tick would mean prefs.json had
  // already been written fresh under the new name, and the carry-over would see
  // a file there and skip - losing the theme, the groups and the profiles.
  await migrateUserData()

  registerIpc()

  if (!process.env.ELECTRON_RENDERER_URL) {
    try {
      const { url } = await serveRenderer(join(__dirname, '../renderer'))
      rendererUrl = url
    } catch {
      // Fall back to file:// - everything works except YouTube playback.
    }
  }

  createWindow()

  // Drive the check from here, not from the panel. The row only mounts when the
  // side panel is open, and then only once, so on its own it would mean
  // "checked when you first opened the panel" rather than "on a schedule" - and
  // never at all for someone who keeps the panel closed. The tick is cheap:
  // `checkForUpdate(false)` returns the cached answer without touching the
  // network until CHECK_INTERVAL_MS is up, so the interval below is a sampling
  // rate, not a fetch rate. Both come from update.ts so they cannot drift.
  const tick = (): void => {
    void checkForUpdate(false)
      .then((status) => {
        // Push it, because the row reads its status once at mount. A window
        // left open past the throttle would otherwise keep showing yesterday.
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send('update-status', status)
        }
      })
      .catch(() => {})
  }
  tick()
  setInterval(tick, CHECK_TICK_MS)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  for (const s of sessions.values()) s.session.dispose()
  sessions.clear()
  if (process.platform !== 'darwin') app.quit()
})
