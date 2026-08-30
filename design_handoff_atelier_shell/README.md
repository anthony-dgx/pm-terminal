# Handoff: Atelier agent terminal — shell redesign

## Overview
Atelier is an internal desktop terminal that runs many Claude agent sessions in parallel and surfaces
MCP servers, skills and profiles. This handoff covers a redesign of its **shell** — the frame around the
transcript: session list, status chrome, failure surfacing, and spend/context readouts.

Problems the redesign targets, stated by the product owner:
1. The session list is hard to scan and search.
2. Too many chrome elements compete for attention.
3. Errors and warnings (failed MCP servers, servers needing auth) are easy to miss.
4. There is no sense of cost or token usage.
5. Space in the transcript area is wasted.

Design constraints applied: parallel work is the default (many concurrent sessions); MCP is demoted to a
diagnostic surface that only speaks up when broken; palette limited to **two hues plus neutrals** —
violet = active/primary, amber = a human is needed, grey = everything else. No green/red status colors.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and
behavior, not production code to copy directly. The task is to **recreate these designs in the target
codebase's existing environment** (Electron + React, Tauri, etc.) using its established patterns,
component library and state layer. If no environment exists yet, choose the most appropriate framework
and implement there. The HTML uses a bespoke streaming-template runtime (`support.js`, `<x-dc>`,
`<sc-if>`); none of that should be ported — read it as markup + inline styles only.

## Fidelity
**High-fidelity.** Colors, typography, spacing and copy are final and specified exactly below. Recreate
pixel-accurately using the codebase's existing libraries. Numbers shown are a mix of real content (the
"ddd" session, the github/higgsfield/Neon MCP failures, 103 servers, 85 skills, 6 profiles, build b23ca1d)
and plausible placeholders (token counts, dollar figures, the two extra sessions) — treat figures as
illustrative, structure as final.

## Three directions
The file contains **three alternative shells side by side** on one canvas, ids `1a`, `1b`, `1c`. They are
mutually exclusive proposals, not screens of one flow. Each is framed at **1340 × 830** with a
10px-radius window, 1px #2A2136 border, and `0 24px 64px rgba(0,0,0,.5)` shadow. Pick one before building.

---

## Screen 1a — "Board"
**Purpose:** the session list *is* the home screen. You land on a status board of all agents, not a chat
window with a list bolted on. Opening a session replaces the board.

