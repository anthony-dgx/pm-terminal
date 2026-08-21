/**
 * node-pty ships `spawn-helper` in its prebuild without the executable bit, and
 * npm does not restore it on install. Without this, every pty.spawn() fails with
 * `Error: posix_spawnp failed.` - which looks like a broken binary rather than a
 * permissions problem, so it is worth fixing loudly at install time.
 *
 * Runs as postinstall. Missing files are not an error: on a non-macOS machine,
 * or a partial install, there is simply nothing to chmod.
 */
import { chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const helpers = [
  'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
  'node_modules/node-pty/build/Release/spawn-helper',
]

for (const rel of helpers) {
  const path = join(root, rel)
  if (!existsSync(path)) continue
  chmodSync(path, 0o755)
  console.log(`[fix-node-pty] chmod +x ${rel}`)
}
