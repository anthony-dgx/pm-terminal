import { createReadStream } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { renameSession as sdkRenameSession } from '@anthropic-ai/claude-agent-sdk'
import type { Block, HistoryEntry, Turn } from '../shared/types.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

/** `-Users-anthony-Desktop-Lab` -> `/Users/anthony/Desktop/Lab` (best effort). */
function slugToPath(slug: string): string {
  return slug.replace(/^-/, '/').replace(/-/g, '/')
}

/**
 * Transcripts wrap real prompts in harness scaffolding: caveat banners for
 * slash commands, injected system reminders, command metadata. None of it is
 * something the user typed, so it must not become the session title.
 */
export function cleanUserText(raw: string): string {
  return raw
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, (_m, name: string) =>
      name.startsWith('/') ? name : `/${name}`,
    )
    .replace(/<[/]?(local-command-caveat|system-reminder|command-name|command-message|command-args)>/g, '')
    .trim()
}

/** Extract the plain text a user actually typed from a transcript record. */
function userText(content: unknown): string {
  if (typeof content === 'string') return cleanUserText(content)
  if (!Array.isArray(content)) return ''
  return cleanUserText(
    (content as { type?: string; text?: string }[])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n'),
  )
}

/**
 * Find the newest `customTitle` in a transcript.
 *
 * Renames are *appended* to the end of the JSONL, so a head scan will never see
 * them - this reads the tail instead. The last one wins, since a session can be
 * renamed more than once.
 */
async function readTailTitle(path: string, size: number): Promise<string> {
  const WINDOW = 128 * 1024
  const start = Math.max(0, size - WINDOW)
  const handle = await open(path, 'r')
  try {
    const len = size - start
    if (len <= 0) return ''
    const buf = Buffer.alloc(len)
    await handle.read(buf, 0, len, start)
    const lines = buf.toString('utf8').split('\n')
    // The first line is probably cut mid-object when we did not start at 0.
    if (start > 0) lines.shift()

    let title = ''
    for (const line of lines) {
      if (!line.includes('customTitle')) continue
      try {
        const rec = JSON.parse(line) as { customTitle?: unknown }
        if (typeof rec.customTitle === 'string' && rec.customTitle.trim()) title = rec.customTitle
      } catch {
        continue
      }
    }
    return title
  } finally {
    await handle.close()
  }
}

/**
 * Read enough of the head of a transcript to label it in the sidebar, without
 * pulling a 5MB file into memory.
 */
async function peekTranscript(path: string): Promise<{ cwd: string; firstPrompt: string }> {
  let cwd = ''
  let firstPrompt = ''
  let fallbackPrompt = ''
  let scanned = 0

  const stream = createReadStream(path)
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      // The opening records can be very large (CLAUDE.md, system reminders),
      // so scan by record rather than by a fixed byte window, and give up
      // after a bounded number so this stays cheap across many files.
      if (++scanned > 40) break

      let rec: Record<string, unknown>
      try {
        rec = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd
      if (!firstPrompt && rec.type === 'user' && rec.isMeta !== true) {
        const message = rec.message as { content?: unknown } | undefined
        const text = userText(message?.content).replace(/\s+/g, ' ')
        // Records that were pure scaffolding clean down to nothing; skip them.
        // A bare slash command is a poor title, so keep it only as a fallback
        // and keep scanning for the prompt the user actually typed.
        if (text) {
          if (/^\/\S+$/.test(text)) fallbackPrompt ||= text
          else firstPrompt = text
        }
      }
      if (cwd && firstPrompt) break
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return { cwd, firstPrompt: firstPrompt || fallbackPrompt }
}

async function countLines(path: string): Promise<number> {
  let count = 0
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) if (line.trim()) count++
  return count
}

/**
 * List recorded sessions across all projects, newest first.
 * `countMessages` is off by default because it requires a full read of every
 * transcript; the sidebar turns it on lazily for the visible page.
 */