**Layout** (vertical flex, top to bottom):
1. **Title bar**, 52px, bg #120E1A, 1px bottom border #241C30, 18px side padding, 14px gap.
   - 3 window dots, 11px circles, #3E3648, 7px gap.
   - App mark: 22px square, 5px radius, `var(--dd-gradient-brand)`, letter "A" Roboto 900 13px white.
   - Wordmark "Atelier" — display 700 14px #EDEAF2, letter-spacing -.005em.
   - 1px × 20px divider #2A2136.
   - Directory chip: bg #17121F, 1px #2A2136, 5px radius, 5/10px padding, mono 12px —
     `~/lab/` in #7A7188 + `pm-terminal` in #EDEAF2 + ▾ in #6F667E.
   - Spacer, then right-aligned plain-text readouts (no chips, deliberately): `$18.40 today · 1.24M tok`
     (mono 12px #A79FB5, separator #7A7188), `● MCP 4/103` (7px amber #FF9B00 dot),
     `sonnet 4.5 ▾`, `no profile ▾` (#6F667E).
2. **Attention line**, ~44px, transparent bg, 1px bottom border #241C30, 12/18px padding, 14px gap.
   - `● 3 NEED YOU` — 7px #FF9B00 dot + mono 700 12px #FFBB4D, letter-spacing .11em.
   - One run-on summary, mono 12px #A79FB5, flex:1:
     `plugin:github:github failed · higgsfield and Neon need auth · claude.ai connectors disabled by ANTHROPIC_API_KEY`
     (separators #7A7188).
   - `Review` — mono 12px #FFBB4D, underlined, text-only.
3. **Filter/tool row**, 14/18px padding, 8px gap. Tabs are text-only: active `All 12` #EDEAF2 with a 1px
   #9C43FE bottom border; `Running 2`, `Needs you 2`, `Done 7`, `Group 1` in #6F667E, 12px left margin each.
   Right side: 300px search field (bg #17121F, 1px #2A2136, 5px radius, 7/11px padding) containing mono `/`
   #7A7188, placeholder "Search sessions, paths, output…" 13px #6F667E, and a ⌘K key hint
   (mono 11px #7A7188, 1px #2A2136, 3px radius). Then primary button `＋ New session` — bg #5C00EF,
   white mono 500 12px, 7/14px padding, 4px radius.
4. **Card grid**, flex:1, `grid-template-columns: repeat(3,1fr)`, `grid-template-rows: repeat(2,1fr)`,
   14px gap, 6/18/18px padding.

**Session card** — bg #17121F, 1px #2A2136, 8px radius, 16/17px padding, column flex, 11px gap:
- Status row: 7–8px status dot; state label mono 700 11px letter-spacing .11em; spacer; elapsed mono 11px #7A7188.
- Prompt title — body 500 16px #EDEAF2, line-height 1.3 (the session's prompt text, verbatim).
- Path — mono 11px #7A7188.
- Live line — mono 12px/1.55, plain text (no nested box, 2px vertical padding): #A79FB5 normally,
  #A79FB5 with an amber cue for failures, prefixed `›` for tool activity, `✓` for completion.
- Spacer, then for RUNNING a 3px progress track (bg #241C30, fill #5C00EF, 2px radius).
- Footer row: outline actions — mono 12px #EDEAF2, 1px #3A3245, 5/11px padding, 4px radius
  (`Reply`, `Reconnect`, `Logs`, `Open`, `Archive`); spacer; per-session usage mono 11px #7A7188 (`142K · $0.86`).

States and their colors (border stays #2A2136 for all except DONE, which uses #241C30 with bg #141019):
| State | Dot | Label color | Label |
|---|---|---|---|
| Waiting on you | #FF9B00 | #FFBB4D | WAITING ON YOU |
| Running | #9C43FE, pulsing | #A79FB5 | RUNNING |
| Blocked | #FF9B00 | #FFBB4D | BLOCKED |
| Done | #6F667E | #8C8C99 | DONE |

Last grid cell is a **new-session affordance**: 1px dashed #2A2136, 8px radius, centered — mono 26px ＋
#6F667E over "New session in ~/lab/pm-terminal" mono 12px #7A7188.

5. **Status footer**, 30px, bg #120E1A, 1px top border #241C30, mono 11px #7A7188:
   `7 earlier today · 7 this week · 38 before` … `Skills 85` `Profiles 6` `b23ca1d`.

---

## Screen 1b — "Focus + inspector" (recommended)
**Purpose:** keeps today's three-column shell but changes each panel's job. Sessions become status-first
rows you scan instead of click; the transcript gets a reading measure; the right panel is a diagnostic
inspector that leads with what's broken.

**Layout:** 48px title bar, then a 3-column flex row.

**Title bar** (48px, bg #120E1A, 1px bottom #241C30, 16px padding, 12px gap): window dots, 20px app mark,
path mono 12px, 1px divider, then two live counts —
`● 2 running` (7px #9C43FE pulsing dot, #A79FB5 text) and `● 2 need you` (#FF9B00 dot, #FFBB4D text).
Spacer. Right: `sonnet 4.5 ▾` chip (bg #17121F, 1px #2A2136, 4px radius, 4/10px) and `no profile ▾` chip
(#6F667E). **No cost readout here** — spend lives only in the inspector.

**Left column — sessions**, 308px, bg #110D18, 1px right border #241C30:
- Header row, 12px padding: search field (as 1a, flex:1) + 7/11px `＋` button bg #5C00EF, 5px radius.
- **Group headers**: mono 700 10px letter-spacing .12em #6F667E + a neutral count in mono 10px #6F667E
  (no colored badges) + a 1px #1F1929 rule filling the rest. Groups in order:
  `NEEDS YOU 2`, `RUNNING 2`, `DONE TODAY 8`.
- **Session row**: 8px side margin, 11/12px padding, 6px radius, column flex, 6px gap.
  - Line 1: 7px status dot (flex:none) · title 13px, single-line ellipsis (#EDEAF2 when selected, else #C6C0D1) · elapsed mono 10px #7A7188.
  - Line 2: live status, mono 11px/1.45, single-line ellipsis — #FFBB4D for needs-you/blocked, #8C8C99 for running (`› pnpm install · step 3/11`).
  - Line 3 (needs-you rows): path + token count, mono 10px #A79FB5, space-between.
  - Line 3 (running rows): 2px progress track, bg #241C30, fill #9C43FE.
  - Selected row: bg #1E1729, **no left accent bar**. Done rows collapse to a single 9/12px line with a #6F667E dot and #8C8C99 title.
- Footer, 1px top #1F1929, mono 11px #7A7188: `This week 7` `Before 38` … `b23ca1d`.

**Center column — transcript**, flex:1, bg #0E0B14:
- Session header, 12/24px padding, 1px bottom #1F1929: status dot, session name 14px 500 #EDEAF2,
  meta mono 11px #7A7188 (`~/lab/pm-terminal · 2 turns · started 4m ago`), spacer, three outline actions
  (`Rename`, `Group 1 ▾`, `Fork`) — mono 11px #A79FB5, 1px #2A2136, 4/9px, 4px radius.
- Body: **720px max-width, centered**, 26px vertical padding, 24px gap between turns. Each turn is a
  14px-gap row: a right-aligned 52px speaker gutter — mono 700 10px letter-spacing .11em,
  `YOU` #6F667E / `CLAUDE` #9C43FE — then the content, flex:1. **No message bubbles or boxes.**
  User text is mono 14px/1.6 #EDEAF2; assistant text is body 15px/1.62 #C6C0D1. Thinking collapses to an
  inline pill `▸ thought for 3s` (mono 11px #7A7188, 1px #241C30, 4px radius, 3/9px). Lists use an em dash
  in #5C00EF as the marker, 10px gap, 7px between items. Per-turn usage line: mono 10px #7A7188
  (`4.1K in · 0.3K out · $0.02 · 2.4s`).
- Composer, 24px side / 18px bottom padding, same 720px measure:
  - Dismissible warning strip above it — bg #17121F, 1px #241C30, 5px radius, 7/12px padding: mono 11px
    #FFBB4D message, underlined `How to fix`, and a ✕ in #7A7188.
  - Input: 1px #2A2136, 8px radius, bg #141019, 13/14px padding. Placeholder "Message Claude…" 14px #5F5670.
    Below it a control row: three outline hint chips (`/ skills`, `@ files`, `↑ history` — mono 11px #A79FB5,
    1px #2A2136, 3/8px, 4px radius), spacer, key hint `⏎ send · ⇧⏎ newline` mono 11px #7A7188, and a
    `Send` button bg #5C00EF white mono 500 12px 6/14px.

**Right column — inspector**, 352px, bg #110D18, 1px left border #241C30:
- Tab strip, 10/12px padding, 1px bottom #1F1929: active `● MCP 4/103` (bg #1E1729, 1px #2A2136, 4px radius,
  5/10px, 6px #FF9B00 dot), then `Skills 85`, `Usage` in #6F667E, spacer, ↻ and › glyphs #6F667E.
- Summary block, 14px padding, 1px bottom #1F1929: heading mono 700 11px letter-spacing .11em #FFBB4D
  `3 SERVERS NEED ATTENTION`, and a single mono 11px #6F667E line
  `1 failed · 2 need auth · 4 connected · 1 pending` — no stacked bar, no colored figures.
- **Only broken servers are expanded.** Failed card: bg #17121F, 1px #241C30, 6px radius, 11/12px padding —
  7px #FF9B00 dot, name mono 12px #EDEAF2, `FAILED` mono 10px #FFBB4D; reason mono 11px/1.5 #A79FB5
  (`spawn failed: gh auth token returned 401 · dynamic · http`); actions `Reconnect` and `Logs` as outline
  buttons (mono 11px #EDEAF2, 1px #3A3245, 4/10px); right-aligned consequence `blocks 1 session` mono 10px #6F667E.
  Needs-auth card groups `higgsfield` and `Neon` with one `Authorize both` outline button.
- Healthy and irrelevant servers collapse to **one row each**: `● 4 connected — codex-cli, elevenlabs, slack, trajectory ▾`,
  `● 1 not started — google-workspace ▾`, `95 configured for other directories ▾` (mono 12px #A79FB5 label,
  11px #6F667E detail, 1px #241C30 / #1F1929 border, 6px radius).
- Spacer, then two stacked footer blocks:
  - **SPEND · TODAY**, 11/14px padding, 1px top #1F1929, 7px gap. Label row: mono 700 10px .12em #6F667E,
    spacer, `1.24M tok` #7A7188, `$18.40` mono 500 11px #EDEAF2. Then a **4px model-split bar**
    (2px gaps, 1px radius): opus 61% #9C43FE, sonnet 37% #5C00EF, haiku 2% #332851. Then one row per model,
    mono 10px, 4px gap: 6px swatch (2px radius, same colors) · name #C6C0D1 · tokens #7A7188 ·
    cost right-aligned in a 40px column #A79FB5 — `opus 4.1 210K $11.20`, `sonnet 4.5 940K $6.80`,
    `haiku 4.5 90K $0.40`. The point of the chart is the split between models, not a time series.
  - **CONTEXT · <session>**, 14px padding, 1px top #1F1929, 9px gap: label mono 700 10px .12em #7A7188,
    spacer, percentage mono 11px #A79FB5; a 5px full-width track (bg #241C30, fill #9C43FE, 2px radius);
    then `8.2K of 200K tokens` mono 10px #7A7188 and a right-aligned outline `Clear context` button
    (mono 11px #EDEAF2, 1px #3A3245, 4/10px, 4px radius).

---

## Screen 1c — "Status line"
**Purpose:** the most aggressive answer to competing chrome — delete the panels. The transcript owns the
window; everything else is a gutter, a status line, or the command palette.

- **Session gutter**, 52px, bg #100C16, 1px right #1F1929, 12px vertical padding, 10px gap, centered:
  24px app mark, then one 30px square per session (8px radius) containing only an 8px status dot.
  Selected session gets 1.5px #9C43FE border + bg #1E1729. Overflow reads `+38` mono 10px #7A7188.
  Bottom: 30px dashed-border ＋ tile.
- **Main column**: a context strip at 16/32px — mono 700 11px .12em #FF9B00 `WAITING ON YOU` plus
  mono 11px #7A7188 `ddd · ~/lab/pm-terminal · 4m`.
- **Transcript**, 820px max-width centered, 26/32px padding, 28px gap. Speaker labels sit **above** each
  turn (not in a gutter): mono 700 10px .12em, `YOU · 4M AGO` #6F667E / `CLAUDE` #9C43FE.
  Assistant prose is 16px/1.6 #C6C0D1 capped at 70ch with `text-wrap: pretty`; user text mono 15px/1.6 #EDEAF2.
- **Composer**: single 820px row, 1px #2A2136, 8px radius, bg #131019, 12/14px padding — mono `›` #9C43FE,
  placeholder "Message Claude, or ⌘K for anything else" 14px #5F5670, `⏎` hint mono 11px #7A7188.
- **Status line**, 28px, bg #100C16, 1px top #1F1929, mono 11px, segments at 12px horizontal padding:
  `~/lab/pm-terminal` (bg #5C00EF, white, 500) · `sonnet 4.5` #A79FB5 · `no profile` #6F667E ·
  `● 2 running` (#9C43FE dot, #A79FB5) · `● 2 need you` (#FF9B00 dot, #FFBB4D) ·
  `● mcp 1 failed · 2 auth` (#FF9B00 dot, #FFBB4D) — spacer — `1.24M tok · $18.40` #A79FB5 · `b23ca1d` #7A7188.
- **Command palette** (shown open, overlaying the transcript): 660px wide, 96px from top, centered,
  bg #181221, 1px #2A2136, 10px radius, `0 32px 80px rgba(0,0,0,.7)` shadow.
  Query row: 14/16px padding, 1px bottom #241C30 — mono `›` #9C43FE, query `mcp` mono 14px #EDEAF2,
  a 1px × 16px #9C43FE caret (step-end blink), spacer, `esc to close` mono 10px #7A7188.
  Results: section header mono 700 10px .12em #6F667E `NEEDS ATTENTION`, then 9/10px rows with 5px radius,
  11px gap — dot · name mono 13px · detail mono 11px flex:1 · key hint `⏎ reconnect` on the highlighted row
  (bg #1E1729). Diagnostics carry their consequence inline: `401 from gh auth token · blocks "gco jojo/CCT-1681-cards"`.
  A 1px #241C30 rule separates healthy/collapsed rows. Footer: 9/16px, bg #141019, 1px top #241C30,
  mono 10px #7A7188 — `↑↓ move`, `⏎ run`, `type "session", "skill", "usage", "profile"…`.

---

## Interactions & Behavior
- **Session selection:** 1a — clicking a card opens that session's transcript in place of the board (a Back
  affordance returns). 1b/1c — selection swaps the center column only; the list/gutter never moves.
- **Search:** `/` or ⌘K focuses search. It must match session titles, working directories **and transcript
  output** — finding things is the stated pain point.
- **Attention surfacing:** any session in needs-you or blocked state sorts to the top of its column and
  contributes to the header count. The 1a attention line and the 1c status-line segment are always visible
  when count > 0 and absent (not empty) when count is 0.
- **MCP:** the panel/palette is diagnostic. Broken servers render expanded with a primary recovery action;
  healthy ones stay collapsed. `Reconnect` retries the spawn and shows inline progress; `Logs` opens stderr.
  A failed server must name the sessions it blocks.
- **Clear context:** confirms, then starts a fresh context window for the current session, preserving the
  session record. The context bar resets to the post-clear baseline.
- **Progress bars:** static fills driven by real step counts. Do **not** animate an indeterminate crawl —
  the redesign deliberately removed it.
- **Motion:** the only continuous animation is a 1.8–2.4s opacity pulse (1 → .3 → 1, ease-standard) on
  running dots and the palette caret. Everything else is 120–360ms fades / small translates per the DS.
- **Hover:** rows and cards lighten one surface step (#17121F → #1E1729); outline buttons brighten border
  #3A3245 → #4A4257; the violet primary darkens.

## State Management
Per session: `id`, `title` (prompt text), `cwd`, `state` (`needs_you` | `running` | `blocked` | `done`),
`startedAt`, `elapsed`, `lastLine` (latest tool/output line), `progress` ({done, total}), `turns`,
`tokensIn`/`tokensOut`, `cost`, `contextUsed`/`contextLimit`, `model`, `profile`, `group`.
Global: `sessions[]`, `filter`, `query`, `selectedId`, `mcpServers[]` ({name, scope, transport, status,
error, blockedSessionIds}), `skillCount`, `profiles[]`, `usage.today` ({tokens, cost, byModel[]}), `build`.
Derived: running/needs-you counts, attention list, model spend split, context percentage.
Streaming: live output lines and token counters arrive per session and must update the list rows and status
line without re-rendering the transcript.

## Design Tokens
Palette (deliberately two hues + neutrals; **no green/red status colors**):
- Violet: #5C00EF primary action · #9C43FE active/accent · #40007F, #2A0A5E, #332851 deep · #CC99FE tint · `var(--dd-gradient-brand)` app mark
- Amber (needs human): #FF9B00 dot · #FFBB4D text/label
- Surfaces: #08060C canvas · #0B0910, #0E0B14 window · #100C16, #110D18, #120E1A chrome · #131019, #141019 inset · #17121F card · #181221 palette · #1E1729, #241830 selected
- Borders: #1F1929 · #241C30 · #2A2136 · #3A3245 (button) · #3E3648 (window dots)
- Text: #EDEAF2 primary · #C6C0D1 body · #A79FB5 secondary · #8C8C99 muted · #7A7188 tertiary · #6F667E hint · #5F5670 placeholder
- Radii: 3px key hints · 4px buttons/chips · 5px fields · 6px rows · 8px cards · 10px window
- Shadows: `0 24px 64px rgba(0,0,0,.5)` window · `0 32px 80px rgba(0,0,0,.7)` palette
- Type: `--font-display` / `--font-body` (Roboto → National 2) for prose and titles; `--font-mono`
  (Roboto Mono) for **every** status, path, count, figure, key hint and eyebrow. Eyebrows are 10–12px,
  700, letter-spacing .11–.12em, uppercase. Prose 15–16px / line-height 1.6. Nothing below 10px.
- Spacing rhythm: 4 / 6 / 8 / 10 / 12 / 14 / 18 / 24 / 32px. All sibling groups laid out with flex/grid + `gap`.

## Assets
No images. The app mark is a gradient square with a letter; every glyph is a Unicode character
(＋ › ▾ ↻ ⏎ ⇧ ⌘ ↑↓ ✓ ▸ ✕ —). In production, replace the Unicode glyphs with the codebase's icon set
(the DS suggests Lucide as a stand-in for Datadog's marketing icons). Fonts come from the Datadog DS
bundle in `_ds/`.

## Files
- `Atelier Shell.dc.html` — the design: all three shells, top-level `<section>` containing `#1a`, `#1b`, `#1c`.
  Markup + inline styles are the spec; ignore the `<x-dc>` / `<sc-if>` runtime wrappers.
- `support.js` — the prototype runtime. **Not for porting**; present only so the HTML opens locally.
- `_ds/lh-datadog-design-system-.../colors_and_type.css`, `styles.css`, `_ds_bundle.js` — Datadog design
  system tokens and components used by the prototype. If your codebase already has the Datadog design
  system, use that instead of these copies.

## Notes for the implementer
- The redesign moved off the original amber-on-black terminal palette to the Datadog dark UI. If the app
  must keep an amber terminal identity, remap: violet → amber accents, amber → a second attention hue —
  but keep the two-hue discipline, which is the core of the visual fix.
- `sc-if` blocks in the source are prototype toggles for showing/hiding spend and live-output lines. Both
  should be **on** in production; they exist so the shells can be reviewed without those readouts.
