import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { envVar } from './env.js'
import { toAgentViews, toSkillViews } from './commandViews.js'
import { gatewayInstalled, gatewayModels, gatewayShim } from './gateway.js'
import { isGatewayModel } from '../shared/gateway.js'
import {
  query,
  type Query,
  type PermissionMode,
  type SDKMessage,
  type SDKUserMessage,
  type PermissionResult,
  type PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentView,
  Attachment,
  ModelOption,
  Block,
  ContextUsageView,
  MainEvent,
  McpServerView,
  PermissionAnswer,
  PermissionRequest,
  SessionInfo,
  SkillView,
  Turn,
  UsageView,
} from '../shared/types.js'

/**
 * Native Claude models, for when the real list cannot be fetched: before a
 * session exists, or from a gateway session. The SDK resolves these aliases to
 * whatever the current generation is.
 */
const NATIVE_ALIASES: ModelOption[] = [
  { value: 'opus', displayName: 'Opus', description: 'Most capable' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Balanced' },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest' },
]

/** The model list for a conversation that has no session yet. */
export function defaultModels(): ModelOption[] {
  return [...NATIVE_ALIASES, ...gatewayModels()]
}

/**
 * Resolve the real `claude` binary. A packaged Electron app inherits a stripped
 * PATH from launchd, so `which claude` alone is not enough - fall back to the
 * install locations Claude Code actually uses.
 */
export function resolveClaudeExecutable(): string | undefined {
  const configured = envVar('CLI_PATH')
  if (configured && existsSync(configured)) return configured
  try {
    // A login shell picks up nvm/asdf shims that the GUI process never sees.
    const found = execFileSync('/bin/zsh', ['-lic', 'which claude'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n')
      .pop()
    if (found && existsSync(found)) return found
  } catch {
    // fall through to the static candidates
  }
  const candidates = [
    join(homedir(), '.local/bin/claude'),
    join(homedir(), '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]
  return candidates.find((p) => existsSync(p))
}

/**
 * The login shell's PATH, so the spawned `claude` subprocess can find things
 * like an `apiKeyHelper` script (e.g. a Homebrew-installed CLI). Without this
 * it inherits launchd's stripped PATH, and helper commands that work fine in
 * a terminal fail silently inside the packaged app.
 */
function resolveLoginPath(): string | undefined {
  try {
    const found = execFileSync('/bin/zsh', ['-lic', 'echo $PATH'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return found || undefined
  } catch {
    return undefined
  }
}

/**
 * Say which backend refused, when a backend refuses.
 *
 * A gateway session's failures do not come from Anthropic: they come from the
 * Datadog AI Gateway, whose quota is shared with everyone else on the same POC
 * and which returns 429 long before your own account would. The CLI's message
 * says "rate limit" and nothing about where, so the app reported what looked
 * like Claude throttling you and the only way to tell the difference was to read
 * 276MB of proxy log. A 500 has the same problem for the opposite reason: the
 * local proxy failing to resolve the gateway host looks identical to Claude
 * being down.
 *
 * Prefixing is all this does. The CLI's own text is kept, because it carries the
 * retry-after and the request id.
 */
function nameTheBackend(text: string, model: string | null | undefined): string {
  if (!isGatewayModel(model)) return text
  const rateLimited = /\b429\b|rate.?limit|too many requests/i.test(text)
  const unavailable = /\b5\d\d\b|internal server error|nodename nor servname|econnrefused/i.test(
    text,
  )
  if (rateLimited) return `Datadog AI Gateway rate limit (shared quota, not your Claude account) - ${text}`
  if (unavailable) return `Datadog AI Gateway proxy failed, not Claude - ${text}`
  return text
}

/**
 * Async iterable the SDK pulls user messages from. Streaming-input mode is
 * required for `canUseTool` to work, so every session uses it even for the
 * first prompt.
 */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = []
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null
  private closed = false

  push(text: string, sessionId: string | null, images: Attachment[] = []): void {
    if (this.closed) return
    // Images go first so the text can refer to them.
    const content = images.length
      ? [
          ...images.map((a) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: a.mediaType, data: a.data },
          })),
          ...(text ? [{ type: 'text' as const, text }] : []),
        ]
      : text
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content } as SDKUserMessage['message'],
      parent_tool_use_id: null,
      session_id: sessionId ?? '',
      // The SDK fills in a real uuid; this keeps the type satisfied.
      uuid: randomUUID() as SDKUserMessage['uuid'],
    } as SDKUserMessage
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: msg, done: false })
    } else {
      this.pending.push(msg)
    }
  }

  close(): void {
    this.closed = true
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const next = this.pending.shift()
        if (next) return Promise.resolve({ value: next, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((res) => {
          this.waiter = res
        })
      },
    }
  }
}

