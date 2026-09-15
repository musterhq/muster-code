# Interaction and polish atlas

Implementation companion to `docs/TERRA-HANDOFF-2026-09-14.md` §28. Written 15 September 2026. Do not treat older Cursor gap docs as current Muster truth; they are checkpoints.

**Do not duplicate:** `docs/cursor-ux-spec.md` (measured Cursor 3.18 chrome/tokens), `docs/cursor-feature-atlas.md` (bundle inventory), `docs/cursor-gap-analysis.md` (2026-09-06 scores; several rows are stale vs current `packages/builtin/src`), `docs/cursor-parity-spec.md` (acceptance checklist), `docs/quality/2026-09-13/ide-parity.md` (workflow matrix). This file covers **transcript anatomy, streaming, composer, motion, materials, computer/browser use, and a testable effortlessness checklist.**

**Evidence classes**

| Source | What was read |
|---|---|
| T3 Code | `/tmp/t3code` (clone). Paths below are under that root unless noted. |
| Cursor | Owner screenshots of Cursor 3.x chat (Thought duration, grouped “Explored…”, command cards, mode/model pills, stop). Plus the Cursor docs listed above. |
| Codex / ChatGPT.app | `docs/quality/2026-09-13/host-capabilities.md`, handoff §8. Readable host files under `/Applications/ChatGPT.app/Contents/Resources` (no IPC probing, no quota). |
| Muster | Only `packages/builtin/src` (and cited product CSS). Claims of “Muster already has X” are from those files. |

Anything not in those sources is marked **not verified**.

---

## A. Transcript anatomy

Tokens to use in Muster (already in `agent-view.ts` `:root`, lines 10–24): `--fg`, `--bg-primary`…`--bg-quinary`, `--text-secondary`, `--text-tertiary`, `--stroke-primary`…`--stroke-tertiary`, `--amber` `#D2943E`, `--radius-sm` 4 / `--radius-base` 6 / `--radius-lg` 8 / `--radius-xl` 12, `--fs-xs` 11 / `--fs-sm` 12 / `--fs-base` 13 / `--fs-lg` 14. Map Cursor measured values from `docs/cursor-ux-spec.md` §3–4 onto these names; do not invent a second ladder.

