import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentSession, resolveClaudeExecutable, type SessionOptions } from './agent.js'
import { configSummary, readMcpFromDisk, readPlugins, readSkillsFromDisk } from './inspect.js'
import { listHistory, readTranscript, renameSession } from './sessions.js'
import { readGroups, writeGroups } from './groups.js'
import { defaultCwd, readPlayer, readPrefs, writePlayer, writePrefs } from './prefs.js'
import { serveRenderer } from './server.js'
import { profilePrompt, readProfiles, writeProfiles } from './profiles.js'
import type { AgentProfile, MainEvent, PermissionAnswer, SessionGroup } from '../shared/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Chromium blocks audible autoplay without a user gesture, which stops the
// music player from resuming the track you already chose. This is a local app
// playing media the user explicitly configured, so opt out.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

/** One live agent session per window. */
const sessions = new Map<number, AgentSession>()

/** Set once the local renderer server is up; see serveRenderer for why. */
let rendererUrl: string | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1000,
    minHeight: 600,
    title: 'Claude Desk',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#14151a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void win.loadURL(devUrl)
  else if (rendererUrl) void win.loadURL(rendererUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

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
    sessions.get(win.id)?.dispose()
    sessions.delete(win.id)
  })

  return win
}

function windowOf(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function emitterFor(win: BrowserWindow): (e: MainEvent) => void {
  return (e) => {
    if (!win.isDestroyed()) win.webContents.send('main-event', e)
  }
}

function registerIpc(): void {
  // ---- session lifecycle -------------------------------------------------

  ipcMain.handle('session:start', async (event, opts: SessionOptions) => {
    const win = windowOf(event)
    if (!win) return null
    sessions.get(win.id)?.dispose()
    const resolved: SessionOptions = {
      ...opts,
      profilePrompt: (await profilePrompt(opts.profileId)) ?? undefined,
    }
    const session = new AgentSession(resolved, emitterFor(win))
    sessions.set(win.id, session)
    // Remember the directory so the next launch loads the same local-scope
    // MCP servers instead of starting empty in the home directory.
    void writePrefs({ lastCwd: opts.cwd, lastProfileId: opts.profileId ?? null })
    return session.getInfo()
  })

  ipcMain.handle('session:send', (event, text: string) => {
    const win = windowOf(event)
    if (!win) return
    const session = sessions.get(win.id)
    if (!session) throw new Error('No session started for this window.')
    session.send(text)
  })

  ipcMain.handle('session:interrupt', (event) => {
    const win = windowOf(event)
    if (win) sessions.get(win.id)?.interrupt()
  })

  ipcMain.handle('session:info', (event) => {
    const win = windowOf(event)
    return win ? (sessions.get(win.id)?.getInfo() ?? null) : null
  })

  ipcMain.handle('session:turns', (event) => {
    const win = windowOf(event)
    return win ? (sessions.get(win.id)?.getTurns() ?? []) : []
  })

  ipcMain.handle('session:models', async (event) => {
    const win = windowOf(event)
    return win ? ((await sessions.get(win.id)?.models()) ?? []) : []
  })

  ipcMain.handle('session:setModel', async (event, model: string) => {
    const win = windowOf(event)
    if (!win) return null
    void writePrefs({ lastModel: model })
    const session = sessions.get(win.id)
    return session ? session.setModel(model) : null
  })

  ipcMain.handle('permission:answer', (event, id: string, answer: PermissionAnswer) => {
    const win = windowOf(event)
    if (win) sessions.get(win.id)?.answerPermission(id, answer)
  })

  // ---- inspector ---------------------------------------------------------
  // Live data from the running session when there is one, disk config otherwise.

  ipcMain.handle('inspect:mcp', async (event) => {
    const win = windowOf(event)
    const session = win ? sessions.get(win.id) : undefined
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

  ipcMain.handle('mcp:reconnect', async (event, name: string) => {
    const win = windowOf(event)
    const session = win ? sessions.get(win.id) : undefined
    if (!session) throw new Error('Start a session before reconnecting an MCP server.')
    return session.reconnectMcp(name)
  })

  ipcMain.handle('inspect:skills', async (event) => {
    const win = windowOf(event)
    const live = win ? await sessions.get(win.id)?.skills() : undefined
    if (live && live.length) return live
    return readSkillsFromDisk()
  })

  ipcMain.handle('inspect:agents', async (event) => {
    const win = windowOf(event)
    return win ? ((await sessions.get(win.id)?.agents()) ?? []) : []
  })

  ipcMain.handle('inspect:plugins', () => readPlugins())
  ipcMain.handle('inspect:summary', () => configSummary())

  ipcMain.handle('inspect:context', async (event) => {
    const win = windowOf(event)
    return win ? ((await sessions.get(win.id)?.contextUsage()) ?? null) : null
  })

  ipcMain.handle('inspect:usage', (event) => {
    const win = windowOf(event)
    return win ? (sessions.get(win.id)?.usage() ?? null) : null
  })

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

  ipcMain.handle('env:info', async () => ({
    home: homedir(),
    defaultCwd: await defaultCwd(),
    defaultModel: (await readPrefs()).lastModel ?? null,
    defaultProfileId: (await readPrefs()).lastProfileId ?? null,
    inspectorOpen: (await readPrefs()).inspectorOpen ?? true,
    claudePath: resolveClaudeExecutable() ?? null,
  }))
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
  for (const s of sessions.values()) s.dispose()
  sessions.clear()
  if (process.platform !== 'darwin') app.quit()
})
