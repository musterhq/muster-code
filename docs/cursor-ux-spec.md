# Cursor UX — measured spec (the acceptance bar for Muster Code)

Measured 2026-09-03 from Cursor 3.18.25's own app bundle (Code-OSS 1.128 base), its
docs/changelog frames, and live screenshots on the owner's Mac. Every value here is
read from Cursor's theme JSON or workbench CSS — not estimated. Reference frames:
`docs/reference/`.

## 1. What Cursor is, structurally
- A Code-OSS distribution: `product.json` with its own gallery
  (`marketplace.cursorapi.com`), `dataFolderName: .cursor`, no `defaultChatAgent`
  (its agent is native workbench code), ~20 built-in `cursor-*` extensions
  (agent-host/worker/exec, always-local, browser-automation, checkout, commits,
  explorer, file-service, local-agent-runtime, mcp, retrieval, shadow-workspace,
  socket, worktree-textmate) and a patched workbench with `composer-*` /
  `agent-layout` / `agent-sidebar-cell` / `cursorGhostTextWidget` CSS.
- Muster Code mirrors the shape: Code-OSS 1.126 base, built-in `muster.muster-code`,
  native chat workbench via `defaultChatAgent` + proposal grants, muster core as
  the agent runtime. Where Cursor patched the workbench, we first use the native
  chat/inline-chat/chat-editing surfaces the OSS build already ships, then patch.

## 2. Theme — "Cursor Dark" (default) → Muster Dark
Neutral structure (kept exactly; these are generic values):
| role | value |
|---|---|
| editor.background | #181818 |
| chrome (sideBar/activityBar/panel/statusBar/titleBar/tabs bg, editorWidget) | #141414 |
| editor.foreground / `--cursor-base` | #F0F0F0 |
| tab.activeBackground | #181818 |
| sideBar.border / input.border | #F0F0F013 (7.5% fg) |
| input.background | #F0F0F00A (4%) |
| input.placeholderForeground | #F0F0F099 (60%) |
| focusBorder | #F0F0F026 (15%) |
| list.activeSelectionBackground | #F0F0F01E (12%) |
| list.hoverBackground | #F0F0F011 (6.7%) |
| diff inserted text / line | #3FA26622 / #3FA26633 |
| diff removed text / line | #B8004922 / #B8004933 |
| gutter added / deleted | #3FA266 / #E34671 |
Accent (Cursor: steel blue `button.background #81A1C1`, `badge #88C0D0`,
`textLink #81A1C1`). Muster Dark uses muster's identity instead: links/badges/
selection caret = periwinkle `#B0B8F8` (the owner-matched value), buttons a
desaturated periwinkle `#8F97E6` with ink foreground `#14162A`; coral is reserved
for the wordmark. Everything else is identical to the table above.
Base palette Cursor derives semantics from: blue #7BAFE9 · green #3FA266 ·
red #FC6B83 · yellow (charts) · cyan #81A1C1 · magenta #B48EAD · purple #9386F2 ·
orange #D08770 · added #70B489 · removed #FC6B83 · modified #F1B467.

## 3. Design tokens (the alpha-layer system)
All chrome tints are `color-mix` of the editor foreground over transparent —
this is what makes Cursor feel "one material":
- `--cursor-bg-primary` 20–48% fg · `secondary` 14–20% · `tertiary` 6–8% ·
  `quaternary` 6% · `quinary` 4%
- `--cursor-text-primary` = fg · `text-secondary` ≈ 55% · `text-tertiary` ≈ 37% ·
  `icon-secondary` 66–76%
- strokes: `stroke-primary/secondary/tertiary` (fg at descending alpha)
- mode colors: each mode = base color at 6% bg / full text — chat green, plan
  yellow, debug red, spec cyan, background magenta, multitask purple
- semantic git: added/modified/removed/untracked at 24/12/8% tiers
- spacing scale: 4px unit (`spacing-1`=4 … `spacing-4`=16 … `spacing-20`=80,
  quarter steps available)
- radius: xs 2 · sm 4 · base 6 · lg 8 · xl 12 · 2xl 14 · 3xl 16 · 4xl 18 · full
- type: `font-size-xs 11 · sm 12 · base 13 · lg 14`; UI face = system
  (`-apple-system, BlinkMacSystemFont, …` via `--vscode-font-family`); mono =
  editor's monospace; numbers use `font-variant-numeric: tabular-nums`
- subpixel antialiasing on (`-webkit-font-smoothing: subpixel-antialiased`)