| Element | Cursor (observed + spec) | T3 Code (source) | Codex desktop | Muster **target** |
|---|---|---|---|---|
| **User bubble** | Right-aligned; `input.background`; 1px `stroke-secondary`; radius `xl` 12px; min-width 150px; padding 8×10; 14/22 in composer bar (`cursor-ux-spec.md` §4). | User input uses chat-style hard breaks (`ChatMarkdown.tsx` `lineBreaks`, ~210). Message surface tokens `--message-surface` / `--message-foreground` (`index.css` ~986–988). Exact bubble geometry **not verified** in this pass. | **Not verified** (UI is inside packed `app.asar`; no chat CSS extracted). | Keep current `.human`: `align-self: flex-end`; `margin-left: max(24px, 12%)`; `min-width: 120px`; `border-radius: var(--radius-xl)`; `padding: 6px 10px`; `font-size: var(--fs-base)`; `line-height: 20px`; clip at `max-height: 108px` with 28px fade and “Show full message” (`agent-view.ts` 74–91, 418). Hover tools Copy/Edit 22px. Steer prefix copy: `added mid-turn`. |
| **Assistant prose** | No bubble; markdown at ~1.214em of tool size (`cursor-ux-spec.md` §4). | Incremental markdown + GFM + GitHub alerts + file/image/citation chips (`ChatMarkdown.tsx` 81–90, 198–227). Streaming: `data-streaming` opacity fade 600ms (`index.css` 1894–1907). | Streamed assistant items via app-server (`ide-parity.md`). Visual chrome **not verified**. | No bubble. `.assistant` 13px/20px. Code fences: `.code` radius `--radius-base`, header 26px, Copy + Apply/Insert (`agent-view.ts` 99–108, 370–371). File refs: dotted underline, hover `--bg-tertiary`. **Images:** `inline()` only rewrites `https?` markdown links, not `![alt](path)` (`agent-view.ts` 355–362) — **gap, P0**. GitHub alerts: not rendered (blockquotes only). |
| **Reasoning disclosure** | Screenshot: collapsible `Thought 5s ˅` (duration after the word Thought). | Thinking is a work-log tone (`presentation.ts` `tone: "thinking"` line 24). Duration label in T3 UI **not verified** in this pass. | Reasoning/effort settings exist on turns (`ide-parity.md`). Duration UI **not verified**. | Today: `<details class="thinking">` summary always `Reasoning summary`; body italic; chevron via CSS `▸`/`▾`; no elapsed seconds (`agent-view.ts` 115–119, 422, 851). **Target copy:** while running `Thought · Ns` (tabular-nums, update 1 Hz); on `done` `Thought Ns ˅` (or `Thought` if duration &lt; 1s). Do not rename to “Reasoning summary” on complete. |
| **Tool card** | Screenshot: 16px-class icon; title (e.g. `Locate slash suggestion source…`); muted one-line command (`rg, head, echo, sed`); clipped output. Spec: card radius `xl`, header 28px, 13px, 16px icon (`cursor-ux-spec.md` §4). | Human titles from `T3_MCP_TOOL_LABELS` present/past/failed verbs (`presentation.ts` 65–176). Shell titles via `commandProgramName()` (`commandLabel.ts` 1367–1369) so labels are `rg` not `bash -lc`. Activity icons/surfaces in `toolPresentation.ts`. | Tool items stream on the app-server; collab agent tools in generated schema (`host-capabilities.md`). Card chrome **not verified**. | Today: `.tool` chrome-less 22px header; 6px amber running pulse; `.cmd` ellipsis; `<pre>` hidden until `.open`, max-height 220px (`agent-view.ts` 132–140). **Target:** collapsed = icon 14px + **human title** (verb + object) + muted clipped argv + status; expanded = full output, never steal composer focus. Grouping below. |
| **Tool group** | Screenshot: `Explored 3 files, 1 search` as one collapsible summary. | `summarizeToolGroup()`: `Read N files`, `Changed N files` (unique paths), `Ran N commands`, `Used browser N times`, `Used device controls N times`, `Searched code/web`, integrations by name (`presentation.ts` 558–625). Tests: `Ran 4 commands and used browser 15 times` (`presentation.test.ts` 375). | **Not verified** whether Codex groups the same way. | **Target copy** (Cursor-shaped, T3 counts): `Explored {n} files, {m} search` when the group is only read+search; otherwise T3 sentences. Running group stays present-tense (`liveActivityToolStatus`, `presentation.ts` 179–184). Clicking the summary expands members; click does not focus composer. |
| **Approval card** | Cursor Manual / allow-list / auto-run (`ide-parity.md`). Visual of approval card in the attached screenshots: **not present**. | Approvals are distinct work-log entries; group label `Received N updates` (`presentation.ts` 584–585). Card chrome **not verified** here. | App-server `item/permissions/requestApproval` etc., scoped by threadId/turnId (`ide-parity.md`). | Already: `.card.approval` amber 45% rim; head 26px; `what` max-height 160px; actions Allow / Allow for session / Decline; Enter / Shift+Enter / Escape (`agent-view.ts` 142–148; `agent-pane.ts` 1287–1312). Decided state opacity 0.8. Keep copy **Allow**, **Allow for session**, **Decline**. |
| **Diff receipt** | Inline agent diffs; 3px green/red gutter (`cursor-ux-spec.md` §4). Agents window Review `+N −M`. | `DiffPanel.tsx`: inline/side modes, file tree, word wrap, ignore-whitespace, collapse all, copy path, open in editor (props 100–105, imports 17–57). | File-change items before approval (`ide-parity.md`). | `.editwrap` 28px row: path + tabular `adds`/`dels` + state `Editing…` / `Applied` / `Reviewed` / `Undone` (`agent-view.ts` 121–131, 505). Full-file engine is a **release gate** (handoff §2). Compact preview may truncate; complete change must remain in the editor. |
| **Image / screenshot embed** | Image pills 32×32 in composer (`cursor-ux-spec.md` §4). Chat image expand **not verified** in attached shots. | Workspace images via `classifyMarkdownImageSource` / expanded image dialog (`ChatMarkdown.tsx` 48–103). `preview_snapshot` instructs `![alt](screenshotPath)` (`preview/tools.ts` 122). | CUA screenshots are private IPC results (`host-capabilities.md`). Chat embed **not verified**. | **Target:** render `![alt](abs-or-workspace-path)` as `<img>` with radius `--radius-base`, max-width 100%, click-to-expand. Tool PNG (`browser_screenshot` without save) stays on the tool card, not the transcript. Save path: `browser-screenshot.ts` `SCREENSHOT_EMBED_HINT`. |
| **Error state** | Cursor Resume / Try again cards (`cursor-gap-analysis.md` §1 — 2026-09-06). | Failed tools: `Failed to {action}` (`presentation.ts` 143–144). Markdown copy failures toast (`ChatMarkdown.tsx` ~1994). | Turn failure items on the wire (`ide-parity.md`). | `.error` uses `--vscode-errorForeground` (`agent-view.ts` 120). `done` with `!ok` appends `m.error \|\| "Failed"` (851). **Target copy:** one line `Couldn't complete this turn` + the provider reason; retry control if the runtime exposes it (do not invent). Failed tools: red title, auto-expand output. |

