/**
 * Staleness detection, and a button that fixes it.
 *
 * The app has no release feed. It is installed by running `npm run install:app`
 * from a clone, so the only meaningful question is whether that clone's
 * `origin/main` has moved past the commit the running bundle was built from.
 * Both the commit and the clone path are baked in at build time
 * (see `electron.vite.config.ts`); nothing here can work without them.
 *
 * Updating is a rebuild, not a download: pull the clone, package it, then swap
 * the bundle. The swap is the sharp edge, because the app is *running from* the
 * bundle being replaced, so it happens in a detached script that waits for this
 * process to exit first.
 */
import { app } from 'electron'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { readPrefs, writePrefs } from './prefs.js'
import type { UpdateProgress, UpdateStatus } from '../shared/types.js'

declare const __BUILD_COMMIT__: string
declare const __BUILD_TIME__: string
declare const __BUILD_DIRTY__: boolean
declare const __BUILD_REPO__: string

/**
 * The bundle name electron-builder produces, from `productName`.
 *
 * Kept as a constant because the swap has to reason about it changing: an
 * installed bundle from before a rename sits at the old name, and the new build
 * arrives under this one.
 */
const BUNDLE = 'Atelier.app'

/** Once a day. Checking on every launch is noise, and it costs a network round trip. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * A GUI app has no terminal and may have no unlocked ssh-agent. Without this,
 * a `git fetch` over SSH sits forever on a passphrase prompt nobody can see.
 */
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
}

/** git, by absolute path: launchd's PATH is minimal but always contains /usr/bin. */
function git(args: string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/git',
      args,
      { cwd: __BUILD_REPO__, env: GIT_ENV, timeout, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim().split('\n')[0]))
        else resolve(stdout.trim())
      },
    )
  })
}

/**
 * The `npm` binary, by absolute path.
 *
 * A packaged app launched from Finder inherits launchd's PATH, which is roughly
 * `/usr/bin:/bin:/usr/sbin:/sbin` - nvm's bin is not in it, so a bare `npm`
 * spawn is ENOENT. Same problem the `claude` binary has, solved the same way: a
 * login shell sees the shims. `whence -p` is the part that matters, because it
 * skips aliases, and npm here is aliased to a corporate wrapper that would
 * otherwise be resolved instead of the real thing.
 */
