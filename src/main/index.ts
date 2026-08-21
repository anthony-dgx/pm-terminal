import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentSession, resolveClaudeExecutable, type SessionOptions } from './agent.js'
import { configSummary, readMcpFromDisk, readPlugins, readSkillsFromDisk } from './inspect.js'
import { cancelMcpLogin, mcpLoginInProgress, sendMcpLoginInput, startMcpLogin } from './mcpAuth.js'
import { listHistory, readTranscript, renameSession } from './sessions.js'
import { readGroups, writeGroups } from './groups.js'
import { defaultCwd, readPlayer, readPrefs, writePlayer, writePrefs } from './prefs.js'
import { serveRenderer } from './server.js'
import { profilePrompt, readProfiles, writeProfiles } from './profiles.js'
import {
  activeProvider,
  listProviders,
  providerEnv,
  providerModel,
  removeProvider,
  saveProvider,
  setActiveProvider,
} from './providers.js'
import type {
  AgentProfile,
  Attachment,
  MainEvent,
  PermissionAnswer,
  ProviderInput,
  SessionGroup,
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
    title: opts.title ?? 'Claude Desk',
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
    // The provider is resolved here rather than in the renderer, so the token
    // never crosses the IPC boundary.
    const provider = await activeProvider()
    const resolved: SessionOptions = {
      ...opts,
      profilePrompt: (await profilePrompt(opts.profileId)) ?? undefined,
      ...(provider
        ? {
            env: providerEnv(provider),
            modelOptions: provider.models,
            // Any name the provider does not list is replaced by its first.
            // Two ways a foreign one arrives: nothing was picked, so the CLI
            // would fall back to its own Claude default; or the conversation is
            // being resumed and carries the model its transcript was written
            // with, which belongs to whichever endpoint was active back then.
            // Either way the provider has never heard of it.
            model: providerModel(provider, opts.model),
          }
        : {}),
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
    // Tagged with the provider it belongs to. `env:info` only offers it back as
    // the default when that provider is still the active one.
    void writePrefs({ lastModel: model, lastModelProviderId: (await readPrefs()).activeProviderId ?? null })
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

  ipcMain.handle('inspect:skills', async (_e, clientId: string) => {
    const live = await sessionFor(clientId)?.skills()
    if (live && live.length) return live
    return readSkillsFromDisk()
  })

  ipcMain.handle('inspect:agents', async (_e, clientId: string) => (await sessionFor(clientId)?.agents()) ?? [])

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

  // ---- model providers ---------------------------------------------------
  // Note that `providers:*` never returns a token. `listProviders` reports only
  // whether one is stored.

  ipcMain.handle('providers:list', () => listProviders())
  ipcMain.handle('providers:save', (_e, input: ProviderInput) => saveProvider(input))
  ipcMain.handle('providers:remove', (_e, id: string) => removeProvider(id))
  ipcMain.handle('providers:setActive', (_e, id: string | null) => setActiveProvider(id))

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

  ipcMain.handle('env:info', async () => {
    const prefs = await readPrefs()
    const activeProviderId = prefs.activeProviderId ?? null
    return {
      home: homedir(),
      defaultCwd: await defaultCwd(),
      // Only offered back when it belongs to the provider still in use. A GPT
      // name remembered from a proxy session would fail against Anthropic, and
      // the reverse fails too.
      defaultModel:
        (prefs.lastModelProviderId ?? null) === activeProviderId ? (prefs.lastModel ?? null) : null,
      defaultProfileId: prefs.lastProfileId ?? null,
      inspectorOpen: prefs.inspectorOpen ?? true,
      sidebarOpen: prefs.sidebarOpen ?? true,
      theme: prefs.theme ?? 'default',
      claudePath: resolveClaudeExecutable() ?? null,
      activeProviderId,
    }
  })
}

void app.whenReady().then(async () => {
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  for (const s of sessions.values()) s.session.dispose()
  sessions.clear()
  if (process.platform !== 'darwin') app.quit()
})