---

## B. Streaming semantics

### Flicker avoidance

| Technique | T3 | Cursor | Muster today | Muster target |
|---|---|---|---|---|
| Incremental markdown parse | Cache closed fenced code + blank line as a stable prefix; parse only the suffix; clone prefix children; full reparse if definitions/footnotes/CR/BOM (`markdown-incremental.ts` 33–84, 87–106). | **Not verified** (closed source). Observed: streaming does not rebuild whole transcript chrome. | `scheduleStream` → rAF → `flushStream` replaces **entire** `innerHTML` from `dataset.raw` (`agent-polish.ts` 241–242). Open fences re-parse every frame. | Port T3 prefix rule: once a fence closes and a blank line follows, freeze that HTML node; only the last open block re-renders. |
| Incremental highlight | Resume TextMate state after last complete line; always re-highlight current line (`incrementalHighlighting.ts` 13–16). | **Not verified**. | No highlighter while streaming; fence is escaped text. | Optional: highlight only after fence close, or incremental if a highlighter is added. Do not flash unstyled → styled on every token. |
| Caret | T3: opacity fade on new blocks, no caret in CSS found. | Screenshot: small spinner at the live edge + Stop, not a block caret. | 2×1em blinking `::after` on last child, 1s steps (`agent-view.ts` 110). | Keep a 2px caret **or** a 6px amber pulse — not both. Hide caret when a tool card is the last item. |
| Follow vs read | Three modes: `following-end` / `anchoring-new-turn` / `free-scrolling` (`timelineScrollAnchoring.ts` 4). Wheel **up** only breaks follow if content actually overflows; wheel down never breaks; streaming `isAtEnd` flicker must not break follow (`ChatView.tsx` 5221–5253). | **Not verified** in source; expected: reading position sticks. | `following` true when within 60px of bottom; Jump control (`agent-polish.ts` 211–212). Send forces follow (`agent-view.ts` 714). | Keep 60px band. Never call `scroll()` when `following===false`. Restore `scrollTop` on tab switch (`agent-polish.ts` 237–238). |
| Tool summarization | Present tense while `inProgress`; drop superseded `tool.started` once `tool.completed` exists (`presentation.ts` 179–184, 628–663). | Screenshot: grouped summary while/after exploration. | Each tool is a row; running class + pulse; no group summary. | Collapse consecutive completed tools of the same `ToolGroupAction` into one summary; keep the latest running tool expanded as a single live row. |
| Thinking duration | **Not verified** in T3 UI. | `Thought 5s` with disclosure. | No timer; label never becomes duration (`agent-view.ts` 422, 851). | Start timer on first reasoning delta; show `Ns` / `Nm Ns`; freeze on `done`. |

T3 extra: streaming markdown uses `@starting-style { opacity: 0 }` **only** under `[data-streaming]` and `prefers-reduced-motion: no-preference` (`index.css` 1894–1907). Do not replay fades when opening a finished thread.

---

## C. Composer and command surfaces

### Slash commands and @-mentions

**Muster today** (`agent-view.ts` 698–751, `context.ts` 246–260, `agent-pane.ts` 1254–1262)

- Triggers: `(^|\s)([@/])` then `[\w./:?=&%#+-]*`.
- Slash builtins (action, **not** inserted): Reset, Summarize, Agent Review, Open Browser.
- Custom `.md` commands and skills: **insert** `/{name}`.
- @ modes: Files & Folders, Past Chats, Docs, Terminals, Commits; empty state recent files; `→` enters mode; Backspace with empty query leaves mode; typed range after `@`/`/` is cleared on mode change (Cursor-matched comment at 732).
- Keys: ↑↓, Enter/Tab act, Escape closes, Shift+Tab opens mode menu.
- Visible row: icon + highlighted label + `detail` description.

**T3** (`composerSlashCommandSearch.ts` 15–28, `ChatComposer.tsx` 2293–2355, 3921–3946)

- Provider slash commands offered **only at prompt start**; otherwise they would be literal text. Built-ins and skills remain available mid-prompt (skills insert a `$` mention).
- Filter: trim leading `/`, rank name then description (`composerSlashCommandSearch.ts` 76–80).
- Enter/Tab on an open menu selects the item and **does not submit** (`onComposerCommandKey`).
- Built-in examples: `/model` “Switch response model for this thread”, `/plan` when plan UI enabled (`ChatComposer.tsx` 2294–2308).
- Mentions are Lexical chips (`composer-editor-mentions.ts`); ArrowUp/Down at visual line edges go to prompt history, not the menu (`ComposerPromptEditor.tsx` 849–853, 885–888).