function resolveNpm(): string | undefined {
  try {
    const found = execFileSync('/bin/zsh', ['-lic', 'whence -p npm'], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n')
      .pop()
    if (found && existsSync(found)) return found
  } catch {
    // fall through to the static candidates
  }
  return [
    join(homedir(), '.nvm/versions/node/v22.16.0/bin/npm'),
    '/opt/homebrew/bin/npm',
    '/usr/local/bin/npm',
  ].find((p) => existsSync(p))
}

/**
 * The `.app` bundle this process is running from, when there is one.
 *
 * Derived from the executable rather than hardcoded to `~/Applications`, so an
 * app installed somewhere else updates itself in place instead of quietly
 * writing a second copy next door.
 */
function installedBundle(): string | undefined {
  if (!app.isPackaged) return undefined
  // .../Atelier.app/Contents/MacOS/Atelier
  const bundle = dirname(dirname(dirname(app.getPath('exe'))))
  return bundle.endsWith('.app') ? bundle : undefined
}

function baseStatus(): UpdateStatus {
  return {
    commit: __BUILD_COMMIT__ ? __BUILD_COMMIT__.slice(0, 7) : '',
    builtAt: __BUILD_TIME__,
    repo: __BUILD_REPO__,
    state: 'unknown',
    behind: 0,
    canUpdate: Boolean(installedBundle()) && existsSync(join(__BUILD_REPO__, '.git')),
  }
}

/** The last check's answer, without going near the network. */
export async function cachedStatus(): Promise<UpdateStatus> {
  const saved = (await readPrefs()).lastUpdate
  const base = baseStatus()
  // A saved result from a previous build describes a commit that is no longer
  // running. Showing it would report the old build's staleness as this one's.
  if (!saved || saved.commit !== base.commit) return base
  return { ...base, state: saved.state, behind: saved.behind, detail: saved.detail, checkedAt: saved.checkedAt }
}

/**
 * Ask the clone what `origin/main` looks like now.
 *
 * `force` is the manual button. Without it the check is skipped when one ran
 * inside the last day, and the cached answer comes back instead.
 */
export async function checkForUpdate(force: boolean): Promise<UpdateStatus> {
  const status = baseStatus()

  if (!__BUILD_COMMIT__) {
    return { ...status, detail: 'This build was not stamped with a commit.' }
  }
  if (__BUILD_DIRTY__) {
    return {
      ...status,
      state: 'dirty-build',
      detail: 'Built from uncommitted changes, so there is nothing to compare against.',
    }
  }
  if (!existsSync(join(__BUILD_REPO__, '.git'))) {
    return { ...status, detail: `The clone this was built from is gone: ${__BUILD_REPO__}` }
  }

  const cached = await cachedStatus()
  if (!force && cached.checkedAt && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) return cached

  let next: UpdateStatus
  try {
    await git(['fetch', '--quiet', 'origin', 'main'], 25_000)
    // A build whose commit is no longer reachable - main was rebased, or the
    // build came off a branch that is gone - has no honest "N behind" answer.
    // `rev-list` would happily count from a merge base and be wrong.
    await git(['cat-file', '-e', `${__BUILD_COMMIT__}^{commit}`])
    const behind = Number(await git(['rev-list', '--count', `${__BUILD_COMMIT__}..origin/main`]))
    next = Number.isFinite(behind)
      ? { ...status, state: behind > 0 ? 'behind' : 'current', behind, checkedAt: Date.now() }
      : { ...status, detail: 'Could not count commits.' }
  } catch (err) {
    next = { ...status, detail: (err as Error).message }
  }

  // Only a real answer is worth persisting. Caching a failure would suppress
  // the retry for a whole day over one flaky fetch.
  if (next.state !== 'unknown') {
    await writePrefs({
      lastUpdate: {
        commit: next.commit,
        state: next.state,
        behind: next.behind,
        detail: next.detail,
        checkedAt: next.checkedAt,
      },
    })
  }
  return next
}

/** Run a command, streaming its output to the panel as it goes. */
function run(cmd: string, args: string[], cwd: string, onProgress: (p: UpdateProgress) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    // npm's launcher is a `#!/usr/bin/env node` script, and node lives next to
    // it in the same nvm directory - which is not on the PATH a Finder-launched
    // app inherits. Without this the spawn succeeds and then dies on `node`.
    const env = { ...GIT_ENV, PATH: `${dirname(cmd)}:${process.env.PATH ?? '/usr/bin:/bin'}` }
    const child = spawn(cmd, args, { cwd, env })
    const feed = (buf: Buffer): void => {
      const text = buf.toString().trim()
      if (text) onProgress({ type: 'output', text: text.split('\n').slice(-4).join('\n') })
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`\`${[cmd, ...args].join(' ')}\` exited ${code}`)),
    )
  })
}

/**
 * The script that actually replaces the bundle.
 *
 * It cannot run inside this process: the files it moves are the ones this
 * process is executing from. So it is spawned detached, waits for our pid to go
 * away, and only then swaps. The swap goes through a `.new` copy and a `.old`
 * rename so that there is no moment where the app is simply absent - a failure
 * halfway through leaves the previous version installed rather than nothing.
 *
 * `stale` is a bundle to delete afterwards, set only when the app has been
 * renamed and the new bundle therefore lands beside the old one rather than on
 * top of it. It goes last, once the new app is verifiably in place, so a
 * failure anywhere earlier still leaves a working install.
 */
function swapScript(src: string, dest: string, pid: number, stale?: string): string {
  return `#!/bin/sh
# Wait for the app to exit, then swap the bundle and relaunch it.
i=0
while kill -0 ${pid} 2>/dev/null && [ $i -lt 120 ]; do sleep 0.5; i=$((i+1)); done
if kill -0 ${pid} 2>/dev/null; then exit 1; fi

SRC=${JSON.stringify(src)}
DEST=${JSON.stringify(dest)}
STALE=${JSON.stringify(stale ?? '')}

rm -rf "$DEST.new" "$DEST.old"
cp -R "$SRC" "$DEST.new" || exit 1
if [ -d "$DEST" ]; then mv "$DEST" "$DEST.old" || exit 1; fi
if ! mv "$DEST.new" "$DEST"; then
  [ -d "$DEST.old" ] && mv "$DEST.old" "$DEST"
  exit 1
fi
rm -rf "$DEST.old"
# Both guards matter. Without them an ordinary update, where STALE would be the
# same path as DEST, deletes the app it has just installed.
if [ -n "$STALE" ] && [ "$STALE" != "$DEST" ] && [ -d "$STALE" ] && [ -d "$DEST" ]; then
  rm -rf "$STALE"
fi
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST"
open "$DEST"
`
}

