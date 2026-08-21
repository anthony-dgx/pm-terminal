import { app } from 'electron'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
// Type-only, so the cycle with providers.ts is erased at build time.
import type { StoredProvider } from './providers.js'

interface Prefs {
  lastCwd?: string
  lastModel?: string
  /**
   * Which provider `lastModel` belongs to. Model names are provider-specific, so
   * remembering one without this would offer a GPT name to an Anthropic session.
   */
  lastModelProviderId?: string | null
  lastProfileId?: string | null
  providers?: StoredProvider[]
  activeProviderId?: string | null
  inspectorOpen?: boolean
  sidebarOpen?: boolean
  theme?: string
  player?: { url?: string; volume?: number }
}

function prefsPath(): string {
  return join(app.getPath('userData'), 'prefs.json')
}

export async function readPrefs(): Promise<Prefs> {
  try {
    const raw = JSON.parse(await readFile(prefsPath(), 'utf8')) as unknown
    return typeof raw === 'object' && raw !== null ? (raw as Prefs) : {}
  } catch {
    return {}
  }
}

export async function readPlayer(): Promise<{ url?: string; volume?: number }> {
  return (await readPrefs()).player ?? {}
}

export async function writePlayer(next: { url?: string; volume?: number }): Promise<void> {
  await writePrefs({ player: { ...(await readPlayer()), ...next } })
}

export async function writePrefs(next: Prefs): Promise<void> {
  const path = prefsPath()
  await mkdir(app.getPath('userData'), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify({ ...(await readPrefs()), ...next }, null, 2), 'utf8')
  await rename(tmp, path)
}

/**
 * Where a new session starts. Defaulting to the home directory was wrong:
 * local-scope MCP servers are bound to a specific project directory, so a
 * session rooted at `~` silently loads none of them. Prefer the last directory
 * actually used, then the most recently active Claude Code project.
 */
export async function defaultCwd(): Promise<string> {
  if (process.env.CLAUDE_DESK_DEFAULT_CWD && existsSync(process.env.CLAUDE_DESK_DEFAULT_CWD)) {
    return process.env.CLAUDE_DESK_DEFAULT_CWD
  }
  const { lastCwd } = await readPrefs()
  if (lastCwd && existsSync(lastCwd)) return lastCwd

  // Fall back to the project directory with the most MCP servers configured,
  // which is a good proxy for "the one you actually work in".
  try {
    const root = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf8')) as {
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>
    }
    const best = Object.entries(root.projects ?? {})
      .map(([dir, p]) => ({ dir, n: Object.keys(p?.mcpServers ?? {}).length }))
      .filter((x) => x.n > 0 && x.dir !== homedir() && existsSync(x.dir))
      .sort((a, b) => b.n - a.n)[0]
    if (best) return best.dir
  } catch {
    // fall through
  }
  return homedir()
}