**Cursor (spec + screenshot):** `@` button + pills; mode pill `∞ Agent ˅`; model pill. Slash/mention filtering details: `cursor-feature-atlas.md` / `cursor-ux-spec.md`; do not re-mine the bundle here.

**Codex:** context via input items / file / skill (`ide-parity.md`). Composer slash UI **not verified**.

**Muster target**

1. Enter/Tab in an open slash/@ menu **always** runs `chooseSuggestion`; never `send()`.
2. Built-in slash = action; project/user commands and skills = insert `/{name}` then space (already).
3. Show **label + one-line description** (`detail`) on every row (already).
4. Do not insert `/` into the textarea when the menu is open and Enter is pressed on an action item (already strips trigger range, line 737).
5. @ inserts `@token` plus trailing space (already `acceptSuggestion`).

### Mode / model pills

Cursor screenshot: left `∞ Agent ˅`, right model name, circular Stop while streaming. Muster: mode pill + model in composer (`agent-view.ts` `mode-pill` at 730). Visual of ∞ / Agent **not verified** as matching Cursor; keep Muster mode list from provider settings. Stop: 24px circular `.stopbtn`, `⇧⌘⌫` (`agent-view.ts` 87, 768).

### Queue / steer

Muster: `#queue` dashed chips; steer messages `.human.steer` (`agent-view.ts` 83–86). Cursor: `N in queue` (`cursor-ux-spec.md` §4). Target: queue rows 12px, radius 4, dismiss `×` without focusing issues.

### Draft persistence

| App | Behavior |
|---|---|
| T3 | Zustand persist key `t3code:composer-drafts:v1`, debounce **300ms**, `beforeunload` flush (`composerDraftStore.ts` 84–131). Prompt stash `t3code:prompt-stash:v2`, max 20, ~2.7M chars attachment budget (`promptStashStore.ts` 11–31). Files needing reattach after reload: `composerFileNeedsReattach` (161–163). |
| Muster | Draft posted on 180ms timer; per-tab `viewStates` including composer text, context, scroll, following (`agent-polish.ts` 222–229). |
| Cursor | Drafts persist (gap analysis 2026-09-06 claimed Muster lost drafts; **stale** vs polish persist). |
| Codex | **Not verified** for composer localStorage. |

Target: keep 180ms persist; flush on `visibilitychange`/`beforeunload` like T3; never clear the box on tab switch.

### Attachments

| Kind | T3 | Muster today | Target |
|---|---|---|---|
| Files / folders | Path search trigger; chips; upload ids (`composerDraftStore.ts`, `ChatComposer.tsx` path items). | `@file`, `@folder:` via `suggestMentions`. | Keep; dashed current-file suggestion pill (`agent-view.ts` 685–687). |
| Images | Data URLs in draft; stash size budget. | `@image:` and attach control (parity docs). | 32×32 pills (`cursor-ux-spec.md`). |
| Browser selection | `preview-annotation` context records; picker overlay (`PickPreload.ts`). | `rememberPick` / `saveBrowserPick`; visual edits list (`browser.ts` 21–23, 304). | Attach pick as `@browser` chip with selector + screenshot path. |
| Desktop snapshot | Global shortcut → PNG + accessibility tree attached to prompt (`snapShot.ts` 7–16; `DesktopSnapShot.ts` header; `SnapShotAccessibility.ts` 27–80; 3s timeout). | **Missing.** | P2: do not call Codex CUA; optional Muster capture later. |

---

## D. Motion tokens

### Extracted from T3 (`apps/web/src`)

No `spring()` / physics springs in `apps/web/src` (grep hits were DST “spring-forward” or unrelated). Easing is **ease-out** / **ease-in-out** / **cubic-bezier**.

