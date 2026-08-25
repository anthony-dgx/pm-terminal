/**
 * What is loaded, before a session exists.
 *
 * The problem this solves: a brand-new tab has no `AgentSession`, so the panel
 * and the `/` autocomplete used to fall back to reading `~/.claude/skills` from
 * disk. That directory holds personal skills only - four of them here, against
 * the ~156 commands the CLI actually loads once plugins and built-ins are in.
 * So the app opened claiming a handful of skills and only told the truth after
 * you sent a message, which is the wrong way round for a picker you use to
 * decide what to send.
 *
 * Reading it off disk instead is a trap. The list depends on marketplace to
 * plugin resolution, `enabledPlugins`, and project scoping - and even done
 * perfectly it still misses the built-in commands and the descriptions the CLI
 * attaches. That is a second implementation of someone else's logic, which will
 * drift. So ask the CLI: spawn a query whose input queue never yields, read
 * `supportedCommands()` and `supportedAgents()` off it, and close it. It answers
 * in about a second without a prompt ever being sent.
 *
 * Deliberately not routed through `AgentSession`: that emits status and turn
 * events into a conversation, so a probe would make an untouched tab look busy.
 * This owns its own throwaway query and emits nothing.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { resolveClaudeExecutable } from './agent.js'
import { toAgentViews, toSkillViews } from './commandViews.js'
import type { AgentView, SkillView } from '../shared/types.js'

export interface WarmInspect {
  skills: SkillView[]
  agents: AgentView[]
}

/**
 * Keyed by cwd, because project skills and MCP servers are per-directory, and
 * the titlebar lets you change it.
 *
 * The TTL exists so installing a plugin shows up without restarting the app.
 * Failures are cached too, briefly: if `claude` cannot answer, retrying on every
 * keystroke-triggered panel read would spawn processes in a loop.
 */
const OK_TTL_MS = 5 * 60_000
const FAIL_TTL_MS = 30_000
/** Long enough for a cold CLI start, short enough not to hang the panel. */
const TIMEOUT_MS = 20_000

const cache = new Map<string, { at: number; value: WarmInspect | null }>()
/** In-flight probes, so the Composer and the Inspector asking at once spawn one. */
const inFlight = new Map<string, Promise<WarmInspect | null>>()

/** An async iterable that never yields: the shape of an unsent input queue. */
const neverYields = {
  async *[Symbol.asyncIterator](): AsyncGenerator<never, void> {
    await new Promise<never>(() => {})
  },
}

async function probe(cwd: string): Promise<WarmInspect | null> {
  const executable = resolveClaudeExecutable()
  if (!executable) return null

  const q = query({
    prompt: neverYields,
    options: {
      cwd,
      pathToClaudeCodeExecutable: executable,
      // The same three sources a real session uses. Without them the CLI loads
      // no config and would report only its built-ins.
      settingSources: ['user', 'project', 'local'],
      permissionMode: 'default',
      // Swallowed on purpose: this is a background read nobody asked for, so it
      // must not put warnings in a conversation the user is looking at.
      stderr: () => {},
    },
  })

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Timed out reading the command list.')), TIMEOUT_MS),
  )

  try {
    const [commands, agents] = await Promise.race([
      Promise.all([q.supportedCommands(), q.supportedAgents()]),
      timeout,
    ])
    return { skills: toSkillViews(commands), agents: toAgentViews(agents) }
  } catch {
    return null
  } finally {
    // Always close, or every probed directory leaves a `claude` process behind.
    try {
      q.close()
    } catch {
      // Already gone.
    }
  }
}

/**
 * The command and subagent lists for `cwd`, or null if the CLI could not be
 * asked. Callers fall back to the disk read, which is thin but better than an
 * empty panel.
 */
export async function warmInspect(cwd: string): Promise<WarmInspect | null> {
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < (hit.value ? OK_TTL_MS : FAIL_TTL_MS)) return hit.value

  const running = inFlight.get(cwd)
  if (running) return running

  const started = probe(cwd)
    .then((value) => {
      cache.set(cwd, { at: Date.now(), value })
      return value
    })
    .finally(() => {
      inFlight.delete(cwd)
    })

  inFlight.set(cwd, started)
  return started
}

/** Drop the cache so the next read re-asks. For the panel's refresh button. */
export function clearWarmInspect(): void {
  cache.clear()
}