export interface SessionOptions {
  cwd: string
  model?: string
  resume?: string
  /**
   * Taken straight from the SDK rather than restated, because the list grows:
   * `'auto'` and `'dontAsk'` were both added after this app first spelled it out
   * by hand, and Auto-mode is `'auto'`.
   */
  permissionMode?: PermissionMode
  /** Id of the agent profile to apply; resolved to a prompt in the main process. */
  profileId?: string | null
  /** Resolved profile text, appended to Claude Code's system prompt. */
  profilePrompt?: string
}

interface PendingPermission {
  resolve: (r: PermissionResult) => void
  suggestions?: PermissionUpdate[]
}

/**
 * Owns one live Claude Code session: the SDK query loop, the message-to-Turn
 * translation, and the permission round-trip with the renderer.
 */
export class AgentSession {
  private q: Query | null = null
  private queue = new PromptQueue()
  private pumping = false
  private permissions = new Map<string, PendingPermission>()
  /** Maps tool_use_id -> the turn holding that tool block, for result stitching. */
  private toolIndex = new Map<string, { turn: Turn; block: Extract<Block, { kind: 'tool' }>; startedMs: number }>()
  /** Guards against an assistant message being applied twice on redelivery. */
  private seenAssistantMsgs = new Set<string>()
  private tally: UsageView = { totalCostUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0 }
  private turns: Turn[] = []
  private info: SessionInfo
  private opts: SessionOptions
  /**
   * The model the live process was actually spawned on, which is what gateway
   * routing was fixed to. Not the same as `opts.model` once a switch has been
   * refused: that holds the pick being saved for next time. Comparing against
   * `opts.model` would then refuse a later native-to-native switch too.
   */
  private spawnedModel: string | null = null
  private emit: (e: MainEvent) => void

  constructor(opts: SessionOptions, emit: (e: MainEvent) => void) {
    this.opts = opts
    this.emit = emit
    this.info = { sessionId: opts.resume ?? null, cwd: opts.cwd, model: opts.model ?? null, status: 'idle' }
  }

  getInfo(): SessionInfo {
    return this.info
  }

  getTurns(): Turn[] {
    return this.turns
  }

  private setStatus(status: SessionInfo['status'], error?: string): void {
    this.info = { ...this.info, status, error }
    this.emit({ type: 'session', info: this.info })
  }

  /** Send a prompt. Starts the query loop on first call. */
  send(text: string, images: Attachment[] = []): void {
    const turn: Turn = {
      id: randomUUID(),
      role: 'user',
      blocks: [
        ...images.map((a) => ({ kind: 'image' as const, mediaType: a.mediaType, data: a.data })),
        ...(text ? [{ kind: 'text' as const, text }] : []),
      ],
      at: new Date().toISOString(),
    }
    this.turns.push(turn)
    this.emit({ type: 'turn', turn })

    this.queue.push(text, this.info.sessionId, images)
    if (!this.q) this.start()
  }