| Token (name for Muster) | T3 value | Citation |
|---|---|---|
| `--motion-fast` | 100ms | Breakpoint fade `Math.min(100, durationMs)` ease-out (`panelAnimations.ts` 58–60). Scrollbar 120ms (`terminal/ghostty/surface.ts` 703). |
| `--motion-ui` | 150ms ease-out | Sidebar FLIP `motionTiming = { duration: 150, easing: "ease-out" }` (`Sidebar.motion.ts` 1). Preview bar 150ms + 220ms opacity delay (`index.css` 2087–2089). |
| `--motion-panel` | `panelAnimationDurationMs` 0–400, default **0** | `packages/contracts/src/settings.ts` 107–115. CSS `var(--panel-animation-duration)` ease-out (`ui/sidebar.tsx`). |
| `--motion-height` | 200ms ease-out; fallback unclip 250ms | `AnimatedHeight.tsx` 5, 82–83 (`duration-200 ease-out motion-reduce:transition-none`). |
| `--motion-overlay` | 180ms (mobile composer VT); 130ms headline | `index.css` 16, 60. |
| `--motion-stream-in` | 600ms ease-out opacity | `index.css` 1902 — **too slow for Muster streaming**; do not copy. |
| `--motion-copy-ack` | 1200ms | Copy label reset (`ChatMarkdown.tsx` 943); stash pulse (`ChatComposer.tsx` 3994). |
| `--motion-toast` | 250ms | Toast expand (`ui/toast.tsx` 681). |
| Scale popovers | `scale-98` start/end | tooltip/popover/preview-card. |
| Reduced motion | `durationMs > 0 && !prefersReducedMotion && !suppressed` | `panelAnimations.ts` 75–78. First paint of a route: **no** panel animation (`usePanelNavigationSuppression`, 11–13). Sidebar skips FLIP if `prefers-reduced-motion: reduce` or &gt;40 faded rows (`Sidebar.motion.ts` 7, 22–24, 142–146). Theme swap: `transition-duration: 0s` (`index.css` 961–967). |
| Drag | dnd-kit + `Sidebar.drag.ts`: reject invalid drop targets; do not auto-jump section without pointer crossing the divider (28–55). | |

### Cursor-observed

~120–180ms ease-out on chrome (owner instruction; not re-measured from the bundle in this pass). Spec spacing/radius in `cursor-ux-spec.md` §3.

### Apple HIG (guidance, not a code citation)

Motion explains a change; it must not delay the action. Prefer short ease-out on enter, slightly longer on large panels. **Reduce Motion** → instantaneous layout, no decorative fade/scale. Liquid Glass / materials: controls and navigation, not the document (`docs/quality/2026-09-14/liquid-glass-decision.md`; handoff §27).

### Muster single table (implement these CSS variables on `:root` in `agent-view.ts` / `muster-workbench.css`)

