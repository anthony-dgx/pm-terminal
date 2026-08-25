# Atelier

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
output around it. When you asked for something to send on and Claude fenced it, the button becomes
**Copy draft** and copies just that - not "here is a version you could send" or the offer to adjust
the tone. **Copy all** is next to it for the whole reply.

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

The button only appears on an actual document, meaning something with a heading and a few blocks
under it. An ordinary reply does not get one, however long it runs.

- Select any text and a comment box appears in the rail. `Cmd+Enter` commits it. The text turns
  yellow, and clicking either the highlight or the card links the pair.
- **Edit any paragraph yourself.** Hover a block and click **Edit** to change its markdown in
  place. `Cmd+Enter` applies, `Esc` discards. Comments below the edit follow it, so their
  highlights stay on the right text. Editing is off while a round is in flight, because the
  reply replaces the whole document.
- Your comments are sent **with the current document**, edits included, so Claude rewrites what
  you are actually looking at rather than the version it last wrote.
- **Ready for changes** sends every comment at once and the rewritten document comes back **into
  that window**, ready for the next round. You never go back to the chat.
- Earlier rounds stay in the rail, folded, so you can see what you already asked for.
- If Claude answers with something other than a document, the answer shows in the rail and your
  document is left alone rather than overwritten with prose.

Comments go into the conversation the document came from, so the transcript keeps the whole history.
They live in memory for the session and are not saved to disk.

**Open a markdown file in the same reader.** When Claude reads a `.md` file, that tool call gets an
**Open** button. Nothing opens on its own, because Claude reads markdown all the time and for its
own reasons.

A document opened from a file is a view on that file. Your inline edits save straight to it, and so
does a round of **Ready for changes**, so the file and the window never disagree. The header says
which file it is writing to. A document that came out of the chat still edits the same way - the
change stays in the window and rides into the next round with your comments - it just has no file
to be saved to.

**Sign in to an MCP server.** Type `/mcp` and the panel opens on your servers, worst first. Every
server in the current directory gets a **Sign in** button, whatever its status, disabled only on the
local `stdio` ones that have no sign-in to do: click it, authorize in the browser tab that opens,
and it finishes on its own. If the browser does not come back, paste the URL it ended on into
the box in the dialog. On success the app reconnects the server so its tools load in the session you
are already in, without a restart.

Unless a server is visibly signed out, the button asks first, because Claude Code clears a server's
old tokens before it starts a new flow. Nothing runs until you confirm, so backing out is safe.

**Check your setup.** A side panel shows:

- **MCP** servers with live connection status, worst first, each with **Reconnect** and **Sign in**
- **Skills** available to the session, searchable, plus subagents and plugins
- **Profiles** (below)
- **Usage** for the session: cost, tokens, and how full the context window is

**Know when the app is stale.** The foot of the side panel says whether you are running the latest
code, with the commit you built from. It checks once a day on its own, and `↻` checks on demand.

There is no download behind this. The app is installed by building it from a clone, so "behind"
means that clone's `origin/main` has moved on. When it has, an **Update** button appears: it pulls,
reinstalls dependencies, rebuilds, swaps the installed app and relaunches it - the whole
`npm run install:app` sequence, without the typing.

The app has to quit to be replaced, since it is running from the bundle being swapped. It says so
first, and counts any sessions still working that would be stopped. It refuses if the clone has
uncommitted changes, if it is not on `main`, or if its `main` has diverged from `origin/main`,
because none of those is something a button should decide for you. It only ever fast-forwards, so
it cannot move work you had in progress. The swap builds a copy alongside the old app and only
removes the old
one once the new one is in place, so a failure leaves the version you had rather than nothing.

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
player for background lofi. The music does not start on its own - a track is queued and waiting,
but nothing plays and nothing connects to YouTube until you press play.

## Getting started