  private start(): void {
    const executable = resolveClaudeExecutable()
    if (!executable) {
      this.setStatus('error', 'Could not find the `claude` binary. Set ATELIER_CLI_PATH and restart.')
      return
    }

    // A gateway model runs the real binary through the AI Gateway proxy's process
    // wrapper rather than directly. The wrapper owns provider routing, including
    // which model answers, so `--model` must not also be passed: the two would
    // disagree and the flag would win with a name the gateway does not know.
    const wantsGateway = isGatewayModel(this.opts.model)
    const shim = wantsGateway ? gatewayShim(this.opts.model as string, executable) : null
    if (wantsGateway && !shim) {
      this.setStatus(
        'error',
        gatewayInstalled()
          ? 'The Datadog AI Gateway proxy no longer offers that model. Pick another one.'
          : 'That model needs the Datadog AI Gateway proxy, which is not installed. Install it, then pick the model again.',
      )
      return
    }

    this.setStatus('starting')
    const loginPath = resolveLoginPath()
    this.spawnedModel = this.opts.model ?? null
    this.q = query({
      prompt: this.queue,
      options: {
        cwd: this.opts.cwd,
        model: shim ? undefined : this.opts.model,
        resume: this.opts.resume,
        permissionMode: this.opts.permissionMode ?? 'default',
        pathToClaudeCodeExecutable: shim ?? executable,
        // The login PATH matters doubly for a gateway session: the proxy's auth
        // preflight shells out to `ddtool`, which launchd's stripped PATH does
        // not have either.
        ...(loginPath ? { env: { ...process.env, PATH: loginPath } } : {}),
        // Append rather than replace: substituting the preset would drop Claude
        // Code's own tool and skill guidance.
        ...(this.opts.profilePrompt
          ? {
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: this.opts.profilePrompt,
              },
            }
          : {}),
        // Without this the SDK loads no config at all: no CLAUDE.md, no user
        // skills, no plugins, no MCP servers. This app is specifically for
        // reviewing those, so all three sources are on.
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        canUseTool: this.handlePermission,
        stderr: (data) => {
          if (data.trim())
            this.emit({
              type: 'notice',
              level: 'warn',
              text: nameTheBackend(data.trim(), this.opts.model),
            })
        },
      },
    })

