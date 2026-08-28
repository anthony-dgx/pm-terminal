import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { ModelOption } from '../shared/types.js'
import { GATEWAY_PREFIX, gatewayModelName } from '../shared/gateway.js'

/**
 * Datadog's AI Gateway client proxy, if it is installed on this machine.
 *
 * The proxy is a loopback adapter that translates Anthropic Messages calls to
 * the gateway, so Claude Code can answer from non-Anthropic models. Atelier does
 * not manage it and does not install it. All of this is a no-op until someone
 * runs the proxy's own installer, which is the honest default state.
 *
 * Nothing here reimplements any of the proxy's runtime. Its `claude-process-wrapper`
 * action already takes a proxy lease, runs the auth preflight, computes the whole
 * provider environment and then execs a command we hand it. We generate a script
 * that calls exactly that, and let the proxy own everything else.
 */

/** Where the installer records what it wrote. `AIGW_INSTALL_STATE` overrides it. */
function statePath(): string {
  return process.env.AIGW_INSTALL_STATE || join(homedir(), '.local/share/aigw-openweights/install.json')
}

interface Install {
  statePath: string
  /** `aigw-openweights-runtime`, the executable that owns the wrapper action. */
  runtime: string
  configPath: string
}

/**
 * Read the install state. Re-read rather than cached, because the proxy can be
 * installed while Atelier is running and the model list should notice.
 */
function install(): Install | null {
  const path = statePath()
  if (!existsSync(path)) return null
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as {
      proxy_executable?: string
      config_path?: string
    }
    if (!state.proxy_executable || !state.config_path) return null
    // The installer writes every console script into one directory, so the
    // runtime sits beside the proxy. This is how the proxy finds it too.
    const runtime = join(dirname(state.proxy_executable), 'aigw-openweights-runtime')
    if (!existsSync(runtime) || !existsSync(state.config_path)) return null
    return { statePath: path, runtime, configPath: state.config_path }
  } catch {
    // A half-written or unreadable state file means no gateway, not a crash.
    return null
  }
}

/** Whether gateway models are available at all. Drives the hint in the picker. */
export function gatewayInstalled(): boolean {
  return install() !== null
}

/** The shape Atelier reads out of the proxy's `config.json`. */
interface ProxyModel {
  name?: string
  display_name?: string
  /** Absent means true, matching the proxy's own default. */
  discoverable?: boolean
  context_window?: number
  pricing?: { input?: number }
}

/** `1000000` -> `1M`, `262144` -> `262K`. */
function contextLabel(tokens: number | undefined): string {
  if (!tokens || tokens <= 0) return ''
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M context`
  return `${Math.round(tokens / 1000)}K context`
}

/**
 * The gateway models offered in the picker, read from the proxy's config rather
 * than hardcoded, so a model added or removed on the proxy side just appears.
 */
export function gatewayModels(): ModelOption[] {
  const found = install()
  if (!found) return []
  try {
    const config = JSON.parse(readFileSync(found.configPath, 'utf8')) as { models?: ProxyModel[] }
    return (config.models ?? [])
      .filter((m) => m.name && m.discoverable !== false)
      .map((m) => {
        const parts = [contextLabel(m.context_window)]
        if (m.pricing?.input) parts.push(`$${m.pricing.input.toFixed(2)}/M in`)
        return {
          value: `${GATEWAY_PREFIX}${m.name}`,
          // The proxy's own label already ends in "via Datadog AI Gateway",
          // which is exactly the disambiguation the picker needs against a
          // native model of the same name.
          displayName: m.display_name || (m.name as string),
          description: parts.filter(Boolean).join(' · '),
        }
      })
  } catch {
    return []
  }
}

/** Single-quote for `/bin/sh`, so a path with a space or a quote survives. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Write (or reuse) the launcher for one gateway model and return its path, for
 * `pathToClaudeCodeExecutable`. Returns null when the proxy is not installed or
 * the model is a native one.
 *
 * The script is what makes the top-level process a gateway process.
 * `CLAUDE_CODE_PROCESS_WRAPPER`, which the proxy sets, only covers Claude's own
 * self-spawns, so without this the first process would run natively and only its
 * children would be routed. Because the proxy execs from inside its lease block,
 * the lease it takes belongs to the exec'd PID and lives exactly as long as this
 * session. Atelier holds no lease and releases nothing.
 */
export function gatewayShim(model: string, claudeExecutable: string): string | null {
  const found = install()
  const name = gatewayModelName(model)
  if (!found || !name) return null
  // A model the proxy no longer offers is a real case: the last-used model is
  // persisted in prefs, and the proxy's config can change under it. Refuse here
  // so the session reports Atelier's own message rather than spawning into a
  // failure from the proxy.
  if (!gatewayModels().some((m) => m.value === model)) return null

  const dir = join(app.getPath('userData'), 'gateway-shims')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `claude-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`)

  const body = `${[
    '#!/bin/sh',
    '# Generated by Atelier. Runs one Claude Code session through the Datadog AI',
    '# Gateway client proxy. Do not edit: it is rewritten whenever the install moves.',
    `export AIGW_INSTALL_STATE=${shellQuote(found.statePath)}`,
    `exec ${shellQuote(found.runtime)} claude-process-wrapper \\`,
    `  --aigw-model ${shellQuote(name)} \\`,
    '  --aigw-subagent-model auto \\',
    `  -- ${shellQuote(claudeExecutable)} "$@"`,
  ].join('\n')}\n`

  // Deterministic per model, so this only writes when the install or the real
  // binary moved.
  if (!existsSync(path) || readFileSync(path, 'utf8') !== body) {
    writeFileSync(path, body, { mode: 0o755 })
  }
  // writeFileSync's mode only applies on create, and a reused file may predate it.
  chmodSync(path, 0o755)
  return path
}
