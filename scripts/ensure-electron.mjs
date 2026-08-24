/**
 * Makes sure the Electron binary is actually on disk, and downloads it if not.
 *
 * The `electron` package does not ship its binary. A postinstall script fetches
 * it and writes `path.txt` next to the package saying where it landed. Recent
 * npm blocks dependency install scripts unless they are approved, so on a fresh
 * machine that postinstall can silently not run. Everything then still installs
 * and still builds - esbuild and vite need no binary - and the failure only
 * surfaces at launch, as `Error: Electron uninstall` thrown from inside
 * electron-vite. That message names neither the package nor the cause.
 *
 * So check here instead, where we know our own postinstall did run, and repair
 * it. `install.js` is idempotent: it exits immediately when the binary is
 * already there and the version matches, so this costs nothing on every install
 * after the first.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = new URL('..', import.meta.url).pathname
const pkg = join(root, 'node_modules/electron')
const pathFile = join(pkg, 'path.txt')

// No electron package at all is a different problem, and not one this can fix.
// Say so rather than trying to download into a directory that does not exist.
if (!existsSync(pkg)) {
  console.error('[ensure-electron] node_modules/electron is missing. Run `npm install` again.')
  process.exit(1)
}

/** Whether the binary `path.txt` points at is really there. */
const installed = () => {
  if (!existsSync(pathFile)) return false
  return existsSync(join(pkg, 'dist', readFileSync(pathFile, 'utf8').trim()))
}

if (installed()) process.exit(0)

console.log('[ensure-electron] Electron binary missing, downloading it...')
const run = spawnSync(process.execPath, [join(pkg, 'install.js')], { stdio: 'inherit', cwd: pkg })

if (run.status !== 0 || !installed()) {
  console.error(
    [
      '',
      '[ensure-electron] Could not download the Electron binary.',
      '',
      'This is what makes the app fail to start with "Error: Electron uninstall".',
      'Usually it is npm blocking the download script. Approve it and reinstall:',
      '',
      '  npm install-scripts approve electron',
      '  npm install',
      '',
      'On an older npm without that command, run the download directly:',
      '',
      '  node node_modules/electron/install.js',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

console.log('[ensure-electron] Electron binary ready.')