| Variable | Value | Use |
|---|---|---|
| `--motion-instant` | 0ms | Reduced motion, theme swap, first paint |
| `--motion-fast` | 120ms | Hover bg, selection, running-dot, menu highlight |
| `--motion-ui` | 160ms ease-out | Popover/menu/palette open, height of slash menu, Jump button |
| `--motion-panel` | 180ms ease-out | Sidebars, sheets (cap 200ms) |
| `--motion-ack` | 1000ms | “Copied” |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` or CSS `ease-out` | Default |
| **Forbidden** | springs; blur animation; 600ms stream fade; animating `backdrop-filter` | Handoff §27 |

`@media (prefers-reduced-motion: reduce)`: all durations 0; Jump/scroll still work.

---

## E. Color / material

### T3 surface ladder (`index.css` ~80–190, 970+)

`--background`, `--app-chrome-background`, `--toolbar-*`, `--surface-raised` (`color-mix(in srgb, var(--card) 20%, transparent)`), `--card`, `--popover`, `--muted`, `--accent`, `--input`, `--border`, `--ring`. Semantic: `--success`, `--error`, `--warning`, `--info`, `--update`, `--diff-addition`, `--diff-deletion`, `--tool-error-icon`. Glass: `--glass-blur` 12px light / 16px dark, `--glass-opacity` 80%, `--glass-saturation` 1.14/1.08 (103–120). `--radius` 0.625rem (10px). `--control-radius` 0.5rem. Popovers use `.dropdown-glass` + 1px inner highlight `before:shadow-[0_1px_black/4%]` (dark: white/6% from top).

### Cursor

Neutral fg-alpha ladder — **use `cursor-ux-spec.md` §2–3**. Do not copy Cursor steel-blue as Muster accent (Graphite/violet default; forest restoration override at top of the handoff).

### Codex UI tokens

Chat UI lives in `app.asar` (not greppable as CSS in this pass). Readable CSS: `default_app/styles.css` `transition: all 0.2s` only — **not** the product chrome. **Not verified:** Codex transcript colors.

### Muster target (webview)

Reuse `agent-view.ts` `:root` mixes. Content (transcript, diffs, code) = **opaque** `--vscode-editor-background` / `input.background`. Glass = palette, menus, composer chrome, nav only. Rim: 1px `--stroke-secondary`, not a thick border. Shadows: 0 / `0 1px` rim / `0 8px 24px` for floating palette only.

**Liquid Glass boundary:** handoff §27 + `liquid-glass-decision.md`. Glass = Go To, segmented task controls, menus/popovers, composer container. Not = message list, monaco, full-file diff, nine-up task cards’ transcript bodies.

---

## F. Computer use / browser use

### Boundary (mandatory)

Codex native CUA is a **private IPC** surface (`MacNativePipeTransport`, Unix socket under Group Containers, `nodeRepl.rpc("sky", …)`). Do not call it from Muster. Names found in readable bundles (no code copied): Mac client methods `listApps`, `startApp`, `getAppState`, `click`, `drag`, `paste`, `performSecondaryAction`, `pressKey`, `scroll`, `setValue`, `selectText`, `typeText`; IPC request type strings `ComputerUseIPCListAppsRequest`, `ComputerUseIPCAppPerformActionRequest`, `ComputerUseIPCAppGetSkyshotRequest`; Sky docs `get_screenshot`, `click`, `get_window_state`. Audio record helpers exist; they are not GPT-Live voice (`host-capabilities.md`).

**Muster’s supported path:** its own MCP browser tools + in-IDE browser (`browser-mcp.ts` bridged over a Unix socket to the extension — `browser-mcp.ts` 1–4). Optional later: host Computer Use **plugin/MCP** if the signed-in Codex host exposes it — detect availability, do not spoof.

### T3 preview toolkit (`apps/server/src/mcp/toolkits/preview/tools.ts` 53–259)

`preview_status`, `preview_open`, `preview_navigate`, `preview_resize` (fill / freeform / preset e.g. `iphone-12-pro`), `preview_set_appearance` (`dark`/`light`/`system`), `preview_snapshot` (PNG in tool result **not** user-visible; `save=true` → `screenshotPath` → embed `![alt](screenshotPath)` — **only** user-visible screenshot path, lines 122), `preview_click`, `preview_type`, `preview_press`, `preview_scroll`, `preview_evaluate`, `preview_wait_for` (locator **and** selector **and** text **and** URL), `preview_recording_start`, `preview_recording_stop` (≤50 MiB evidence file).

Destructive vs readonly annotations: `Tool.OpenWorld` / `Destructive` / `Readonly` (41–51).

### T3 device toolkit (`device/tools.ts` 21–74)

Deliberately small: `device_list`, `device_open`, `device_screenshot`, `device_close`. Drive the device via `agent-device` CLI, not extra MCP verbs.

### T3 desktop snap + picker

- Capture + AX tree on the prompt (`SnapShotAccessibility.ts`; max nodes/chars in contracts via `snapShot.ts` 7–9).
- Element picker / annotation overlay in the preview guest: `PickPreload.ts` tools select/marquee/draw/erase; overlay `z-index` 2147483646; theme vars `--t3-primary` etc. (28–80).
- Host: `preview/Manager.ts` — WebContents per tab, annotation IPC channels, Playwright injected runtime (header 1–80).

### Muster MCP tools (current `browser-mcp.ts` 19–40)

There are **20** tools (not 16; count the `TOOLS` array):

`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_select_option`, `browser_screenshot` (`save`, `fullPage`), `browser_console_messages`, `browser_diagnostics`, `browser_status`, `browser_evaluate`, `browser_wait_for` (`text`, `selector`, `url`, `timeMs`, `timeoutMs`), `browser_go_back`, `browser_go_forward`, `browser_reload`, `browser_scroll`, `browser_resize` (presets `iphone-12-pro`…`desktop-1440`), `browser_set_appearance`, `browser_tabs`.

Implemented in `browser-tools.ts` (screenshot save → `screenshotPath` + embed hint at 170–182; scroll/resize/appearance 184+). `browser.ts` still reports `recording: "unsupported"` (105). Picker exists in the pane (`browser.ts` 304, `LOCK_JS` overlay z-index 2147483647).

### Gaps vs T3 (implement or explicitly defer)

| Gap | T3 | Muster | Priority |
|---|---|---|---|
| Visualize loop | save → `![alt](path)` in **assistant markdown** | Hint is sent to the model (`browser-screenshot.ts` 26–27); **renderer does not show local images** | P0 |
| `preview_wait_for` locators | locator + selector + text + URL all must match | text/selector/url/time; **no Playwright locator** | P1 |
| Recording | start/stop → file | `recording: "unsupported"` | P2 |
| Annotation overlay in page | `PickPreload.ts` draw/marquee | Pick element + visual edits; no draw/marquee overlay | P1 |
| Desktop snapshot + AX | `apps/desktop/src/snapShot/` | None | P2 |
| Device toolkit | `device_*` | None | P2 |
| Playwright locators vs `[ref=eN]` | locators preferred | ref/selector only | P1 (keep refs; optional locator later) |

### Visualize loop (implement exactly)

1. Model calls `browser_screenshot` with `save: true` (or T3 `preview_snapshot` `save: true`).
2. Tool result includes `screenshotPath: /abs/….png` and the embed hint.
3. Model writes `![Page after login](/abs/….png)` in the assistant message.
4. Chat renderer resolves workspace/absolute path → `<img src="vscode-webview-resource…">`.
5. Tool-result PNG without save stays on the tool card only (T3: “the image in the tool result is not saved anywhere”, `preview/tools.ts` 122).

---

## G. Effortlessness checklist (testable)

Keyboard / layers

1. Escape closes the **innermost** surface only (slash menu → then approval → then palette → then nothing).
2. Escape on an empty composer with a pending approval **Declines** (`agent-view.ts` 753–756) — keep; do not also close the pane.
3. Enter in the slash/@ menu **acts**, does not insert a newline or send.
4. Shift+Enter always newline in the composer.
5. ⌘Enter may send even with a menu **closed** only; if menu open, ⌘Enter still selects (document and test).
6. ↑↓ in the menu move the highlight and `scrollIntoView({ block: "nearest" })`.
7. → opens a mention **mode** when the row has `nav`; ←/Backspace on empty query returns to `all`.
8. Tab accepts the highlighted suggestion; Shift+Tab opens the mode pill menu (already).
9. `⇧⌘⌫` stops the run without clearing the draft.
10. Focus: after any menu close, caret returns to the composer.

Composer / context

11. Draft text + `@` chips survive tab switch and reload (`agent-polish.ts` persist).
12. Clicking a context chip `×` removes it and **keeps** composer focus (already line 681).
13. Clicking a tool card expands it and **never** focuses the composer.
14. Clicking a file link opens the editor with `preserveFocus` false only for explicit open; tool expand stays in the webview.
15. Current-file dashed pill adds `@path` at the caret, not the end, unless caret is at end.
16. Sending with extra retained context appends those tokens after a blank line (already 714).
17. Empty send is a no-op except debug-mode placeholder (already).
18. Attach image/file does not reset scroll `following`.

Streaming / scroll

19. Streaming **never** scrolls a reader who scrolled up (`following===false`).
20. Returning to the tail (Jump or scroll within 60px) resumes follow.
21. Switching tasks restores that task’s `scrollTop` and `following` (`agent-polish.ts` 237–238).
22. Open code fences do not resize earlier blocks (prefix freeze).
23. Copy on a code block does not steal selection from the composer; button shows `Copied` ≤1s.
24. Caret/spinner visible only on the live assistant message.

Transcript chrome

25. User bubbles clip long text; Expand does not jump the viewport if `following===false`.
26. Thinking disclosure default **collapsed** after complete; expanded state persisted in `viewStates.expanded`.
27. Tool groups use human copy, not raw MCP names (`mcp__t3-code__preview_click` → `Clicked in the preview browser`).
28. Running tool: present tense + pulse; completed: past tense; failed: red + open.
29. Approval Allow/Decline does not send composer text.
30. Diff receipt `+N −M` uses `font-variant-numeric: tabular-nums` (already `.adds`/`.dels`).
31. Errors are a distinct `.error` row, not a fake assistant message.

Motion / a11y

32. `prefers-reduced-motion: reduce` → no caret blink, no pulse, no height animation.
33. `prefers-reduced-transparency` / solid setting → no `backdrop-filter` (handoff §27).
34. Palette/menu selected row contrast ≥ adjacent hover; focus ring `--stroke-primary`.
35. Screen reader: tool header `role="button"` + `aria-expanded` (already 427).
36. Slash menu `No results` when empty (already 718).

Browser / visualize

37. Agent screenshot with `save:true` can appear as an inline image after the model embeds it.
38. Browser “Take control” overlay does not steal IDE keybindings except clicks on the page (`LOCK_JS` pointer-events).
39. `browser_tabs` lists the tab the user is looking at as default for other tools.
40. Stop during a browser tool marks the tool `stopped`, not hung running.

Notifications (T3 `threadNotifications.ts`: badge `#e5484d`, completion/input sounds, modes off / notifications / sound / both). Muster: **not verified** as matching; do not block P0 on chimes.