You need [Node.js](https://nodejs.org/) and a working Claude Code install, meaning `claude` runs in
your terminal.

```bash
npm install
npm run build
npm start
```

`npm run dev` also works and reloads as you edit.

If `npm start` fails with **`Error: Electron uninstall`**, the Electron binary was never downloaded.
Recent npm blocks dependency install scripts until they are approved, and Electron's is the one that
fetches its binary - so everything installs, everything builds, and only the launch fails. `npm
install` now repairs this itself. To fix it by hand:

```bash
node node_modules/electron/install.js
```

Keep the clone after installing. The installed app has no updater of its own: it remembers where it
was built and rebuilds itself there. Delete the clone and the version line in the side panel goes
quiet, and you are back to reinstalling by hand.

The app opens in the last directory you used. Click the path in the title bar to change it, which
matters because some MCP servers are configured per directory.

**If you had Claude Desk installed**, this is the same app under a new name. Run `npm run
install:app` once by hand: the Update button cannot do this particular hop, because the version you
are running looks for a bundle called `Claude Desk.app` and the build now produces `Atelier.app`.
Your themes, session groups and agent profiles carry over on first launch. Delete the old
`Claude Desk.app` from `~/Applications` afterwards. Later renames clean up after themselves.

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
- **Signing in again on a working server signs it out first.** The CLI clears the existing tokens
  before it starts the new flow, so if you abandon the browser step the server is left signed out.
  The app warns you and waits for a confirmation before it starts.
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
  mcpAuth.ts    `claude mcp login` under a pty, for MCP OAuth sign-in.
  sessions.ts   ~/.claude/projects transcript listing, parsing and renaming.
  groups.ts     Session groups.       prefs.ts      Window, theme, last-used state.
  profiles.ts   Agent profiles, including the built-ins.
  server.ts     Loopback static server for the renderer (see below).
  index.ts      Windows and the IPC surface. Also the reader's file access:
                reads are limited to markdown, and a write has to match the path
                the calling window was opened on, so a review window can save
                its own document and nothing else.
src/preload/    contextBridge. The renderer gets no Node access.
src/renderer/   React 19 UI. Themes are CSS variable swaps on a data-theme attribute.
src/shared/     Types shared across the boundary.
```

Five decisions are load-bearing. Each one broke something real when it was missing:

- **`settingSources: ['user', 'project', 'local']`** is set explicitly. The Agent SDK loads *no*
  config by default, which would mean no CLAUDE.md, no skills, no plugins and no MCP servers.
- **Streaming input mode** is used even for the first prompt, because permission prompts
  (`canUseTool`) do not work without it.
- **The renderer is served over `http://127.0.0.1`**, not `file://`. A `file://` page has no HTTP
  origin and the YouTube player refuses to start, with error 153.
- **Profile prompts are appended** to Claude Code's own system prompt rather than replacing it, so
  its tool and skill guidance survives.
- **MCP sign-in runs `claude mcp login` through a pty**, not through the Agent SDK. The SDK cannot
  start an OAuth flow at all: `reconnectMcpServer` throws on a needs-auth server, `/mcp` only prints
  a summary, and such a server's tools never reach the model, so nothing elicits. The CLI can do it,
  but it aborts unless stdin is a terminal - the check is unconditional, so a piped child process
  never finishes even though the loopback callback is already listening. `node-pty` satisfies it.
  Its prebuild is N-API, so it loads in Electron without a rebuild, but `spawn-helper` ships without
  its executable bit (`scripts/fix-node-pty.mjs` restores it on install) and node-pty has to be in
  `asarUnpack`, because that helper is a real executable and cannot be run from inside an asar.

Two environment variables: `ATELIER_CLI_PATH` to point at a specific `claude` binary, and
`ATELIER_DEFAULT_CWD` to force a starting directory. The app was called Claude Desk before, so
`CLAUDE_DESK_CLI_PATH` and `CLAUDE_DESK_DEFAULT_CWD` are still read; the new names win when both
are set.

The icon and the titlebar mark are both generated from one illustration by `python3
scripts/make-icon.py`, which is run by hand and not on install. The source art is committed next to
it, so the crop and the inset can be changed later without reverse-engineering a PNG.

Kroks, the cat, is ported from `Lab/black-cat-pet`, itself a fork of DataDog/bits-pet by Eva Chen.
The rodeo horse is a second cast on the same rig. Catppuccin Mocha uses the published palette from
[catppuccin.com](https://catppuccin.com/).
