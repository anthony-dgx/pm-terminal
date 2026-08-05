# Claude Desk

An Electron desktop client for Claude Code, built around the two things a terminal is worst at:
getting text back out, and showing you what is actually loaded.

It drives the real `claude` binary through the Claude Agent SDK, so your CLAUDE.md, skills, plugins,
MCP servers, and permission rules all apply exactly as they do in the terminal.

## Why

Ghostty is fine for typing. It is bad at:

- copying a fenced code block without wrap artifacts
- copying tool output that scrolled past or got truncated
- copying a markdown table into Sheets or Docs
- copying one whole reply as markdown
- telling you which of your 20 MCP servers are actually connected
- telling you which of your 150 skills are loaded and what triggers them

This app fixes those specifically.

## Features

**Copy affordances.** Every code block, table, tool call, and assistant turn has its own copy button,
and every one copies the raw source rather than the rendered DOM.

- Code blocks: copies the exact source, no line numbers or wrapping.
- Tables: `Copy as TSV` (pastes cleanly into Sheets and Docs) or `Copy as Markdown`.
- Tool calls: `Input` copies the JSON, `Output` copies the full untruncated result even when collapsed.
- Turns: `Copy turn` gives the whole reply as markdown. `Copy conversation` does the whole thread.

**Live inspector.** A right-hand panel with five tabs, driven by the running session rather than
scraped off disk:

- **MCP**: per-server connection status (connected / failed / needs-auth / pending), transport, scope,
  error text, and the full tool list per server. All three Claude Code scopes are read:
  - `user` — `~/.claude.json` top-level `mcpServers`, available everywhere
  - `local` — `~/.claude.json` `projects[<dir>].mcpServers`, that directory only
  - `project` — a `.mcp.json` file committed in the project directory

  Clicking a server expands it and offers **Reconnect**, which retries that one connection via the
  SDK without restarting the session and refreshes the list in place. It is disabled until a session
  is running, and it surfaces the server's real error (e.g. `HTTP 401`) rather than failing quietly.
  Reconnect cannot complete an OAuth sign-in: if a server comes back as needs-auth, run `/mcp` in a
  session to authorise, then reconnect here.

  Servers are grouped into collapsible sections by status, worst first: Failed, Needs auth,
  Connected, Not started, Disabled, then a folded-by-default **Other directories** bucket for
  servers bound to a directory other than the current one. Nothing is hidden just because you are
  pointed elsewhere. Each section header copies its server names in one click. Before a session
  starts the panel labels itself `FROM CONFIG`; once one is running it shows real connection state
  and merges the inactive ones back in.
- **Skills**: every loaded skill with its description, filterable, grouped by plugin namespace.
- **Agents**: subagents available to the session.
- **Plugins**: installed plugins with version, scope, and a reveal-in-Finder action.
- **Usage**: session cost, turns, token counts, and a context-window breakdown by category.

**Model picker.** A dropdown in the titlebar. With a session running it lists the real models the
CLI reports (with pricing and context notes) and switches mid-session via the SDK's `setModel`, so
the next turn uses the new model without losing the conversation. With no session yet it offers the
`opus` / `sonnet` / `haiku` aliases and the next session starts on your pick. The choice persists
across restarts.

**Agent profiles.** A reusable starting prompt applied when a session begins. Pick one from the
titlebar dropdown before starting a chat, or let a group supply its own default. The prompt is
**appended** to Claude Code's system prompt via `{ preset: 'claude_code', append }`, never
substituted for it, so tools, skills, and your CLAUDE.md still apply.

- Manage them in the **Profiles** inspector tab: create, edit, duplicate, delete, copy the prompt,
  and expand any profile to read it in full.
- Each group has a **Default profile** in its `···` menu, and a `+` button that starts a new chat
  carrying that profile.
- The last profile used is remembered across restarts. "No profile" runs plain Claude Code.
- Stored in `~/Library/Application Support/claude-desk/agent-profiles.json`. The built-in lives in
  code and is merged in on read, so that file only appears once you save a change.

