# Claude Desk

A desktop app for Claude Code, for people who use it all day but do not want to live in a terminal.

It runs the real Claude Code underneath, so everything you have already set up keeps working: your
`CLAUDE.md`, your skills, your plugins, your MCP servers, your permission rules. Nothing is
reconfigured, nothing is duplicated. Same agent, better window.

## Who this is for

Product managers and other non-engineers who use Claude Code for real work and keep hitting the same
walls:

- **Getting text back out.** Selecting a reply in a terminal is fiddly. Here one button copies the
  answer, clean, ready to paste into a doc or Slack.
- **Reading the conversation.** A terminal prints every tool call inline, so the answer is buried in
  machinery. Here it reads like a chat, and the work folds away behind a single line.
- **Knowing what is loaded.** You probably cannot say which of your MCP servers are connected right
  now, or which skills are available. There is a panel for that.
- **Losing your place.** Sessions are listed, searchable, groupable and renameable, and several can
  run at once without interfering with each other.

If you are happy in the terminal and none of that bothers you, you do not need this.

## What you can do

**Chat with Claude and actually read it.** Messages appear as a conversation with avatars and
bubbles. Each reply has a **Copy answer** button that copies the reply text only, without the tool
output around it.

**See what the agent did, only when you care.** Every reply folds its work behind one line, like
`3 steps · Bash, Read · 4.2s`. Click to see the tool calls, their inputs and their full output.
While Claude is working, a bar shows what it is doing right now and for how long, with a Stop button.

**Run several sessions at once.** Start something slow in one, switch to another and keep working.
Each keeps its own conversation, and the sidebar marks the ones still running.

**Organise your history.** Every past session is listed and searchable, split into Today / This week
/ Before. Make coloured groups, file sessions into them by dragging or from the `···` menu, rename
anything by double-clicking, and reorder groups. Click a session and start typing to carry on where
you left off, on the model it was already using.

**Review a document the way you would in Google Docs.** When Claude writes a document, the reply
carries a **Review** button - on a fenced markdown block, or on the whole answer. It opens the
document in **its own window**, formatted, with a comment rail down the side.

- Select any text and a comment box appears in the rail. `Cmd+Enter` commits it. The text turns
  yellow, and clicking either the highlight or the card links the pair.
- **Ready for changes** sends every comment at once and the rewritten document comes back **into
  that window**, ready for the next round. You never go back to the chat.
- **Iterate** asks Claude how it would address each comment without rewriting anything yet. The
  answer appears at the top of the rail.
- Earlier rounds stay in the rail, folded, so you can see what you already asked for.

Comments go into the conversation the document came from, so the transcript keeps the whole history.
They live in memory for the session and are not saved to disk.

**Check your setup.** A side panel shows:

- **MCP** servers with live connection status, worst first, each with a **Reconnect** button
- **Skills** available to the session, searchable, plus subagents and plugins
- **Profiles** (below)
- **Usage** for the session: cost, tokens, and how full the context window is

**Paste screenshots.** Paste or drop an image straight into the message box.

**Agent profiles.** A reusable set of instructions applied when a session starts, so you stop
retyping the same context. Choose one per session, or give a group a default. Two ship with the app:

- **Staff AAA PM** - Datadog AAA product scope, decision and stakeholder framing, research
  grounding, and the Slack and email length limits
- **Cowboy** - talks like a cowboy when chatting with you, and plainly in anything you would
  actually ship

Write your own in the Profiles tab.

**Themes.** Default, [Catppuccin](https://catppuccin.com/) Mocha, and Cowboy. Cowboy also swaps the
desk pet for a rodeo horse and the music for something more appropriate.

**Small comforts.** A pixel pet in the corner that reacts to what the agent is doing, and a music
player for background lofi.

## Getting started

You need [Node.js](https://nodejs.org/) and a working Claude Code install, meaning `claude` runs in
your terminal.

```bash
npm install
npm run build
npm start
```

`npm run dev` also works and reloads as you edit.

The app opens in the last directory you used. Click the path in the title bar to change it, which
matters because some MCP servers are configured per directory.

## Keyboard shortcuts

| | |
| --- | --- |
| `Cmd+T` | New session |
| `Cmd+G` | New group |
| `Cmd+B` | Show or hide the sessions panel |
| `Cmd+I` | Show or hide the side panel |
| `Enter` | Send |
| `Shift+Enter` | New line |
| `/` | Skill autocomplete |
| `↑` | Previous message you sent, like a terminal |

## Known limits

- **Claude cannot ask you a multiple-choice question.** If the agent reaches for its question tool
  the turn stalls, because the app has no dialog for it yet. Ask it to reply in prose instead.
- **No YouTube account.** Music plays through a public embed, so no Premium, no private playlists,
  and ads can still play. Google blocks sign-in inside apps like this one. "Open in browser" hands
  the link to your real browser.
- **Signing in to an MCP server** still needs `/mcp` in a session. Reconnect retries a connection
  but cannot complete an OAuth login.
- **Sessions running in a terminal** show up here, but only as of their last save, not live.
- **Deleting a built-in profile does not stick.** It returns next launch. Edit it instead.

---

## How it works

Implementation detail from here, useful if you are changing the code.

The app drives the real `claude` binary through the Claude Agent SDK. Each conversation gets its own
agent session keyed by a renderer-side id, and every event the main process emits carries that id,
so it lands in the right conversation even when that one is not on screen.

```
src/main/       Node side. Owns the SDK sessions and all filesystem reads.
  agent.ts      One AgentSession: streaming-input queue, message-to-turn mapping,
                permission prompts bridged to the renderer over IPC.
  inspect.ts    MCP, plugins and skills read from disk before a session exists.
  sessions.ts   ~/.claude/projects transcript listing, parsing and renaming.
  groups.ts     Session groups.       prefs.ts      Window, theme, last-used state.
  profiles.ts   Agent profiles, including the built-ins.
  server.ts     Loopback static server for the renderer (see below).
  index.ts      Windows and the IPC surface.
src/preload/    contextBridge. The renderer gets no Node access.
src/renderer/   React 19 UI. Themes are CSS variable swaps on a data-theme attribute.
src/shared/     Types shared across the boundary.
```

Four decisions are load-bearing. Each one broke something real when it was missing:

- **`settingSources: ['user', 'project', 'local']`** is set explicitly. The Agent SDK loads *no*
  config by default, which would mean no CLAUDE.md, no skills, no plugins and no MCP servers.
- **Streaming input mode** is used even for the first prompt, because permission prompts
  (`canUseTool`) do not work without it.
- **The renderer is served over `http://127.0.0.1`**, not `file://`. A `file://` page has no HTTP
  origin and the YouTube player refuses to start, with error 153.
- **Profile prompts are appended** to Claude Code's own system prompt rather than replacing it, so
  its tool and skill guidance survives.

Two environment variables: `CLAUDE_DESK_CLI_PATH` to point at a specific `claude` binary, and
`CLAUDE_DESK_DEFAULT_CWD` to force a starting directory.

Kroks, the cat, is ported from `Lab/black-cat-pet`, itself a fork of DataDog/bits-pet by Eva Chen.
The rodeo horse is a second cast on the same rig. Catppuccin Mocha uses the published palette from
[catppuccin.com](https://catppuccin.com/).
