import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentProfile,
  Attachment,
  AgentView,
  ContextUsageView,
  HistoryEntry,
  MainEvent,
  ModelOption,
  McpLoginEvent,
  McpServerView,
  PermissionAnswer,
  PluginView,
  SessionGroup,
  SessionInfo,
  SkillView,
  Turn,
  UsageView,
} from '../shared/types.js'

export interface DeskApi {
  /** Every per-session call is scoped by the renderer's conversation id. */
  startSession(clientId: string, opts: {
    cwd: string
    model?: string
    resume?: string
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    profileId?: string | null
  }): Promise<SessionInfo | null>
  send(clientId: string, text: string, images?: Attachment[]): Promise<void>
  interrupt(clientId: string): Promise<void>
  sessionInfo(clientId: string): Promise<SessionInfo | null>
  sessionTurns(clientId: string): Promise<Turn[]>
  answerPermission(clientId: string, id: string, answer: PermissionAnswer): Promise<void>
  models(clientId: string): Promise<ModelOption[]>
  setModel(clientId: string, model: string): Promise<SessionInfo | null>

  mcp(clientId: string): Promise<McpServerView[]>
  reconnectMcp(clientId: string, name: string): Promise<McpServerView[]>
  /** Start `claude mcp login <name>`. Progress arrives through `onMcpLogin`. */
  mcpLogin(clientId: string, name: string): Promise<void>
  /** Answer the CLI's "paste the redirect URL" prompt. */
  mcpLoginInput(name: string, text: string): Promise<void>
  mcpLoginCancel(name: string): Promise<void>
  /** Name of the server currently signing in, or null. */
  mcpLoginActive(): Promise<string | null>
  onMcpLogin(cb: (e: McpLoginEvent) => void): () => void
  skills(clientId: string): Promise<SkillView[]>
  agents(clientId: string): Promise<AgentView[]>
  plugins(): Promise<PluginView[]>
  contextUsage(clientId: string): Promise<ContextUsageView | null>
  usage(clientId: string): Promise<UsageView | null>
  summary(): Promise<{ settingsBytes: number; historyBytes: number }>

  historyList(opts?: { limit?: number; countMessages?: boolean }): Promise<HistoryEntry[]>
  historyRead(slug: string, sessionId: string): Promise<Turn[]>
  historyRename(sessionId: string, title: string, dir?: string): Promise<void>

  profilesRead(): Promise<AgentProfile[]>
  profilesWrite(profiles: AgentProfile[]): Promise<void>

  groupsRead(): Promise<SessionGroup[]>
  groupsWrite(groups: SessionGroup[]): Promise<void>

  setInspectorOpen(open: boolean): Promise<void>
  setSidebarOpen(open: boolean): Promise<void>
  setTheme(theme: string): Promise<void>
  playerRead(): Promise<{ url?: string; volume?: number }>
  playerWrite(next: { url?: string; volume?: number }): Promise<void>

  copy(text: string): Promise<void>
  pickDir(): Promise<string | null>
  openPath(path: string): Promise<string>
  openExternal(url: string): Promise<void>
  env(): Promise<{
    home: string
    defaultCwd: string
    defaultModel: string | null
    defaultProfileId: string | null
    inspectorOpen: boolean
    sidebarOpen: boolean
    theme: string
    claudePath: string | null
  }>

  /** Open a document in its own window, tied to the calling conversation. */
  readerOpen(doc: { clientId: string; title: string; snapshot: string }): Promise<number>
  /** Which document this window was opened on; null in the main window. */
  readerDoc(): Promise<{ clientId: string; title: string; snapshot: string } | null>

  onEvent(cb: (clientId: string, e: MainEvent) => void): () => void
}

const api: DeskApi = {
  startSession: (clientId, opts) => ipcRenderer.invoke('session:start', clientId, opts),
  send: (clientId, text, images) => ipcRenderer.invoke('session:send', clientId, text, images),
  interrupt: (clientId) => ipcRenderer.invoke('session:interrupt', clientId),
  sessionInfo: (clientId) => ipcRenderer.invoke('session:info', clientId),
  sessionTurns: (clientId) => ipcRenderer.invoke('session:turns', clientId),
  answerPermission: (clientId, id, answer) => ipcRenderer.invoke('permission:answer', clientId, id, answer),
  models: (clientId) => ipcRenderer.invoke('session:models', clientId),
  setModel: (clientId, model) => ipcRenderer.invoke('session:setModel', clientId, model),

  mcp: (clientId) => ipcRenderer.invoke('inspect:mcp', clientId),
  reconnectMcp: (clientId, name) => ipcRenderer.invoke('mcp:reconnect', clientId, name),
  mcpLogin: (clientId, name) => ipcRenderer.invoke('mcp:login', clientId, name),
  mcpLoginInput: (name, text) => ipcRenderer.invoke('mcp:loginInput', name, text),
  mcpLoginCancel: (name) => ipcRenderer.invoke('mcp:loginCancel', name),
  mcpLoginActive: () => ipcRenderer.invoke('mcp:loginActive'),
  onMcpLogin: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, event: McpLoginEvent): void => cb(event)
    ipcRenderer.on('mcp-login', listener)
    return () => ipcRenderer.off('mcp-login', listener)
  },
  skills: (clientId) => ipcRenderer.invoke('inspect:skills', clientId),
  agents: (clientId) => ipcRenderer.invoke('inspect:agents', clientId),
  plugins: () => ipcRenderer.invoke('inspect:plugins'),
  contextUsage: (clientId) => ipcRenderer.invoke('inspect:context', clientId),
  usage: (clientId) => ipcRenderer.invoke('inspect:usage', clientId),
  summary: () => ipcRenderer.invoke('inspect:summary'),

  historyList: (opts) => ipcRenderer.invoke('history:list', opts),
  historyRead: (slug, sessionId) => ipcRenderer.invoke('history:read', slug, sessionId),
  historyRename: (sessionId, title, dir) => ipcRenderer.invoke('history:rename', sessionId, title, dir),

  profilesRead: () => ipcRenderer.invoke('profiles:read'),
  profilesWrite: (profiles) => ipcRenderer.invoke('profiles:write', profiles),

  groupsRead: () => ipcRenderer.invoke('groups:read'),
  groupsWrite: (groups) => ipcRenderer.invoke('groups:write', groups),

  setInspectorOpen: (open) => ipcRenderer.invoke('ui:setInspectorOpen', open),
  setSidebarOpen: (open) => ipcRenderer.invoke('ui:setSidebarOpen', open),
  setTheme: (theme) => ipcRenderer.invoke('ui:setTheme', theme),
  playerRead: () => ipcRenderer.invoke('player:read'),
  playerWrite: (next) => ipcRenderer.invoke('player:write', next),

  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  openPath: (path) => ipcRenderer.invoke('shell:openPath', path),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  env: () => ipcRenderer.invoke('env:info'),

  readerOpen: (doc) => ipcRenderer.invoke('reader:open', doc),
  readerDoc: () => ipcRenderer.invoke('reader:doc'),

  onEvent: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: { clientId: string; event: MainEvent },
    ): void => cb(payload.clientId, payload.event)
    ipcRenderer.on('main-event', listener)
    return () => ipcRenderer.off('main-event', listener)
  },
}

contextBridge.exposeInMainWorld('desk', api)