Ships with one built-in profile, **Staff AAA PM**, covering the AAA product scope, decision and
stakeholder framing, research-grounding rules, the Slack/email length limits, and read-back
verification of anything created externally. Built-ins are editable and deletable like any other.

**Session groups.** Chrome-tab-group style organisation of your session history. Create a group,
drag sessions into it, rename by double-clicking, recolour from the `···` menu, collapse it.
Persisted to `~/Library/Application Support/claude-desk/session-groups.json`.

**Kroks.** The black-cat pet from `Lab/black-cat-pet`, ported in and anchored to the bottom of the
sidebar. Unlike the standalone app he is not a floating window and cannot be dragged: he is part of
the layout. Same paper-doll layers and idle behaviour as the original (breathing, tail wag, ear
twitch, random blinking, naps after 90s with floating `z`s, petting with hearts, ear flicks), but
his reactions come from this app's own session events rather than the CLI hook bridge:

| Event | Reaction |
| --- | --- |
| You send a message | perks up with a happy wiggle |
| Turn in flight | fast tail wag |
| Permission requested | meow |
| Reply lands | meow |

Sound can be muted from the bar under him. Only the cat was ported; the dog, Toothless, and the
Pokemon sprites were left behind, as were the tray menu, the hook server, and the permission bubble
(this app renders real permission prompts instead).

**Slash autocomplete.** Typing `/` at the start of a message opens a ranked skill menu. Prefix
matches beat namespace matches beat substring beats description hits, so `/pm` surfaces `/pm-reply`
and `/pm:*` first. `↑`/`↓` to move, `Tab` or `Enter` to insert, `Esc` to dismiss. The header shows
the true match count (`60 of 150 skills`) rather than the render cap. Before a session starts it
lists your 4 personal skills from disk; once one is running it lists all 150 the session reports.

**Music.** A collapsible player in the sidebar for background lofi. Paste a YouTube video or
playlist link (watch, `youtu.be`, shorts, embed, and playlist URLs all parse, as does a bare video
id), or use a preset. Volume and the last track persist. See the caveats below.

**Session history.** Every transcript in `~/.claude/projects` is listed and searchable. Click to read
it read-only, or hit `Resume` to continue it as a live session.

**Permission prompts.** Rendered as a real dialog with Allow / Always allow / Deny / Deny and stop.
`Always allow` writes the rule through the SDK's own suggestions, so it persists like the CLI's does.
`Cmd+Enter` allows, `Esc` denies.

## Running

```bash
npm install
npm run dev      # hot-reloading dev build
npm run build    # production build into out/
npm start        # run the production build
```

## How it finds `claude`

A GUI app launched from Finder inherits a stripped PATH, so the binary is resolved in this order:

1. `CLAUDE_DESK_CLI_PATH` if set
2. `which claude` inside a login shell (picks up nvm and asdf shims)
3. `~/.local/bin/claude`, `~/.claude/local/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`

If none resolve, a red banner tells you to set `CLAUDE_DESK_CLI_PATH`.

`CLAUDE_DESK_DEFAULT_CWD` sets the starting working directory. Otherwise the last directory you
used is remembered, falling back to whichever Claude Code project has the most MCP servers
configured. It deliberately does **not** default to `~`: local-scope MCP servers are bound to a
specific directory, so a session rooted at the home directory silently loads none of them. You can
change the directory from the titlebar at any time.

## Architecture

```
src/main/       Node side. Owns the SDK query loop and all filesystem reads.
  agent.ts      AgentSession: streaming-input queue, message-to-Turn mapping,
                canUseTool bridged to the renderer over IPC.
  inspect.ts    Disk fallback for MCP/plugins/skills before a session exists.
  sessions.ts   ~/.claude/projects JSONL listing and transcript parsing.
  server.ts     Loopback static server for the renderer (see Music caveats).
  groups.ts     Session-group persistence (atomic write-then-rename).
  prefs.ts      Last-used cwd, model, and profile; default-directory resolution.
  profiles.ts   Agent-profile storage and the built-in Staff AAA PM profile.
  index.ts      Windows and the IPC surface.
src/preload/    contextBridge. The renderer gets no Node access.
src/renderer/   React 19 UI.
src/shared/     Types shared across the boundary.
                Kroks lives in renderer/src/components/Kroks.tsx + kroks.css,
                ported from Lab/black-cat-pet (credit: Eva Chen's DataDog/bits-pet).
```

