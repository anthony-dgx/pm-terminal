import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { McpServerView, PluginView, SkillView } from '../shared/types.js'

const CLAUDE_DIR = join(homedir(), '.claude')

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

type RawMcpConfig = { type?: string; url?: string; command?: string }

/**
 * MCP servers as configured on disk, across all three Claude Code scopes:
 *
 * - **user**    `~/.claude.json` top-level `mcpServers` (available everywhere)
 * - **local**   `~/.claude.json` `projects[<dir>].mcpServers` (that dir only)
 * - **project** a `.mcp.json` file in the project dir (checked into the repo)
 *
 * Local and project servers only load when the session's cwd matches, so each
 * entry records the directory it belongs to and whether it applies to `cwd`.
 * This is the pre-session view; a live session supersedes it with real state.
 */
export async function readMcpFromDisk(cwd?: string): Promise<McpServerView[]> {
  const root = await readJson<{
    mcpServers?: Record<string, RawMcpConfig>
    projects?: Record<string, { mcpServers?: Record<string, RawMcpConfig> }>
  }>(join(homedir(), '.claude.json'))

  const authCache =
    (await readJson<Record<string, { timestamp: number }>>(join(CLAUDE_DIR, 'mcp-needs-auth-cache.json'))) ?? {}

  const out: McpServerView[] = []
  const push = (name: string, cfg: RawMcpConfig, scope: string, dir?: string, applies = true): void => {
    // Same name can legitimately exist in two scopes; keep the first (highest
    // precedence) but do not let a later scope overwrite it.
    if (out.some((s) => s.name === name && s.scopeDir === dir)) return
    const needsAuth = authCache[name]
    out.push({
      name,
      status: needsAuth ? 'needs-auth' : 'pending',
      origin: 'config',
      transport: cfg.type ?? (cfg.command ? 'stdio' : undefined),
      url: cfg.url,
      scope,
      scopeDir: dir,
      appliesToCwd: applies,
      tools: [],
      needsAuthSince: needsAuth?.timestamp,
    })
  }

  for (const [name, cfg] of Object.entries(root?.mcpServers ?? {})) push(name, cfg, 'user')

  // Local scope: per-directory servers stored in ~/.claude.json.
  for (const [dir, project] of Object.entries(root?.projects ?? {})) {
    for (const [name, cfg] of Object.entries(project?.mcpServers ?? {})) {
      push(name, cfg, 'local', dir, cwd === dir)
    }
  }

  // Project scope: .mcp.json committed alongside the code.
  for (const dir of await findMcpJsonDirs()) {
    const file = await readJson<{ mcpServers?: Record<string, RawMcpConfig> }>(join(dir, '.mcp.json'))
    for (const [name, cfg] of Object.entries(file?.mcpServers ?? {})) {
      push(name, cfg, 'project', dir, cwd === dir)
    }
  }

  // Plugin-provided servers only show up in the auth cache until a session runs.
  for (const [name, entry] of Object.entries(authCache)) {
    if (out.some((s) => s.name === name)) continue
    out.push({
      name,
      status: 'needs-auth',
      origin: 'config',
      scope: name.startsWith('plugin:') ? 'plugin' : 'unknown',
      appliesToCwd: true,
      tools: [],
      needsAuthSince: entry.timestamp,
    })
  }

  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Directories holding a `.mcp.json`. Claude Code only reads the one at the
 * session cwd, but the panel lists them all so a server is never invisible
 * just because you are pointed somewhere else. Scans the known project roots
 * (the dirs Claude Code has already seen) plus their immediate children.
 */
async function findMcpJsonDirs(): Promise<string[]> {
  const root = await readJson<{ projects?: Record<string, unknown> }>(join(homedir(), '.claude.json'))
  const roots = new Set<string>(Object.keys(root?.projects ?? {}))
  const found: string[] = []

  const has = async (dir: string): Promise<boolean> => {
    try {
      await stat(join(dir, '.mcp.json'))
      return true
    } catch {
      return false
    }
  }

  for (const dir of roots) {
    if (await has(dir)) found.push(dir)
    // One level down covers the common "workspace of repos" layout.
    let children: string[] = []
    try {
      children = await readdir(dir)
    } catch {
      continue
    }
    for (const child of children) {
      if (child.startsWith('.') || child === 'node_modules') continue
      const path = join(dir, child)
      if (roots.has(path)) continue
      if (await has(path)) found.push(path)
    }
  }
  return found
}

export async function readPlugins(): Promise<PluginView[]> {
  const data = await readJson<{
    plugins?: Record<
      string,
      { scope: string; installPath: string; version: string; projectPath?: string; lastUpdated?: string }[]
    >
  }>(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'))

  const out: PluginView[] = []
  for (const [key, installs] of Object.entries(data?.plugins ?? {})) {
    const [name, marketplace = 'unknown'] = key.split('@')
    for (const i of installs) {
      out.push({
        name,
        marketplace,
        version: i.version,
        scope: i.scope,
        installPath: i.installPath,
        projectPath: i.projectPath,
        lastUpdated: i.lastUpdated,
      })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Parse the `name:` and `description:` out of a SKILL.md frontmatter block. */
function parseFrontmatter(md: string): { name?: string; description?: string } {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const out: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(name|description):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

/**
 * Personal skills in ~/.claude/skills. Plugin skills are deliberately not
 * walked here: the live session reports those far more accurately, including
 * which ones are actually enabled.
 */
export async function readSkillsFromDisk(): Promise<SkillView[]> {
  const dir = join(CLAUDE_DIR, 'skills')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const out: SkillView[] = []
  for (const entry of entries) {
    const skillFile = join(dir, entry, 'SKILL.md')
    try {
      const fm = parseFrontmatter(await readFile(skillFile, 'utf8'))
      out.push({
        name: fm.name ?? entry,
        description: fm.description ?? '(no description)',
        origin: 'config',
      })
    } catch {
      // Not a skill directory, skip it.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Best-effort disk size of the config surface, for the inspector footer. */
export async function configSummary(): Promise<{ settingsBytes: number; historyBytes: number }> {
  const safeSize = async (p: string): Promise<number> => {
    try {
      return (await stat(p)).size
    } catch {
      return 0
    }
  }
  return {
    settingsBytes: await safeSize(join(CLAUDE_DIR, 'settings.json')),
    historyBytes: await safeSize(join(CLAUDE_DIR, 'history.jsonl')),
  }
}