---

## H. Prioritized backlog

| ID | Item | Files | Test type |
|---|---|---|---|
| **P0-1** | Incremental markdown: freeze closed fences; rAF paint only the tail | `agent-view.ts` `renderMarkdown`; `agent-polish.ts` `flushStream` | Fixture: stream a 200-line fence then prose; no full-innerHTML flicker (mutation observer / HTML snapshot of prefix). |
| **P0-2** | Render `![alt](path)` workspace/absolute images | `agent-view.ts` `inline`/`renderMarkdown`; CSP `img-src` already allows `${csp}` | Fixture HTML + native: save screenshot, inject markdown, image visible. |
| **P0-3** | Thought duration label | `agent-view.ts` `ensureThinking` / `done` | Unit on elapsed formatter; GUI: reasoning deltas then `Thought 3s`. |
| **P0-4** | Tool group summaries (Cursor “Explored…”) | `agent-view.ts` tool DOM; optionally extract helpers from T3 `presentation.ts` (reimplement, do not import T3) | Unit: counts/copy; GUI: 3 reads + 1 search collapse. |
| **P0-5** | Human tool titles (verb + argv via program name) | `agent-view.ts` tool head; new small `command-label.ts` inspired by `commandLabel.ts` | Unit: `bash -lc 'rg foo'` → title contains `rg`. |
| **P0-6** | Follow-scroll regression: never move when user scrolled up | `agent-polish.ts` scroll listener; `agent-view.ts` `scroll()` | GUI: scroll up mid-stream, assert `scrollTop` stable for 1s of deltas. |
| **P1-1** | Motion CSS variables + reduced-motion | `agent-view.ts` styles; `product/muster-workbench.css` | CSS fixture + `prefers-reduced-motion` emulation. |
| **P1-2** | Slash/Enter never sends | `agent-view.ts` keydown 742–758 | Keyboard fixture: `/` + Enter on Reset → new chat, empty composer. |
| **P1-3** | Innermost Escape | `agent-view.ts` 615, 751, 756 | Stacked menu + approval. |
| **P1-4** | Tool click does not focus composer | `agent-view.ts` tool handlers | GUI: `document.activeElement` stays / returns. |
| **P1-5** | GitHub alerts + table copy | `agent-view.ts` markdown | Fixture markdown `> [!NOTE]`. |
| **P1-6** | `browser_wait_for` locator parity (optional Playwright) | `browser-mcp.ts`, `browser-tools.ts`, `browser.ts` | Contract test: url + text + selector. |
| **P1-7** | Annotation overlay (select + screenshot region) | `browser.ts` pick; product browser preload | Native: pick → chip + image path. |
| **P1-8** | Go To palette material (Spotlight) | `navigation.ts`; workbench CSS; §27 | Keyboard + screenshot vs solid fallback. |
| **P1-9** | Queue/steer visual match to Cursor 12px rows | `agent-view.ts` `#queue` | Screenshot + chip wrap. |
| **P1-10** | Draft flush on hide | `agent-polish.ts` | Reload mid-debounce. |
| **P2-1** | Recording start/stop | `browser.ts` (`recording: "unsupported"`), MCP | Defer until capture exists. |
| **P2-2** | Desktop snapshot + AX attach | new module; **not** Codex CUA socket | Capability + permission UI. |
| **P2-3** | Device toolkit | new; T3 `device/tools.ts` as shape only | Optional. |
| **P2-4** | Native Liquid Glass host | shell; §27 | Host evidence, not webview blur. |
| **P2-5** | Thread complete sound/badge | T3 `threadNotifications.ts` as reference | Setting + off by default. |