/**
 * Pull, rebuild, and hand the swap to a detached script.
 *
 * Resolves once the new bundle is built and the swap is scheduled. The caller
 * quits the app; the script takes it from there. Rejecting means nothing was
 * touched and the running app is still the installed one.
 */
export async function applyUpdate(onProgress: (p: UpdateProgress) => void): Promise<void> {
  const running = installedBundle()
  if (!running) throw new Error('Updating only works on the installed app, not a dev run.')
  if (!existsSync(join(__BUILD_REPO__, '.git'))) {
    throw new Error(`The clone this was built from is gone: ${__BUILD_REPO__}`)
  }

  // Building on top of local work would ship it, and `--ff-only` below would
  // fail anyway. Stop here, where the message can say what is in the way.
  const dirty = await git(['status', '--porcelain'])
  if (dirty) {
    throw new Error(
      `The clone at ${__BUILD_REPO__} has uncommitted changes. Commit or stash them, then update.`,
    )
  }

  // A clean tree says nothing about which ref is checked out. On a detached
  // HEAD, or on a feature branch that happens to be behind, `--ff-only` below
  // succeeds and quietly drags that ref onto main - destroying the branch
  // point in the second case. Only main gets updated by a button.
  let branch = ''
  try {
    branch = await git(['symbolic-ref', '--short', 'HEAD'])
  } catch {
    throw new Error(`The clone at ${__BUILD_REPO__} is on a detached HEAD. Check out main, then update.`)
  }
  if (branch !== 'main') {
    throw new Error(`The clone at ${__BUILD_REPO__} is on \`${branch}\`. Check out main, then update.`)
  }

  const npm = resolveNpm()
  if (!npm) throw new Error('Could not find npm. Install Node.js, or update by hand from the clone.')

  onProgress({ type: 'step', text: 'Fetching...' })
  await git(['fetch', '--quiet', 'origin', 'main'], 25_000)

  // Only ever fast-forward. If local main has diverged, that is a decision for
  // a human at a terminal, not something a button should resolve.
  onProgress({ type: 'step', text: 'Updating the clone...' })
  try {
    await git(['merge', '--ff-only', 'origin/main'])
  } catch {
    throw new Error(
      `main in ${__BUILD_REPO__} has diverged from origin/main. Sort that out in a terminal, then update.`,
    )
  }

  // Dependencies move with the code, and packaging with stale ones produces an
  // app that builds and then fails at runtime.
  onProgress({ type: 'step', text: 'Installing dependencies...' })
  await run(npm, ['install'], __BUILD_REPO__, onProgress)

  onProgress({ type: 'step', text: 'Building the app (this takes a minute)...' })
  await run(npm, ['run', 'package'], __BUILD_REPO__, onProgress)

  const src = join(__BUILD_REPO__, `dist/mac-arm64/${BUNDLE}`)
  if (!existsSync(src)) throw new Error(`The build finished but produced no app at ${src}.`)

  // Install next to the running app under whatever the new build calls itself,
  // which is the same path in the ordinary case. It differs only across a
  // rename, and then the bundle we are running from is the one to clean up -
  // otherwise both names would sit in the folder and one of them would rot.
  const dest = join(dirname(running), basename(src))
  const stale = dest === running ? undefined : running

  onProgress({ type: 'step', text: 'Installing...' })
  const dir = await mkdtemp(join(tmpdir(), 'atelier-update-'))
  const script = join(dir, 'swap.sh')
  await writeFile(script, swapScript(src, dest, process.pid, stale), 'utf8')
  await chmod(script, 0o755)

  // Detached and unref'd, so it outlives the quit that is about to happen.
  spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref()

  onProgress({ type: 'done', ok: true, text: 'Restarting into the new version...' })
}