## 4. Components (measured rules)
**Conversation surface** (`.composer-bar`): max-width 840px centered when docked
as a bar; text size `font-size-lg` (14px) for conversation and tool text,
`base` (13px) for trays; line-height `cursor-line-height-lg` (22px).
**Human message** (`.composer-human-message`): right-aligned bubble
(`align-self: flex-end`), background `input.background`, 1px `stroke-secondary`
border, radius `xl` (12px), min-width 150px, padding 8px × 10px (12px when
standalone), line-height 22px, gap 6px.
**Assistant markdown**: plain, `markdown-root` at 1.214em of tool size; no bubble.
**Tool-call card** (`.composer-tool-call-block-card[data-chrome=card]`):
background editor.background, 1px `card-border-color`, radius `xl`, padding
8px × 10px, gap 6px; header row 28px, 13px, tertiary text, 16px icon, actions
right (20px tall); body padding 4px 8px 4px 6px; flat density removes chrome.
**Tool line** (`.ui-tool-call-line`): 13px, gap 4px, action text secondary,
details tertiary + tabular-nums, ellipsized.
**Composer input** (bottom of pane, see frames): rounded card; row 1 context
pills (`@` button + file pills), row 2 prompt, row 3 toolbar: mode pill left
(`∞ Agent ⌘I ˄`), model dropdown (`⚙ model ˄`), right: image attach + circular
send/stop. Mode dropdown (`.composer-unified-dropdown`) bg `bg-secondary`,
mode-tinted when set. Above it while generating: `Generating..` left, `Stop ⇧⌘⌫`
right; collapsible `N To-dos`, `N in queue` (queue items: circle marker, 12px,
radius 4, hover list-hover).
**Context pill** (`.context-pill`): 20px tall, 12px text, 1px `editorWidget.border`,
radius 4, gap 4, dashed when suggestion, image pills 32×32.
**Agent sidebar cell** (`.agent-sidebar-cell`): radius 6, padding 6px 8px, gap
12; 14px icon; title 12px/16px secondary text; subtitle 11px/14px tertiary
(+diff stats `+99 −4` tabular); hover `bg-quaternary`, selected `bg-tertiary`;
unread dot 5px charts-blue 80%; trailing actions reveal on hover (60px);
content fades with a 16px right mask.
**Agent tab** (`.agent-tab`): radius 6, 12px, padding 3px 8px compact, 1px
transparent border; hover `bg-tertiary`, selected `bg-secondary`, highlighted
adds `stroke-tertiary`.
**Multi-diff mode switcher** (`.agent-layout-multi-diff-*`): header 6px 8px
with 1px panel border; mode buttons radius 4, 12px/16px, padding 2px 6px;
inactive 70% opacity description color, active toolbar-hover bg.
**Diff rendering in the agent layout**: inline (not side-by-side) with a 3px
left gutter stripe (green/red via terminal ansi colors), unchanged lines
inherit bg, line numbers tertiary, active line primary.
**Ghost text** (`.cursorGhostTextWidget`): `editorGhostText.foreground`; "cpp"
(next-edit) hint pill: editor bg, 1px progressBar-foreground border, 12px;
multi-edit button min-width 120px; small triangle pointer.
**Status bar** (frame): `Cursor Tab · Ln 1, Col 1 · Spaces: 2 · UTF-8 · LF ·
{} TypeScript · 🔔`, right-aligned, 13px.

## 5. The Agents window (Cursor 2.x, frames)
Separate window from the editor: left rail with `New Agent ⌘N`, `Automations`,
`Customize`; grouped agent lists by repo with status dot (blue = running/
unread, gray = done), item title + optional badges (`+156 −41`); user footer
with plan + settings gear; center: agent transcript (prompt card at top, tool
lines, summary), footer `Review +156 −41` / `Commit & Push ˅` and the
follow-up composer with model dropdown and mic; right: the diff/editor pane
(`Create PR`, `Commit & Push`, files-changed header `5 Files Uncommitted +98 −20`).
Light variant: sidebar `#f5f5f5`-class, cards white, hairline borders.
Login screen (dark): centered logo, title, tagline, `Log In` steel-blue button,
`Sign Up` gray, footer note.

## 6. Muster Code mapping (what we build to this spec)
- Native chat view = Cursor's agent pane: our participant streams into VS Code's
  chat; we theme via Muster Dark + CSS contributions to match §4 (bubble,
  cards, tool lines, pills, toolbar).
- Chat sessions sidebar = agent list (§4 cell spec) fed by Codex threads.
- Chat editing (multi-file accept/reject) = Cursor's Review / Keep-Undo flow.
- Inline chat (⌘I/⌘K) = Cmd+K; inline completions = Tab with the cpp hint pill.
- Board = agents window's grouped list + our worktree cards; diff pane rules §4.
Acceptance: side-by-side screenshots with Cursor on the same file, same theme
family, judged by the owner. No claim of parity without that frame.
