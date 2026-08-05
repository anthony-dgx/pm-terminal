/**
 * Types shared between the main process and the renderer.
 * Kept dependency-free so the preload bridge can import them safely.
 */

export type McpStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'

export interface McpToolInfo {
  name: string
  description?: string
  readOnly?: boolean
  destructive?: boolean
}

export interface McpServerView {
  name: string
  status: McpStatus
  /** 'live' when reported by a running session, 'config' when read off disk. */
  origin: 'live' | 'config'
  transport?: string
  url?: string
  /** 'user' | 'local' | 'project' | 'plugin' | whatever the SDK reports. */
  scope?: string
  /** Directory a local- or project-scope server is bound to. */
  scopeDir?: string
  /** False when the server is configured for a different directory than the session cwd. */
  appliesToCwd?: boolean
  error?: string
  serverVersion?: string
  tools: McpToolInfo[]
  /** Unix ms of the last recorded auth failure, from mcp-needs-auth-cache.json. */
  needsAuthSince?: number
}

export interface SkillView {
  name: string
  description: string
  argumentHint?: string
  aliases?: string[]
  /** Plugin namespace when the name is of the form `plugin:skill`. */
  namespace?: string
  origin: 'live' | 'config'
}

export interface ModelOption {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
}

export interface AgentView {
  name: string
  description: string
  tools?: string[]
  model?: string
}

export interface PluginView {
  name: string
  marketplace: string
  version: string
  scope: string
  installPath: string
  projectPath?: string
  lastUpdated?: string
}

export interface ContextUsageView {
  totalTokens: number
  contextWindow?: number
  categories: { name: string; tokens: number }[]
}

export interface UsageView {
  totalCostUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  turns: number
}

/** A single renderable block inside an assistant turn. */
export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      input: Record<string, unknown>
      /** Full, untruncated tool output. Populated when the tool_result arrives. */
      result?: string
      isError?: boolean
      /** Wall-clock ms from tool_use to tool_result. */
      durationMs?: number
    }

export interface Turn {
  id: string
  role: 'user' | 'assistant' | 'system'
  blocks: Block[]
  /** ISO timestamp. */
  at: string
  /** True while the model is still writing into this turn. */
  streaming?: boolean
  model?: string
}

export interface PermissionRequest {
  id: string
  toolName: string
  input: Record<string, unknown>
  title?: string
  displayName?: string
  decisionReason?: string
  blockedPath?: string
  /** Opaque suggestion payloads passed straight back to the SDK on "always allow". */
  hasSuggestions: boolean
}

export type PermissionAnswer =
  | { behavior: 'allow'; remember?: boolean }
  | { behavior: 'deny'; message?: string; interrupt?: boolean }

export type SessionStatus = 'idle' | 'starting' | 'running' | 'error' | 'closed'

export interface SessionInfo {
  sessionId: string | null
  cwd: string
  model: string | null
  status: SessionStatus
  error?: string
}

/** A previously recorded Claude Code session, read from ~/.claude/projects. */
export interface HistoryEntry {
  sessionId: string
  projectSlug: string
  cwd: string
  title: string
  firstPrompt: string
  modifiedMs: number
  sizeBytes: number
  messageCount: number
}

/** Chrome-tab-group style colors. */
export const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'grey'] as const
export type GroupColor = (typeof GROUP_COLORS)[number]

export interface SessionGroup {
  id: string
  name: string
  color: GroupColor
  collapsed: boolean
  /** Session IDs in user-defined order. */
  sessionIds: string[]
  /** Profile applied to new sessions started from this group. */
  profileId?: string | null
}

/**
 * A reusable starting prompt for an agent. The prompt is appended to Claude
 * Code's own system prompt rather than replacing it.
 */
export interface AgentProfile {
  id: string
  name: string
  description: string
  prompt: string
  /** Optional model the profile prefers. */
  model?: string | null
  /** Shipped with the app; still editable and deletable. */
  builtIn?: boolean
  createdAt: string
  updatedAt: string
}

export type MainEvent =
  | { type: 'turn'; turn: Turn }
  | { type: 'turn-delta'; turnId: string; text: string }
  | { type: 'session'; info: SessionInfo }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'permission-resolved'; id: string }
  | { type: 'inspector-dirty' }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