`docs/cursor-parity-spec.md` still marks copy-code / file links / tables as ⬜ in places; **current source already has Copy, file links, tables** (`agent-view.ts` 99–113, 352–378). Update that spec when implementing, do not re-build those features.

---

## Appendix: T3 command palette (Go To reference)

One overlay, three modes that never stack: command `⌘K`, files `⌘P`, content `⇧⌘F`; re-trigger toggles close (`CommandPalette.logic.ts` 55–60, 89–101). `>` filters to actions (369–384). Recent threads limited to 12 (`RECENT_THREAD_LIMIT` 19). Items have title + description + icon + optional shortcut. Muster `navigation.ts` uses `showQuickPick` placeholder `Muster: Go To` (line 38) — replace with the Spotlight material in §27, not VS Code default styling.

## Appendix: not verified

- Codex ChatGPT transcript layout, motion, slash menu, and glass CSS (`app.asar` not unpacked).
- Cursor closed-source streaming parser and exact ms of chrome motion (used owner ~120–180ms).
- T3 thinking-duration label in the live UI.
- Muster notification sound/badge behavior.
- Whether `browser_screenshot` images already display **inside tool cards** as `<img>` in the webview (tool result `image` field exists in MCP bridge; DOM binding **not verified** in `agent-view.ts` grep for `<img>`).
- Apple HIG page text was not fetched live; treat as standard Reduce Motion / materials guidance plus §27.