    void this.pump()
  }

  private handlePermission = (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal
      suggestions?: PermissionUpdate[]
      blockedPath?: string
      decisionReason?: string
      title?: string
      displayName?: string
    },
  ): Promise<PermissionResult> => {
    const id = randomUUID()
    const request: PermissionRequest = {
      id,
      toolName,
      input,
      title: options.title,
      displayName: options.displayName,
      decisionReason: options.decisionReason,
      blockedPath: options.blockedPath,
      hasSuggestions: Boolean(options.suggestions?.length),
    }

    return new Promise<PermissionResult>((resolve) => {
      this.permissions.set(id, { resolve, suggestions: options.suggestions })
      const onAbort = (): void => {
        if (this.permissions.delete(id)) {
          this.emit({ type: 'permission-resolved', id })
          resolve({ behavior: 'deny', message: 'Session interrupted.' })
        }
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
      this.emit({ type: 'permission', request })
    })
  }

  /**
   * Switch this session between asking and Auto-mode, without restarting it.
   *
   * Written to `opts` as well as pushed to the live query: `opts` is what
   * `start()` reads, so a session that has not sent its first message yet - and
   * one that is later restarted by `session:clear` - picks up the same mode. The
   * SDK's setter only exists in streaming input mode, which is what the
   * `PromptQueue` makes this, and only once the query has been built.
   */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.opts = { ...this.opts, permissionMode: mode }
    try {
      await this.q?.setPermissionMode(mode)
    } catch (err) {
      // A refused switch must not take the app down with it. The next start
      // reads `opts`, so the setting is not lost either.
      this.emit({
        type: 'notice',
        level: 'warn',
        text: `Could not switch permission mode: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  /** Called from IPC when the user clicks allow/deny in the renderer. */
  answerPermission(id: string, answer: PermissionAnswer): void {
    const pending = this.permissions.get(id)
    if (!pending) return
    this.permissions.delete(id)
    this.emit({ type: 'permission-resolved', id })

    if (answer.behavior === 'allow') {
      pending.resolve({
        behavior: 'allow',
        // "Always allow" replays the SDK's own rule suggestions verbatim, which
        // is what writes the permission into settings for future turns.
        updatedPermissions: answer.remember ? pending.suggestions : undefined,
      })
    } else {
      pending.resolve({
        behavior: 'deny',
        message: answer.message ?? 'Denied by user.',
        interrupt: answer.interrupt,
      })
    }
  }

  private currentAssistantTurn(): Turn {
    const last = this.turns[this.turns.length - 1]
    if (last && last.role === 'assistant' && last.streaming) return last
    const turn: Turn = {
      id: randomUUID(),
      role: 'assistant',
      blocks: [],
      at: new Date().toISOString(),
      streaming: true,
    }
    this.turns.push(turn)
    this.emit({ type: 'turn', turn })
    return turn
  }

  private async pump(): Promise<void> {
    if (!this.q || this.pumping) return
    this.pumping = true
    try {
      for await (const msg of this.q) {
        this.handleMessage(msg)
      }
      this.setStatus('closed')
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      this.setStatus('error', nameTheBackend(text, this.opts.model))
    } finally {
      this.pumping = false
    }
  }

  private handleMessage(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system': {
        if ('subtype' in msg && msg.subtype === 'init') {
          this.info = {
            ...this.info,
            sessionId: msg.session_id,
            // An explicit pick wins: the CLI can re-send `init` mid-session and
            // report the model it started on, which would silently undo it.
            model: this.opts.model ?? ('model' in msg ? String(msg.model) : this.info.model),
            status: 'running',
          }
          this.emit({ type: 'session', info: this.info })
          this.emit({ type: 'inspector-dirty' })
        }
        /*
         * A tool refused without ever reaching a person: the Auto-mode
         * classifier said no, or a deny rule matched. There is no permission
         * prompt for these - the SDK short-circuits `canUseTool` - so if this is
         * dropped the user sees a tool fail for no stated reason, which is worse
         * than not having Auto-mode at all. Surfaced as a warning notice, the
         * same channel stderr already uses.
         */
        if ('subtype' in msg && msg.subtype === 'permission_denied') {
          const why = msg.decision_reason || msg.message
          const who = msg.decision_reason_type === 'classifier' ? 'Auto-mode blocked' : 'Blocked'
          this.emit({
            type: 'notice',
            level: 'warn',
            text: `${who} ${msg.tool_name}${why ? `: ${why}` : ''}`,
          })
        }
        break
      }

      case 'stream_event': {
        // Live text deltas. The authoritative content arrives with the final
        // `assistant` message, which replaces whatever streamed in.
        const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          const turn = this.currentAssistantTurn()
          this.emit({ type: 'turn-delta', turnId: turn.id, text: ev.delta.text })
        }
        break
      }

      case 'assistant': {
        // One user turn can produce several assistant messages (text, then a
        // tool call, then more text). They accumulate into a single Turn, so
        // blocks are appended - replacing them would drop earlier tool calls.
        if (this.seenAssistantMsgs.has(msg.uuid)) break
        this.seenAssistantMsgs.add(msg.uuid)

        const turn = this.currentAssistantTurn()
        turn.model = msg.message.model
        for (const c of msg.message.content) {
          if (c.type === 'text') {
            turn.blocks.push({ kind: 'text', text: c.text })
          } else if (c.type === 'thinking') {
            turn.blocks.push({ kind: 'thinking', text: c.thinking })
          } else if (c.type === 'tool_use') {
            const block: Extract<Block, { kind: 'tool' }> = {
              kind: 'tool',
              id: c.id,
              name: c.name,
              input: c.input as Record<string, unknown>,
            }
            turn.blocks.push(block)
            this.toolIndex.set(c.id, { turn, block, startedMs: Date.now() })
          }
        }
        // A turn stops streaming only once it stops producing content; the
        // result message below is what actually closes it out.
        this.emit({ type: 'turn', turn })
        break
      }

      case 'user': {
        // Tool results come back as synthetic user messages. Stitch the full,
        // untruncated output onto the tool block that asked for it.
        const content = msg.message.content
        if (typeof content === 'string') break
        for (const c of content) {
          if (c.type !== 'tool_result') continue
          const entry = this.toolIndex.get(c.tool_use_id)
          if (!entry) continue
          entry.block.result = renderToolResult(c.content)
          entry.block.isError = c.is_error === true
          entry.block.durationMs = Date.now() - entry.startedMs
          this.toolIndex.delete(c.tool_use_id)
          this.emit({ type: 'turn', turn: entry.turn })
        }
        break
      }

      case 'result': {
        // The result message is the authoritative cost/usage source. The SDK's
        // usage() helper is flagged experimental, so accumulate from here.
        this.tally = {
          totalCostUsd: this.tally.totalCostUsd + (msg.total_cost_usd ?? 0),
          inputTokens: this.tally.inputTokens + (msg.usage?.input_tokens ?? 0),
          outputTokens: this.tally.outputTokens + (msg.usage?.output_tokens ?? 0),
          cacheReadTokens: this.tally.cacheReadTokens + (msg.usage?.cache_read_input_tokens ?? 0),
          turns: msg.num_turns ?? this.tally.turns,
        }
        /*
         * A backend failure lands here, not in the pump's `catch`. The CLI
         * retries a 429 itself and reports the outcome on the result message, so
         * this case reading the tally and dropping everything else is why a
         * gateway rate limit showed up as a turn that simply stopped, with no
         * reason anywhere in the UI. `api_error_status` carries the HTTP status
         * directly; `errors` carries the text on the error-shaped variant.
         */
        const apiStatus = 'api_error_status' in msg ? msg.api_error_status : null
        const failures = msg.subtype === 'success' ? [] : msg.errors
        if (msg.is_error || apiStatus || failures.length) {
          const detail = failures.join('; ') || (apiStatus ? `HTTP ${apiStatus}` : msg.subtype)
          this.emit({
            type: 'notice',
            level: 'warn',
            text: nameTheBackend(detail, this.opts.model),
          })
        }
        const last = this.turns[this.turns.length - 1]
        if (last && last.role === 'assistant') {
          last.streaming = false
          this.emit({ type: 'turn', turn: last })
        }
        this.setStatus('running')
        this.emit({ type: 'inspector-dirty' })
        break
      }

      default:
        break
    }
  }

  interrupt(): void {
    void this.q?.interrupt().catch(() => undefined)
  }

  async mcpServers(): Promise<McpServerView[]> {
    if (!this.q) return []
    const raw = await this.q.mcpServerStatus()
    return raw.map((s) => {
      const cfg = s.config as { type?: string; url?: string; command?: string } | undefined
      return {
        name: s.name,
        status: s.status,
        origin: 'live' as const,
        transport: cfg?.type ?? (cfg?.command ? 'stdio' : undefined),
        url: cfg?.url,
        scope: s.scope,
        error: s.error,
        serverVersion: s.serverInfo?.version,
        tools: (s.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          readOnly: t.annotations?.readOnly,
          destructive: t.annotations?.destructive,
        })),
      }
    })
  }

  /** Retry one MCP server's connection without restarting the session. */
  async reconnectMcp(name: string): Promise<McpServerView[]> {
    if (!this.q) return []
    await this.q.reconnectMcpServer(name)
    return this.mcpServers()
  }

  async skills(): Promise<SkillView[]> {
    if (!this.q) return []
    return toSkillViews(await this.q.supportedCommands())
  }

  async agents(): Promise<AgentView[]> {
    if (!this.q) return []
    return toAgentViews(await this.q.supportedAgents())
  }

  /**
   * The models this session can offer. Native Claude models come from the live
   * session when there is one, aliases otherwise, and the gateway's own list is
   * appended whenever the proxy is installed.
   *
   * A gateway session is deliberately never asked. Under the proxy,
   * `supportedModels()` answers from the gateway's discovery endpoint, so the
   * list would be the proxy's client-facing names rather than the values Atelier
   * routes on, and the native models would disappear from the picker entirely.
   */
  async models(): Promise<ModelOption[]> {
    let native: ModelOption[] = []
    if (this.q && !isGatewayModel(this.opts.model)) {
      try {
        native = (await this.q.supportedModels()).map((m) => ({
          value: m.value,
          displayName: m.displayName,
          description: m.description,
          supportsEffort: m.supportsEffort,
        }))
      } catch {
        // Fall through to the aliases, which always resolve.
      }
    }
    if (!native.length) native = NATIVE_ALIASES
    return [...native, ...gatewayModels()]
  }

  /**
   * Switch models. Applies to the live session immediately when there is one,
   * and is remembered so a later session starts on the same model.
   *
   * Anything involving a gateway model is the exception: it cannot happen in
   * place. Which model answers behind the gateway is baked into the launcher at
   * spawn time, and the proxy also remaps the `opus`/`sonnet`/`haiku` aliases
   * onto gateway models. So all three of gateway-to-gateway, gateway-to-native
   * and native-to-gateway would fail quietly rather than loudly: the first would
   * hand the SDK a value it has never seen, and the other two would answer from
   * the wrong model. Only native-to-native is safe live. The pick is kept for the
   * next session in every other case.
   *
   * The comparison is against the model the process was spawned on, not the last
   * pick, so a refused switch does not go on to refuse a native one after it.
   */
  async setModel(model: string): Promise<SessionInfo> {
    const bothNative = !isGatewayModel(model) && !isGatewayModel(this.spawnedModel)
    this.opts = { ...this.opts, model }
    if (this.q && !bothNative) {
      this.emit({
        type: 'notice',
        level: 'warn',
        text: 'Saved for your next session. Gateway routing is fixed when a session starts, so a running one cannot switch to or from a gateway model.',
      })
      return this.info
    }
    if (this.q) await this.q.setModel(model)
    this.info = { ...this.info, model }
    this.emit({ type: 'session', info: this.info })
    return this.info
  }

  async contextUsage(): Promise<ContextUsageView | null> {
    if (!this.q) return null
    try {
      // The SDK names the window `maxTokens`, not `contextWindow`, and returns
      // `categories` as an array rather than a `breakdown` map. Reading the old
      // names left contextWindow undefined, which made the percentage null and
      // silently hid the inspector's context footer altogether.
      const u = await this.q.getContextUsage()
      return {
        totalTokens: u.totalTokens ?? 0,
        // `rawMaxTokens` is the model's true window; `maxTokens` is what is
        // usable after the CLI's own reserve. Prefer the usable figure, because
        // that is the number the session actually runs out of.
        contextWindow: u.maxTokens || u.rawMaxTokens || undefined,
        categories: (u.categories ?? []).map(({ name, tokens }) => ({ name, tokens })),
      }
    } catch {
      return null
    }
  }

  usage(): UsageView | null {
    return this.q ? this.tally : null
  }

  dispose(): void {
    for (const [id, p] of this.permissions) {
      p.resolve({ behavior: 'deny', message: 'Window closed.' })
      this.emit({ type: 'permission-resolved', id })
    }
    this.permissions.clear()
    this.queue.close()
    /*
     * Closing the input queue ends the iterator the SDK is reading, which is not
     * the same as stopping the CLI: the SDK owns the child process and only
     * `Query.close()` kills it. Dropping the reference instead leaks one `claude`
     * per disposed session - seven of them, alive fourteen to seventeen hours, is
     * what that looked like in practice. Each one also holds an AI Gateway proxy
     * lease when the session was a gateway one. `warm.ts` has always closed its
     * throwaway query in a `finally`; this path never did.
     */
    try {
      this.q?.close()
    } catch {
      // Already gone, or never started.
    }
    this.q = null
  }
}

/** Flatten a tool_result content payload into copyable plain text. */
function renderToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2)
  return content
    .map((c: { type?: string; text?: string }) =>
      c?.type === 'text' ? (c.text ?? '') : `[${c?.type ?? 'block'}]`,
    )
    .join('\n')
}
