import { app } from 'electron'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionGroup } from '../shared/types.js'

function storePath(): string {
  return join(app.getPath('userData'), 'session-groups.json')
}

export async function readGroups(): Promise<SessionGroup[]> {
  try {
    const raw = JSON.parse(await readFile(storePath(), 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    // Tolerate a hand-edited or partially-written file rather than throwing.
    return raw.filter(
      (g): g is SessionGroup =>
        typeof g === 'object' &&
        g !== null &&
        typeof (g as SessionGroup).id === 'string' &&
        Array.isArray((g as SessionGroup).sessionIds),
    )
  } catch {
    return []
  }
}

export async function writeGroups(groups: SessionGroup[]): Promise<void> {
  const path = storePath()
  await mkdir(app.getPath('userData'), { recursive: true })
  // Write-then-rename so a crash mid-write cannot truncate the existing file.
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(groups, null, 2), 'utf8')
  await rename(tmp, path)
}
