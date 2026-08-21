/**
 * MCP OAuth sign-in, driven through a pty.
 *
 * Why not the Agent SDK: it cannot start an MCP OAuth flow at all.
 * `reconnectMcpServer` throws `Server status: needs-auth`, sending `/mcp` only
 * prints a summary, and a needs-auth server's tools never reach the model, so
 * nothing ever elicits. The only real path is the CLI's `claude mcp login`.
 *
 * Why not a plain child process: that command aborts itself unless stdin is a
 * terminal. From the CLI's own callback handler:
 *
 *     onWaitingForCallback: (d) => {
 *       if (!process.stdin.isTTY) { l = true; s.abort(); return }
 *
 * The check is unconditional, so piped stdio can never finish the flow even
 * though the loopback callback server is already listening. Under a pty the flow
 * stays open and both completion paths work: the browser redirect to the CLI's
 * localhost callback, and pasting the redirect URL back in.
 *
 * One flow at a time. `mcp login` revokes the server's existing tokens before it
 * starts anything, so overlapping logins on one server would fight - and for the
 * same reason the UI only offers this on a server that is already unauthenticated.
 */
import type { IPty } from 'node-pty'
import { spawn } from 'node-pty'
import type { McpLoginEvent } from '../shared/types.js'
import { resolveClaudeExecutable } from './agent.js'

/** Give up rather than leak a pty if the user abandons the browser tab. */
const TIMEOUT_MS = 5 * 60 * 1000

/**
 * A wide pty so long authorize URLs are not hard-wrapped. The URL is parsed out
 * of this output, and a line break mid-URL would silently truncate the link.
 */
const COLS = 400

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

/**
 * OSC 8 hyperlink: ESC ] 8 ; params ; URI, terminated by BEL or ESC backslash.
 * The URI is the real link target, which is why it is captured before the
 * general stripper throws the rest away.
 *
 * Built from string parts on purpose. Literal control characters inside a regex
 * literal are invisible in an editor and do not survive being edited.
 */
const OSC8 = new RegExp(`${ESC}\\]8;[^;]*;([^${BEL}${ESC}]*)(?:${BEL}|${ESC}\\\\)`, 'g')

/** Other OSC strings, CSI sequences, and short two-character escapes. */
const ANSI = new RegExp(
  [
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
    `${ESC}\\[[0-9;?]*[ -/]*[@-~]`,
    `${ESC}[()][A-Za-z0-9]`,
    `${ESC}.`,
  ].join('|'),
  'g',
)

/** Control characters that are not newline or tab, once the escapes are gone. */
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** Readable text, with the escape machinery removed. */
function clean(raw: string): string {
  return (
    raw
      .replace(OSC8, '')
      .replace(ANSI, '')
      .replace(/\r\n/g, '\n')
      // A lone CR is a TUI redrawing a line in place. Treat it as a break, so a
      // spinner does not overwrite the line before it.
      .replace(/\r/g, '\n')
      .replace(CTRL, '')
  )
}

/** The first http(s) URL in the output, preferring an OSC 8 link target. */
function findUrl(raw: string): string | undefined {
  for (const m of raw.matchAll(OSC8)) {
    if (/^https?:\/\//.test(m[1])) return m[1]
  }
  return clean(raw).match(/https?:\/\/[^\s"'<>)\]]+/)?.[0]
}

/** The last few non-empty lines, for reporting why a login ended. */
function tail(raw: string, lines = 6): string {
  const kept = clean(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return kept.slice(-lines).join('\n')
}

interface Active {
  name: string
  pty: IPty
  timer: NodeJS.Timeout
  /** Set once a terminal state is reported, so exit does not report twice. */
  settled: boolean
}

let active: Active | null = null

/** Name of the server currently signing in, or null. */
export function mcpLoginInProgress(): string | null {
  return active?.name ?? null
}

/**
 * Start the sign-in. Returns as soon as the pty is spawned; progress and the
 * outcome arrive through `emit`.
 */
export function startMcpLogin(
  name: string,
  cwd: string | undefined,
  emit: (e: McpLoginEvent) => void,
): void {
  if (active) throw new Error(`Already signing in to ${active.name}. Finish or cancel that first.`)

  const executable = resolveClaudeExecutable()
  if (!executable) {
    throw new Error('Could not find the `claude` binary. Set CLAUDE_DESK_CLI_PATH and restart.')
  }

  // A GUI-launched app inherits a stripped PATH from launchd. The CLI shells out
  // to `open` to launch the browser, so the system directories have to be there.
  const PATH = [process.env.PATH, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':')

  const child = spawn(executable, ['mcp', 'login', name], {
    name: 'xterm-256color',
    cols: COLS,
    rows: 30,
    cwd: cwd ?? process.env.HOME,
    env: { ...process.env, PATH, TERM: 'xterm-256color' } as Record<string, string>,
  })

  let raw = ''
  let sentUrl = false
  let sawWaiting = false
  let sawPaste = false

  const state: Active = {
    name,
    pty: child,
    settled: false,
    timer: setTimeout(
      () => finish(false, 'Timed out after five minutes without finishing authorization.'),
      TIMEOUT_MS,
    ),
  }
  active = state

  function finish(ok: boolean, message: string): void {
    if (state.settled) return
    state.settled = true
    clearTimeout(state.timer)
    try {
      state.pty.kill()
    } catch {
      // already gone
    }
    if (active === state) active = null
    emit({ name, kind: 'done', ok, message })
  }

  child.onData((chunk) => {
    raw += chunk
    const text = clean(chunk)
    if (text.trim()) emit({ name, kind: 'output', text })

    if (!sentUrl) {
      const url = findUrl(raw)
      if (url) {
        sentUrl = true
        emit({ name, kind: 'url', url })
      }
    }
    const soFar = clean(raw)
    if (!sawWaiting && /Waiting for authorization/i.test(soFar)) {
      sawWaiting = true
      emit({ name, kind: 'waiting' })
    }
    if (!sawPaste && /paste the redirect URL/i.test(soFar)) {
      sawPaste = true
      emit({ name, kind: 'paste-ready' })
    }
  })

  child.onExit(({ exitCode }) => {
    const out = clean(raw)
    const success = /Authenticated with/i.test(out)
    // The CLI exits 0 for several outcomes that are not an OAuth sign-in: a
    // claude.ai-proxied server, one that authenticates with a static header, one
    // that wants `claude login` instead. Each prints a useful sentence, so pass
    // its own words through rather than inventing a status.
    const last = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop()
    finish(
      exitCode === 0,
      success
        ? (last ?? `Authenticated with "${name}".`)
        : tail(raw) || `Sign-in ended with code ${exitCode}.`,
    )
  })
}

/** Answer the CLI's "paste the redirect URL" prompt. */
export function sendMcpLoginInput(name: string, text: string): void {
  if (!active || active.name !== name) throw new Error(`No sign-in running for ${name}.`)
  active.pty.write(`${text.trim()}\r`)
}

/**
 * Stop the flow. The UI should be honest about what this leaves behind:
 * `mcp login` revoked the server's tokens before it started, so cancelling does
 * not restore the previous state.
 */
export function cancelMcpLogin(name: string): void {
  if (!active || active.name !== name) return
  const state = active
  state.settled = true
  clearTimeout(state.timer)
  try {
    state.pty.kill()
  } catch {
    // already gone
  }
  active = null
}
