import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * Stamp the build with the commit it came from, and with the clone it came out
 * of. There is no release feed to check against - the app is installed by
 * running `npm run install:app` from a clone - so "is there a new version" can
 * only be answered by asking that clone what `origin/main` looks like now.
 * Both halves have to be baked at build time: once the app is in
 * `~/Applications` it has no idea where it was built from.
 */
function git(...args: string[]): string {
  try {
    return execFileSync('/usr/bin/git', args, {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

const buildInfo = {
  __BUILD_COMMIT__: git('rev-parse', 'HEAD'),
  __BUILD_TIME__: new Date().toISOString(),
  // A build off a dirty tree does not correspond to any commit, so a count of
  // commits behind would be a lie in both directions. Record it and say so.
  //
  // electron-vite bundles this file to `electron.vite.config.<n>.mjs` in the
  // project root before evaluating it, so that temp file is present in every
  // single build and made every build look dirty. It is gitignored now, which
  // is the actual fix, but the filter stays as a belt: the name is generated,
  // so nobody reading a stale checkout has to know about it.
  __BUILD_DIRTY__: git('status', '--porcelain')
    .split('\n')
    .some((line) => line.trim() !== '' && !/electron\.vite\.config\.\d+\.mjs$/.test(line)),
  __BUILD_REPO__: __dirname,
}

export default defineConfig({
  main: {
    // The Agent SDK spawns the real `claude` binary and must stay external.
    plugins: [externalizeDepsPlugin()],
    define: Object.fromEntries(Object.entries(buildInfo).map(([k, v]) => [k, JSON.stringify(v)])),
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
    plugins: [react()],
  },
})
