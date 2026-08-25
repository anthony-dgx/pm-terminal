import { app } from 'electron'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { envVar } from './env.js'

interface Prefs {
  lastCwd?: string
  lastModel?: string
  lastProfileId?: string | null
  inspectorOpen?: boolean
  sidebarOpen?: boolean
  theme?: string
  player?: { url?: string; volume?: number }
  /**
   * The last update check, so the automatic one can run at most once a day.
   * Keyed by the commit it describes: a result saved by a previous build says
   * nothing about the one running now.
   */
  lastUpdate?: {
    commit: string
    state: 'current' | 'behind' | 'dirty-build' | 'unknown'
    behind: number
    detail?: string
    checkedAt?: number
  }
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
  const forced = envVar('DEFAULT_CWD')
  if (forced && existsSync(forced)) return forced
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