Two deliberate choices worth knowing:

- `settingSources: ['user', 'project', 'local']` is set explicitly. The Agent SDK loads **no**
  config by default, which would mean no CLAUDE.md, no skills, no plugins, and no MCP servers.
- Streaming input mode is used even for the first prompt, because `canUseTool` requires it.

## Music caveats

Works, with real limits. Read this before expecting it to behave like the YouTube app.

- **There is no account sign-in, and there cannot be.** Google blocks account sign-in from embedded
  browsers, so Premium, private playlists, likes, and history are all out of reach. Ads can still
  play. The **Open in browser** button hands the link to your real browser, where you are signed in.
- Some videos are embed-disabled by their uploader and will refuse to play. The player surfaces
  YouTube's `onError` when that happens instead of sitting silently.
- It uses the official IFrame Player API, which means loading Google's `iframe_api` script. That
  widens the renderer CSP to allow `https://www.youtube.com` and `https://s.ytimg.com` in
  `script-src`. The postMessage-only alternative avoided that but never delivered reliable
  `onReady`/`onStateChange`, so play/pause did not work.
- **The renderer is served over `http://127.0.0.1` rather than `file://`, and that is load-bearing.**
  A `file://` page has no HTTP origin, and the IFrame player refuses to play with **error 153** when
  it cannot validate one. `src/main/server.ts` runs a loopback-only static server on an
  OS-assigned port for exactly this reason. If it fails to start, the app falls back to `file://`
  and everything works except music. Dev mode already runs on `http://localhost`, which is why it
  behaved differently there.
- `autoplay-policy=no-user-gesture-required` is set on the Electron command line so a saved track
  resumes without a click. Chromium otherwise blocks audible autoplay outright.
- The player reports YouTube's error code rather than guessing (`101`/`150` embedding disabled,
  `100` not found, `2` bad parameter, `5` HTML5 failure, `153` missing origin).
- The default track is set in `DEFAULT_TRACK` in `Player.tsx` and loads on first run or whenever
  nothing is saved. Verified: it autoplays on launch, and pause/resume both round-trip through
  `onStateChange`.
- Prefer normal videos over 24/7 **live streams** as your default. Live streams are much flakier to
  start, which is what made this look broken during development.

## Known limits

- OAuth re-auth for an MCP server cannot be completed in-app. The MCP panel tells you to run `/mcp`
  in a session instead.
- A session running in Ghostty is not shared with this app. Opening its transcript here shows the
  state as of the last write to the JSONL, not live.
- The renderer bundle is ~2.2MB, almost all highlight.js. Fine for a local app, worth trimming if
  startup ever feels slow.
- Permission prompts fall back to `Allow <ToolName>?` as their title. The SDK's richer `title` field
  was not populated for the tools tested, so the fallback is what you will usually see.
- An explicitly picked model always wins over the model the CLI reports in its `init` message. The
  CLI can re-send `init` mid-session naming the model it started on, which would otherwise silently
  revert your choice.
- A profile is applied at session start. Switching profiles mid-conversation is not supported: start
  a new session instead. (Model switching *is* live, via the SDK's `setModel`.)
- Profiles guide the model, they do not constrain it. In testing the Staff AAA PM profile answered
  correctly on scope but still slipped an em-dash into a one-liner despite the instruction against
  them. Treat profile rules as strong defaults, not guarantees.
- A session's group membership survives even if the session drops off the 120-most-recent list the
  sidebar loads; it reappears in its group once it is back in range.
