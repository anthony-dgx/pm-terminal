/**
 * One-time carry-over of state from the app's old name.
 *
 * `app.getPath('userData')` is derived from package.json `name`, so renaming
 * the app moves the whole directory: window state, theme, session groups and
 * agent profiles would all read as a fresh install. This copies the three
 * files that hold real user state out of the old directory the first time the
 * new one is missing them.
 *
 * Only those three. The rest of that directory is Chromium's - caches,
 * cookies, GPU state - and carrying it across a changed `appId` is how you get
 * a corrupt profile rather than a restored one. It copies rather than moves, so
 * a bad migration is undone by reverting the code, not by hand.
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** What the userData directory was called before the rename. */
const PREVIOUS_DIR = 'claude-desk'

const CARRIED = ['prefs.json', 'session-groups.json', 'agent-profiles.json']

export async function migrateUserData(): Promise<void> {
  const dir = app.getPath('userData')
  const previous = join(dirname(dir), PREVIOUS_DIR)
  if (previous === dir || !existsSync(previous)) return

  for (const name of CARRIED) {
    const from = join(previous, name)
    // Per file, not one sentinel: if only some of them exist under the old
    // name, or a later launch adds a new one, each still comes across once.
    // An existing file under the new name is always the newer truth.
    if (!existsSync(from) || existsSync(join(dir, name))) continue
    try {
      await mkdir(dir, { recursive: true })
      await copyFile(from, join(dir, name))
    } catch {
      // A file that cannot be carried over is a default, not a crash.
    }
  }
}
