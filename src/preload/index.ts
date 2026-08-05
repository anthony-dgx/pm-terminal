import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentProfile,
  Attachment,
  AgentView,
  ContextUsageView,
  HistoryEntry,
  MainEvent,
  ModelOption,
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
  startSession(opts: {
    cwd: string
    model?: string
    resume?: string
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    profileId?: string | null
  }): Promise<SessionInfo | null>
  send(text: string, images?: Attachment[]): Promise<void>
  interrupt(): Promise<void>
  sessionInfo(): Promise<SessionInfo | null>
  sessionTurns(): Promise<Turn[]>
  answerPermission(id: string, answer: PermissionAnswer): Promise<void>
  models(): Promise<ModelOption[]>
  setModel(model: string): Promise<SessionInfo | null>

  mcp(): Promise<McpServerView[]>
  reconnectMcp(name: string): Promise<McpServerView[]>
  skills(): Promise<SkillView[]>
  agents(): Promise<AgentView[]>
  plugins(): Promise<PluginView[]>
  contextUsage(): Promise<ContextUsageView | null>
  usage(): Promise<UsageView | null>
  summary(): Promise<{ settingsBytes: number; historyBytes: number }>

  historyList(opts?: { limit?: number; countMessages?: boolean }): Promise<HistoryEntry[]>
  historyRead(slug: string, sessionId: string): Promise<Turn[]>
  historyRename(sessionId: string, title: string, dir?: string): Promise<void>

  profilesRead(): Promise<AgentProfile[]>
  profilesWrite(profiles: AgentProfile[]): Promise<void>

  groupsRead(): Promise<SessionGroup[]>
  groupsWrite(groups: SessionGroup[]): Promise<void>

  setInspectorOpen(open: boolean): Promise<void>
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
    claudePath: string | null
  }>

  onEvent(cb: (e: MainEvent) => void): () => void
}

const api: DeskApi = {
  startSession: (opts) => ipcRenderer.invoke('session:start', opts),
  send: (text, images) => ipcRenderer.invoke('session:send', text, images),
  interrupt: () => ipcRenderer.invoke('session:interrupt'),
  sessionInfo: () => ipcRenderer.invoke('session:info'),
  sessionTurns: () => ipcRenderer.invoke('session:turns'),
  answerPermission: (id, answer) => ipcRenderer.invoke('permission:answer', id, answer),
  models: () => ipcRenderer.invoke('session:models'),
  setModel: (model) => ipcRenderer.invoke('session:setModel', model),

  mcp: () => ipcRenderer.invoke('inspect:mcp'),
  reconnectMcp: (name) => ipcRenderer.invoke('mcp:reconnect', name),
  skills: () => ipcRenderer.invoke('inspect:skills'),
  agents: () => ipcRenderer.invoke('inspect:agents'),
  plugins: () => ipcRenderer.invoke('inspect:plugins'),
  contextUsage: () => ipcRenderer.invoke('inspect:context'),
  usage: () => ipcRenderer.invoke('inspect:usage'),
  summary: () => ipcRenderer.invoke('inspect:summary'),

  historyList: (opts) => ipcRenderer.invoke('history:list', opts),
  historyRead: (slug, sessionId) => ipcRenderer.invoke('history:read', slug, sessionId),
  historyRename: (sessionId, title, dir) => ipcRenderer.invoke('history:rename', sessionId, title, dir),

  profilesRead: () => ipcRenderer.invoke('profiles:read'),
  profilesWrite: (profiles) => ipcRenderer.invoke('profiles:write', profiles),

  groupsRead: () => ipcRenderer.invoke('groups:read'),
  groupsWrite: (groups) => ipcRenderer.invoke('groups:write', groups),

  setInspectorOpen: (open) => ipcRenderer.invoke('ui:setInspectorOpen', open),
  playerRead: () => ipcRenderer.invoke('player:read'),
  playerWrite: (next) => ipcRenderer.invoke('player:write', next),

  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  openPath: (path) => ipcRenderer.invoke('shell:openPath', path),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  env: () => ipcRenderer.invoke('env:info'),

  onEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: MainEvent): void => cb(payload)
    ipcRenderer.on('main-event', listener)
    return () => ipcRenderer.off('main-event', listener)
  },
}

contextBridge.exposeInMainWorld('desk', api)
