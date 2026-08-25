/**
 * Turning the CLI's own command and agent lists into the view types.
 *
 * This is its own module because two callers need identical output: the live
 * session (`AgentSession.skills`) and the pre-session probe (`warm.ts`). If they
 * disagree, the panel changes its numbers the moment you send a first message,
 * which is exactly the confusion this code exists to remove.
 */
import type { AgentView, SkillView } from '../shared/types.js'

type RawCommand = { name: string; description: string; argumentHint?: string; aliases?: string[] }
type RawAgent = { name: string; description: string }

/** Keep the first of each name: a duplicate breaks list rendering downstream. */
function byUniqueName<T extends { name: string }>(list: T[]): T[] {
  const seen = new Set<string>()
  return list.filter((item) => {
    if (seen.has(item.name)) return false
    seen.add(item.name)
    return true
  })
}

/**
 * The CLI can report the same command name more than once, when a skill is
 * reachable through two sources.
 */
export function toSkillViews(commands: RawCommand[]): SkillView[] {
  return byUniqueName(commands).map((c) => ({
    name: c.name,
    description: c.description,
    argumentHint: c.argumentHint || undefined,
    aliases: c.aliases,
    namespace: c.name.includes(':') ? c.name.split(':')[0] : undefined,
    origin: 'live' as const,
  }))
}

export function toAgentViews(agents: RawAgent[]): AgentView[] {
  return byUniqueName(agents).map((a) => ({
    name: a.name,
    description: a.description,
    tools: 'tools' in a && Array.isArray(a.tools) ? (a.tools as string[]) : undefined,
    model: 'model' in a && typeof a.model === 'string' ? a.model : undefined,
  }))
}