export async function listHistory(opts: { limit?: number; countMessages?: boolean } = {}): Promise<HistoryEntry[]> {
  const { limit = 60, countMessages = false } = opts

  let slugs: string[]
  try {
    slugs = await readdir(PROJECTS_DIR)
  } catch {
    return []
  }

  const candidates: { path: string; slug: string; sessionId: string; modifiedMs: number; sizeBytes: number }[] = []
  for (const slug of slugs) {
    let files: string[]
    try {
      files = await readdir(join(PROJECTS_DIR, slug))
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(PROJECTS_DIR, slug, file)
      try {
        const s = await stat(path)
        candidates.push({
          path,
          slug,
          sessionId: file.replace(/\.jsonl$/, ''),
          modifiedMs: s.mtimeMs,
          sizeBytes: s.size,
        })
      } catch {
        continue
      }
    }
  }

  candidates.sort((a, b) => b.modifiedMs - a.modifiedMs)
  const page = candidates.slice(0, limit)

  const out: HistoryEntry[] = []
  for (const c of page) {
    try {
      const [{ cwd, firstPrompt }, title] = await Promise.all([
        peekTranscript(c.path),
        readTailTitle(c.path, c.sizeBytes),
      ])
      out.push({
        sessionId: c.sessionId,
        projectSlug: c.slug,
        cwd: cwd || slugToPath(c.slug),
        title: title || firstPrompt.slice(0, 80) || '(empty session)',
        firstPrompt,
        modifiedMs: c.modifiedMs,
        sizeBytes: c.sizeBytes,
        messageCount: countMessages ? await countLines(c.path) : 0,
      })
    } catch {
      continue
    }
  }
  return out
}

/**
 * Rename a recorded session. The SDK appends a `customTitle` entry to the
 * transcript, which is the same field peekTranscript already prefers, so the
 * new name survives restarts and shows up in Claude Code itself.
 */
export async function renameSession(sessionId: string, title: string, dir?: string): Promise<void> {
  await sdkRenameSession(sessionId, title, dir ? { dir } : undefined)
}

/**
 * Parse a full transcript into renderable turns. Used both for browsing old
 * sessions read-only and for rehydrating the view when resuming one.
 */
export async function readTranscript(projectSlug: string, sessionId: string): Promise<Turn[]> {
  const path = join(PROJECTS_DIR, projectSlug, `${sessionId}.jsonl`)
  const turns: Turn[] = []
  const toolBlocks = new Map<string, Extract<Block, { kind: 'tool' }>>()

  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    const msg = rec.message as { role?: string; content?: unknown; model?: string } | undefined
    if (!msg) continue
    const at = typeof rec.timestamp === 'string' ? rec.timestamp : new Date(0).toISOString()
    const id = typeof rec.uuid === 'string' ? rec.uuid : `${turns.length}`

    if (rec.type === 'user') {
      const content = msg.content
      // A user record carrying tool_result is a tool response, not a real turn.
      if (Array.isArray(content) && content.some((c: { type?: string }) => c?.type === 'tool_result')) {
        for (const c of content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
          if (c.type !== 'tool_result' || !c.tool_use_id) continue
          const block = toolBlocks.get(c.tool_use_id)
          if (!block) continue
          block.result = typeof c.content === 'string' ? c.content : JSON.stringify(c.content, null, 2)
          block.isError = c.is_error === true
        }
        continue
      }
      const text = userText(content)
      if (!text) continue
      turns.push({ id, role: 'user', blocks: [{ kind: 'text', text }], at })
      continue
    }

    if (rec.type === 'assistant' && Array.isArray(msg.content)) {
      const blocks: Block[] = []
      for (const c of msg.content as {
        type?: string
        text?: string
        thinking?: string
        id?: string
        name?: string
        input?: Record<string, unknown>
      }[]) {
        if (c.type === 'text' && c.text) {
          blocks.push({ kind: 'text', text: c.text })
        } else if (c.type === 'thinking' && c.thinking) {
          blocks.push({ kind: 'thinking', text: c.thinking })
        } else if (c.type === 'tool_use' && c.id && c.name) {
          const block: Extract<Block, { kind: 'tool' }> = {
            kind: 'tool',
            id: c.id,
            name: c.name,
            input: c.input ?? {},
          }
          blocks.push(block)
          toolBlocks.set(c.id, block)
        }
      }
      if (blocks.length) turns.push({ id, role: 'assistant', blocks, at, model: msg.model })
    }
  }

  return turns
}
