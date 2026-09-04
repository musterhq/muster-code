# Cursor parity — the acceptance spec (owner, 2026-09-03)

Every line is an acceptance criterion. Status: ✅ done (verified live) · 🔧 in progress · ⬜ next · V2 = second wave.
Visual fidelity for each item is judged against `docs/cursor-ux-spec.md` and the owner's Cursor screenshots.

## Main IDE shell — mandatory
- ✅ Activity/sidebar icons (horizontal, Cursor placement) · ✅ File explorer · ✅ Tabs · ✅ Monaco editor · ✅ Breadcrumbs
- ✅ Problems/output/terminal bottom panel · ✅ AI sidebar on the right (Agent pane) · ✅ Git/status bar (Muster Tab · Agent Stats cluster) · ✅ Resizable panes
- 🔧 Empty-editor shortcut list in Cursor's wording (New Agent ⇧⌘L, Show Terminal ⌘J, Search Files ⌘P, Open Browser ⇧⌘B, Maximize Chat ⌥⌘E, Add Repository ⌥⌘A)

## Agent chat — empty/new conversation
- ✅ Prompt textarea (composer card at top when empty) · ✅ Agent mode pill · ✅ Model selector label · ✅ Attach image/file · ✅ Send/stop · ✅ New chat (+, ⇧⌘L) · ✅ Conversation history (Codex threads by the app's names)
- ⬜ @ Add context (picker) · ⬜ Ask / custom modes in the pill dropdown · ⬜ mode/model dropdown menus (visual)

## Agent chat — rich Markdown response
- 🔧 H1/H2/H3, paragraphs, bold/italic, lists, inline code, fenced code (basic renderer in) · ⬜ file-path links · ⬜ Markdown tables · ⬜ citations/context chips · ⬜ copy code · ⬜ tool-call cards (edit cards ✅) · ⬜ streaming text cursor · V2 Mermaid

## Context picker
- ⬜ @file · ⬜ @folder · ⬜ @code · ⬜ symbols · ⬜ recent files · ⬜ search results · ⬜ terminal context · ⬜ git diff · ⬜ documentation · ⬜ selected editor range

## Model + agent mode picker
- 🔧 selected model (label) · ⬜ model dropdown · ⬜ Agent/Ask/Manual modes · ⬜ context-window indicator · ⬜ reasoning/effort options (Codex Effort)

## Cmd-K inline prompt — critical
- ⬜ floating input beside selection · ⬜ instruction → generating state · ⬜ cancellation · ⬜ context button

## Realtime streaming inline diff — most important
- 🔧 original visible, removed red, additions green, tokens arriving while generating (inline diff editor + streamed buffer from `item/fileChange/outputDelta`) — awaiting live verification
- ⬜ modified gutter indicators · ⬜ follow-scroll without stealing control · ⬜ per-hunk Accept/Reject (file-level Keep ⌘⏎ / Undo ⌘⌫ ✅) · ⬜ clean editor state after acceptance (✅ basic)

## Multi-file agent diff review
- ⬜ changed-files tree · ⬜ +/- counts (per-file cards ✅) · ⬜ file navigation · ⬜ unified/split toggle · ⬜ hunk accept/reject · ⬜ Accept All (✅ command) / Reject All · ⬜ jump to next modification · ⬜ reopen in editor

## Agent editing while chat remains visible
- ✅ explanation on the right, editor changing simultaneously · 🔧 active file highlighted · ✅ edited files accumulate in the panel · 🔧 Review / Undo / Keep

## Terminal tool execution
- ⬜ command as tool call · ⬜ approval state (core now routes approvals — UI next) · ⬜ live stdout/stderr · ⬜ success/failure · ⬜ stop · ⬜ background continuation · ⬜ agent reads result

## Cursor-Tab / inline completion
- ⬜ ghost text · ⬜ multi-line · ⬜ Tab accept / Esc reject · ⬜ partial accept · ⬜ next-edit prediction

## Checkpoint / undo / history
- ⬜ automatic checkpoint before agent changes (turn-start baseline ✅ internally) · ✅ conversation history · ⬜ file change history · ⬜ restore checkpoint · ⬜ chat-undo vs source-control rollback distinction

## Agent configuration / custom modes
- ⬜ model, Search, Edit, Run, auto-apply, auto-run, auto-fix, instructions, permissions, shortcut

## Rules / project instructions
- ⬜ project rules · ⬜ user rules · ⬜ Markdown rule editor · ⬜ enabled state · ⬜ rule path · ⬜ auto/manual

## MCP / external tools
- ⬜ servers (inherited from Codex ✅ in muster) · ⬜ enable/disable · ⬜ tools · ⬜ health · ⬜ auth · ⬜ logs

## V2
- Agents window / multi-agent (board: worktrees, status, parallel, handoff) · Browser / visual editor (T3-style hosted browser + preview tools) · Git / source control review

## Mined from Cursor 3.18.25 (the installed app's own bundle, not screenshots)

Sources: `docs/reference/cursor-inline-diff.css`, `docs/reference/cursor-widgets.css`, `docs/reference/cursor-tokens.txt` (extracted from `Cursor.app/…/workbench.desktop.main.{css,js}`).

### Inline diff (agent edits in the file's own editor)
- Not a diff editor. Added lines: whole-line background `diffEditor.insertedLineBackground` (Cursor Dark `#3FA26633`; fallback `rgba(12,233,27,.2)`), overview-ruler marks in `editorOverviewRuler.addedForeground`.
- Removed lines: view zones (`.inline-diff-removed`, no line numbers), syntax-tokenized, `opacity:.9`, `padding-left:.5px`, background `diffEditor.removedLineBackground` (Cursor Dark `#B8004933`).
- Word-level highlights inside changed lines: added `rgba(12,233,27,.15)` with 1px borders, removed `rgba(242,13,59,.25)`.
- First changed line fades at the right edge (`inline-diff-first-line:after`, 10px gradient to the editor background).
- Per-hunk widget (`acceptRejectPartialEditWidget`): an editor overlay on the line after the hunk (`min(end+1, lineCount)`), right-aligned; moves to the editor end when the line's text would collide (`textEnd + 32 > width − scrollbar − 200`). Contents: `inline-diff-nav` counter "n of m" (12px, tabular, min-width 36px, padding 2px 6px, radius 4, bg = 67% of `--cursor-bg-secondary`), a secondary Reject button (bg `--cursor-stroke-secondary`, input foreground), a primary Accept button (bg `charts.green` at 85% over the editor background, button foreground); both 22px tall, 12px, radius 4, with a `.keyboard-shortcut` span at opacity .7.
- File-level bar (`pure-ai-prompt-bar`, max width 720px, gap 40px): "n / m" navigation (the slash at opacity .6), then `diff-review-trailing-actions › diff-review-primary-actions`: "Undo" / "Undo All" (text) and "Keep" / "Keep All" (primary, with the keybinding hint). Multi-file: "Keep all changes" (text, `button.secondaryForeground`) + a primary "next file" button with a chevron.
- Streaming: lines land as tokens arrive; the pending hunk has no widget until it settles; the view follows the active modification.

### Design tokens (all relative to `editor.foreground`)
- bg: primary 20%, secondary 14%, tertiary 8%, quaternary 6%, quinary 4%; colored `*-secondary` = 24% of the hue.
- stroke: primary 20%, secondary 12%, tertiary 8%, quaternary 4%; colored strokes 56% / 42%.
- text: quaternary 36%; icon secondary 66%; colored text secondary 78%, tertiary 64%, quaternary 40%.
- git colors: `--cursor-added` / `--cursor-modified` / `--cursor-removed` / `--cursor-untracked` with primary/secondary(24%)/tertiary(12%)/quaternary(8%) tiers.
- Cursor Dark: editor `#181818`, chrome `#141414`, fg `#F0F0F0`, `charts.green #3FA266`, `charts.red #E34671`, `button.background #81A1C1`, `button.foreground #191c22`, `input.background #F0F0F00A`, gutter added/deleted/modified `#3FA266 / #E34671 / #D2943E`.

### Composer placeholders (by mode)
- New composer: "Plan, Build, / for skills, @ for context". Agent: "Plan, search, build anything". Chat: "Ask, learn, brainstorm". Edit: "Work on explicitly added files (no tools)". Follow-up: "Add a follow-up". Pending question: "Reject, suggest, follow up?". Plan steering: "Steer the plan, or add more details".

### Plan mode (screenshot 37 + bundle)
- `.plan.md` opens as a rendered plan editor with a toolbar: breadcrumb with the plan icon · "Preview ⌄" · model "Sonnet 4.5 ⌄" · amber "Build ⌘⏎ ⌄".
- Chat shows a plan card: file header (plan icon, filename, export + expand icons), rendered title + summary, a nested "N To-dos" box with radio circles and "··· k more", footer "View Plan" (text button) · model picker · amber "Build ⌘⏎ ⌄".
- Human bubbles clip long text with a bottom fade; each carries a "Restore Checkpoint" icon button (`anysphere-icon-button`, 26px tall, `--cursor-text-primary`), replaced by "Stop ⇧⌘⌫" while running.
- Mode pill in plan mode is amber-tinted with the plan icon; right cluster: spinner · @ · globe · image · mic.


## Status update 2026-09-03 (afternoon)
- Realtime inline diff: DONE and verified live (Cursor architecture: workbench contribution + extension bridge). Original visible, red ghost rows (tokenized, no line numbers), green added lines streaming token by token, ruler marks, follow-scroll, per-hunk "n of m · Reject ⌘N · Accept ⌘Y" widgets (compact when text collides), bottom "Undo All / Keep All" bar, per-hunk/file/all accept-reject, clean disk convergence. Remaining polish listed in docs/HANDOFF.md §7a.
- Agent pane: composer + review bar exist; the Cursor chat rebuild (tabs, history, non-hardcoded models/modes incl. Kanban + access modes, inherited full history, diff preview cards, plan cards, approvals) is specified in docs/HANDOFF.md §7b — next.

## Status update 2026-09-03 (evening)
- Agent pane rebuilt (commit 154270f): thread tabs with + / close, in-pane History (search, pin), Kanban board view (backlog → in progress → review → done; Run starts a thread), mode pill Agent / Plan / Ask / Kanban + custom modes (`muster.modes`, ⌘. cycles), access pill from `permissionProfile/list` (Read only / Manual approval / Full access), model pill from `model/list` with per-model efforts + Claude models (`muster.claude.models`) through Claude Code; all per thread and persisted. Plan mode runs Codex's plan collaboration mode, renders the plan card (To-dos, View Plan, Build ⌘⏎), saves `.muster/plans/<slug>.plan.md` and opens the markdown preview; Build switches to Agent and implements the plan. Approvals/questions are answered in-app. Markdown renderer, tool cards, clickable edit cards.
- Not yet verified with a live Codex turn (owner's quota); verified: build, tests (core 25/25 file, builtin 8/8), activation, discovery queries (model/list, permissionProfile/list) live.
- Next: verify plan mode end to end with a real turn; Cursor-exact plan editor toolbar (Preview ⌄ · model · Build) for `.plan.md`; diff preview block inside chat edit cards; @ context picker; Cmd-K; Tab.

## Status update 2026-09-03 (late)
- Privacy: threads are scoped to the open folder(s) everywhere (history, open-by-id, board, native session list) via `threadsForWorkspace`; other folders' chats are not listed or openable.
- ⌘K inline edit (input box → agent edits the selection/file → streams in as the inline diff; the in-editor floating prompt bar is still to be built on the workbench side).
- `.plan.md` editor toolbar: Preview · Build (⌘⏎) via editor/title menus; Build implements the plan in the active thread.
- Checkpoints: every human message records the turn-start contents of every file the agent touches; ↺ Restore Checkpoint on the bubble restores them and truncates the conversation view.
- Rules: `.muster/rules/*.md` and `.cursor/rules/*.mdc` are sent as developer instructions on every turn.
- MCP elicitations (computer use) and approval/user-input requests are answered in-app.
- Composer: `@` file picker (workspace search, contents attached as context) and `/` skills picker (`skills/list`).
- Still to build: Tab completions, in-editor ⌘K bar, terminal ⌘K, multi-file review editor, agents window, browser, git review, diff preview block inside chat cards.

## Status update 2026-09-03 (night)
- Modes now mirror Cursor 3.18's list with descriptions (Agent, Triage, Plan, Spec, Debug, Multitask, Ask, Project + custom); ⌘. / ⇧Tab open the mode menu; plan/spec → Codex plan mode; ask/project → read-only; triage → delegating effort; multitask → board.
- Efforts are per provider: Codex from model/list per model; Claude from the CLI (low/medium/high/xhigh/max) with descriptions.
- ⌘K prompt bar in the editor (view zone: Edit Selection ⏎ · Quick Question ⌥⏎ · Esc), terminal ⌘K (writes the command, does not run it), Review Changes multi-diff editor (turn-start vs now), git review against a branch, diff block inside chat edit cards (click to expand, ⌘-click opens), Codex plugins/MCP list (same config as the Codex app), Muster Tab completions (off by default; status bar toggles).
- Remaining: agents window, browser/visual editor, Redo checkpoint, worktrees/background agents.
- Mode behaviours (not names): Agent/Debug auto-fix language-service errors in the files the agent edited (one round); Plan/Spec run Codex plan mode; Spec with a plan spins up a new agent thread with the plan file as context; Ask/Project are read-only; Debug is Cursor's three-stage flow (instrument → "Issue reproduced, please proceed" → fix → "The issue has been fixed. Please clean up the instrumentation.", Enter on the empty composer advances); Triage selects the delegating (ultra) effort; Multitask splits the request into tasks that run in parallel threads on the board.

## Status update 2026-09-03 (end of day) — first real end-to-end runs on the app's own repo
- Plan mode → plan card (selectable to-dos, planned-with model, build model picker, split Build) → Build implemented exactly the selected to-do (README edit) with a real Codex turn. Verified through the dev harness (`chat` with `build:[0]`).
- Plan editor for `*.plan.md` (custom editor, default for the pattern): Preview ⌄ · model ⌄ · Build ⌘⏎ ⌄, selectable to-dos, opens automatically when a plan is produced.
- Fixes found by dogfooding: one warm app-server process per pane tab (writer conflicts), collaboration mode sent every turn (Codex otherwise stays in plan mode and refuses edits), turn/diff/updated adopted so shell-made edits get the inline diff + review controls, pane webview escapes, socket handover, harness field pass-through.
- Density per Cursor: tool calls as 22px lines, tab row is the pane header (composite title hidden), compact bubbles/cards, welcome shortcuts in the empty editor (New Agent ⇧⌘L, Show Terminal ⌘J, Search Files ⌘P, Maximize Chat ⌥⌘E, Add Repository, Open Settings).
- Next: the remaining checklist (agents window, browser, redo checkpoint, worktrees), then a full pass with the harness over every mode (Debug stages, Triage, Multitask) on this repo.

## Status update 2026-09-03 (late evening)
- Browser + visual editor (v1): ⇧⌘B opens a browser pane beside the code (its own editor group; ⌘T new tab, ⌘R reload, ⌘L location bar); a main-process WebContentsView (VS Code's own window mechanism) is positioned over a placeholder tab; toolbar ← → ⟳ · URL · ⌖ pick · ⧉ screenshot. Pick installs a hover/click picker in the page and sends selector, HTML, text, rect, computed styles + a PNG screenshot to the composer (`@browser @image:…`); `@browser` context = URL, title, selected element, console tail. Verified on a local site through the harness (attach, title, eval, console levels, pick, screenshot, expansion).
- Settings page (General/Models/Rules/MCP/Skills/Plugins/Hooks/Docs), SCM "Review changes with agent", review-on-commit setting; context kinds @Docs/@Git/@Terminal/@Past Chats/@Web/@Browser + images; Codex status chip; inline-diff polish (inner boxes, first-line fade, ⌥J/⌥K/⌥L/⌥H, multi-file bar); ⌘L/⌘I; Muster Light; Sign-In indicator removed.
- Still to do in the browser: DevTools/network panel for the agent, agent-driven navigation tools (Codex computer use covers the system browser), source mapping of picked elements to files (Cursor's visual editor jumps to the component).

## Browser — how Cursor does it (mined 2026-09-03) and what we ship
- Cursor's browser is a **browser editor** (`workbench.editor.browserEditor` / `workbench.input.browserEditor`): an editor tab in the editor area. Chrome: `.browser-tab-container` › `.browser-navbar` (32px; `.nav-button` ← → ⟳ at opacity .5; `.url-input` "Enter URL or search..." 12px with hover/focus input background; `.url-loading-bar`), `.browser-tools` (separator, "Select element", a second tool), `.browser-bookmarks-bar`, `.browser-frame-container` (white once `[data-loaded]`), `.browser-error-overlay` (certificate errors with trust/reject), `.browser-lock-overlay` with a "Take control" pill while the agent drives the page, and a `browser-change-item` list (old → new values) inside the composer's element-selection box under a "CHANGES" title. Keys: ⌘T new browser tab, ⌘R reload, ⌘L location bar (when the browser editor is active). Context key `cursor.browserTabEnabled`. The agent uses the browser through Playwright MCP tools (mention `playwright_mcp` = "Browser"; `browser_navigate` with an origin allowlist policy).
- Muster Code: same shape — a browser editor tab beside the code (default) backed by a main-process WebContentsView, navbar/tools as above, element pick → selector/HTML/styles/source + screenshot into the composer, `@browser` context (URL, title, selected element, console). `muster.browser.location = pane` keeps the Agent-pane tab variant (URL bar + Console/Selected/Page sections). Not yet: bookmarks bar, certificate overlay, lock overlay/Take control, the CHANGES list (visual edits old → new), and exposing the browser to Codex as MCP tools (Cursor: Playwright MCP).

## Browser as agent tools, composer menus — 2026-09-03

**Composer `@` / `/` menus (user report: no arrow keys, lag, no colour).** Causes: the popover only ever accepted item 0 (no selection state); every keystroke ran a workspace glob plus `git log` plus a Codex `thread/list` process spawn; results could arrive out of order. Now: in-memory file index (`findFiles` once, refreshed in the background every 45 s; open editors first when the query is empty) with Cursor-style ranking (name prefix → name substring → path substring → subsequence, shorter paths first); commits cached 15 s; past chats from the last listing, refreshed in the background; 40 ms debounce; `seq` guard drops stale replies; ArrowUp/Down move a highlighted `.sel` row (mouse hover follows), Enter/Tab accept it, Escape closes; file rows get a coloured extension badge (seti colours), context kinds an amber glyph. Measured through `{"cmd":"suggest"}`: 0–1 ms per query. Mentions in the text glow amber (backdrop `mark`) once validated (`validate` → `validated`: files exist, skills listed, kinds known); unknown ones are dashed; a chips row above the input mirrors them with × removal and an `@ Add Context` chip.

**Browser tools for Codex (Cursor: the agent drives the IDE browser).**
- `packages/builtin/src/browser-mcp.ts` → `dist-ext/browser-mcp.js`: a stdio MCP server with 14 Playwright-style tools (`browser_navigate`, `browser_snapshot` with `[ref=eN]` handles, `browser_click`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_select_option`, `browser_screenshot` (PNG image content), `browser_console_messages`, `browser_evaluate`, `browser_wait_for`, `browser_go_back`, `browser_reload`, `browser_tabs`). It bridges every call over a unix socket to the extension host; a trace is written next to the socket (`<sock>.log`); calls time out after 90 s instead of hanging.
- `packages/builtin/src/browser-tools.ts`: the socket server. Tools run against the tab the user is looking at (pane tab or browser editor), opening one when none exists; actions use real input events through the main process (`muster.browser.input` → `webContents.sendInputEvent`), clicks are verified by a capturing listener with a synthetic fallback, navigation waits for load completion (`muster.browser.waitLoad`, main-process `awaitLoad`). While driving, the page shows Cursor's lock banner ("Agent is using the browser · Take control"); Take control (banner button, or the pane's pill) stops further tool calls until the next turn. Turn hooks in `codex.ts` (`turnHooks.start/end`) reset the state.
- Codex wiring (`codex.ts`): the app-server is spawned with `-c mcp_servers.muster_browser.command=<launcher>`; the launcher is a per-window shell script in the temp dir with `ELECTRON_RUN_AS_NODE=1` and `MUSTER_BROWSER_SOCK` baked in, so it works however Codex or its exec runtime spawns it. A developer note tells the model to prefer these tools over other browser automation (the user's Computer Use plugin otherwise wins).
- Main-process findings: Code-OSS attaches a `will-navigate` preventDefault to every webContents it creates — links and `location.assign` in our browser views were silently blocked (for humans too) until we remove that listener on our views. Localhost loads now revalidate (`Cache-Control: max-age=0` request header via `webRequest`) and reload bypasses the cache, because static dev servers otherwise serve stale pages; main-frame load failures land in the console section; self-signed certificates are trusted for localhost only.
- Visual editor: the Selected section has editable text and style fields (color, background-color, font-size, font-weight, padding, margin, border-radius) applied live; the Changes tab lists them as old → new with revert, and "Apply changes in chat" hands them to the agent as a prompt (Cursor's CHANGES list).
- Verified: `scripts/dev/mcp-test.py` drives the shim exactly as Codex does — 12/12 pass (navigate, click, type+submit, select, hover, link click, back, reload, bad port, bad ref). Real Codex turns: Codex 0.152.1 (gpt-5.6-sol) loaded the server and listed the tools; with tool search on, it calls MCP tools from its `exec` JS runtime (`tools.mcp__muster_browser__browser_navigate`), and that exec-runtime call never reached the shim (turn silent 180 s) when the command was the bare Electron helper with env in config. The launcher fix above addresses the likely cause (spawn without our env); **one real turn still has to confirm it** — type in the Agent pane: "Open http://127.0.0.1:8765/ in the browser, click 'Click me' and tell me what the output box says" with the test site served.
- Not yet: bookmarks bar, DevTools/network panel, certificate overlay UI, exposing the tools to Claude turns (`--mcp-config`).

### `@` and `/` typeahead — rebuilt on Cursor's structure (2026-09-03, later)
Mined from Cursor 3.18.25 (`workbench.desktop.main.js`: mention-menu modes and titles, `menu-row` data attributes, `.typeahead-popover`, `.context-pill`, `.mention` CSS; codicon codepoints from our own bundle).
- **Empty state (`@` alone, mode "all")**: up to 3 recent files on top, then navigation rows **Files & Folders**, **Past Chats**, Docs (when configured), Terminals (when open), **Commits**, followed by the direct kinds Branch (Diff with Main), Working Tree, Web, Browser (when a tab is open). Navigation rows carry a chevron; Enter or → enters the mode, which shows a back header ("‹ Files & Folders"), filters within the mode as you type, and Backspace on an empty query returns to "all" (the range typed after `@` is dropped on mode changes, as Cursor does).
- **Typing**: one **Results** section — files ranked (name prefix → name substring → path substring → subsequence), then matching kinds, docs, terminals, past chats, commits (for sha-like or git/commit/log queries). Matched characters are highlighted (`list.highlightForeground`).
- **Rows**: 24 px, 12 px text, 2 px 6 px padding, radius 4, selected row `list.hoverBackground`; icon 16 px (codicon glyphs from the app bundle via `@font-face`, seti-coloured extension badges for files); the secondary text is right-aligned with `direction: rtl` so long paths truncate from the left. Popover 300 px wide, 2 px padding, radius 6, shadow 0 5px 10px rgba(0,0,0,.3).
- **`/` menu**: **Commands** — Reset (new chat), Summarize (asks for a summary of the thread), Agent Review (a read-only review turn over the working tree), Open Browser — which act immediately and are not inserted; custom commands from `.cursor/commands`, `.claude/commands`, `.muster/commands` (workspace and home, `*.md`/`*.txt`, description from frontmatter or the first line; a leading `/name` in a prompt expands to the file content with `$ARGUMENTS`); **Skills** from `skills/list`.
- **Inline mentions**: quiet pill (`fg` 12 %, radius 6, padding 1px 4px) on the backdrop once a token is complete; unresolved tokens dashed; the token under the caret is not a pill until chosen. **Context pills** above the input follow `.context-pill`: 20 px, 12 px text, 1 px `stroke-secondary` border, radius 4, icon (codicon or extension badge) that turns into × on hover; "Add Context" is a dashed suggestion pill.
- **No timers on the keystroke path**: Chromium aligns timers to 1 s in an occluded window, which made the old 40 ms debounce fire 130–640 ms late; requests go out per keystroke with a sequence guard, and the extension answers from memory in 0–9 ms.
- Verified through the harness composer probe (`{"cmd":"pane","input":"…"}` then `{"cmd":"pane"}` → `probe.rows/chips/marks`) for `@`, `@agent-p`, `@brow`, `/`, `/rev` and a mixed prompt.

## Pending against Cursor — consolidated 2026-09-03 (night; supersedes the checklist at the top)
**Built and verified live**: IDE shell/skin/themes/chrome; Agent pane (tabs, history per folder, board, discovered modes and behaviours, Codex+Claude model picker, efforts, access modes, inherited threads with full history); plan mode end to end (plan card, to-do selection, planned-with model, build model picker, `.plan.md` editor + breadcrumb toolbar, plan checkpoints); realtime inline diff with token boxes, hunk widgets, review bar, multi-file Keep all / Review next file, review on commit; browser (editor tab + pane tab, pick → source, screenshot, console, `@browser`, agent tools via the shim, Take control, Changes tab); `@` and `/` typeahead on Cursor's structure; context kinds files/ranges, git diff/branch/commit, terminals, docs, past chats, web, browser, images; custom commands; skills/plugins/MCP listing; settings page; usage chip; dev harness.
**Built, not yet verified with real turns**: editor ⌘K prompt bar and terminal ⌘K; Debug stages, Triage, Multitask, Spec, Ask; checkpoint restore/redo; approvals and elicitations (computer use); Claude turns; Muster Tab completions (off by default); browser tools from Codex's `exec` tool-search runtime (launcher fix applied).
**Pending**:
1. Terminal tool execution as Cursor cards: live stdout/stderr, Run / Skip, approval inside the chat (⏎ / ⇧⏎ / Esc) instead of VS Code notifications, background continuation.
2. Markdown renderer: file-path links, tables, copy/apply on code blocks, streaming caret, citations; Mermaid (V2).
3. Cursor Tab: partial accept (⌘→), next-edit prediction, snooze, status-bar state; the provider itself exists.
4. Checkpoints per human message with `thread/rollback` + workspace snapshot; "Redo checkpoint" after restore (partial).
5. Multi-file review editor ("Review Changes": changed-files tree, per-file Keep/Undo, unified/split) — today: per-file cards + review bar + `vscode.changes`.
6. Context kinds still missing: `@folder`, `@code`/symbols, `@link` (URLs), rules as mentions, current-file suggestion pill, PR / PR diff, projects, MCP attachments; pill hover actions (Open / Remove / Collapse); hovered-file side preview in the menu.
7. Settings pages Cursor-style for rules (enable state, auto/manual, Markdown editor), MCP (enable/disable, tools, health, auth, logs), skills, hooks, custom modes editor.
8. Shortcut parity pass from the atlas table (⌘. mode cycle, ⇧⌘L, ⌥⌘E, ⇧⌘B, ⌘⏎/⌘⇧⌫, ⌘Y/⌘N, ⌥J/⌥K, ⌥L/⌥H) with `when` clauses.
9. Browser: bookmarks bar, DevTools/network, certificate overlay UI, headless tabs, tools for Claude turns; agent screenshot annotations.
10. Dictation; thread rename/pin/archive/export in the history tab; "Generating… Stop ⇧⌘⌫" label state.
11. V2 (owner: not yet important): Agents window, background agents, worktrees; git review surface.

## Turn control, checkpoints, full access — 2026-09-04
- **Typing mid-turn**: Enter while a turn runs sends the message into the running turn (`turn/steer` on the warm process, shown as a user bubble labelled "added mid-turn"); if the provider cannot take it (no active turn, Claude), it is queued under the messages ("Queued", × to drop) and sent when the turn ends. Verified live.
- **Stop**: the send slot becomes a Stop button while running; ⇧⌘⌫ anywhere in the pane; `turn/interrupt` scoped to the tab's conversation. Verified live (2 s).
- **Edit a sent prompt** (hover → Edit, or double-click): the workspace goes back to that point (every later turn's checkpoint restored, newest first), the provider forgets the turn and everything after it (`thread/revert { beforeTurnId }` for paginated threads, `thread/rollback` fallback), the chat is truncated, the edited text is resent. Verified live: after editing, the model's own memory holds only the new turn. **Restore checkpoint** (hover → Restore checkpoint) does the same without resending.
- Turn ids come from `turn/started` and are stored on the user message; `thread/rollback` is refused for paginated threads ("paginated threads do not support thread/rollback"), which is every thread this app-server version starts.
- **Full access = Cursor auto-apply**: the inline diff renders without per-hunk Accept/Reject widgets (`widgets:false`), the colours stay in the files, the bar offers Keep all / Undo all; Manual approval and Read only keep the review widgets.
- **Cards keep their counts after Keep** (`kept` adds/dels survive settling; "+2 −1 · kept" instead of "+0 −0").
- **Shell-made edits are painted**: a turn watcher snapshots dirty files at turn start and adopts every working-tree change the agent makes (origin from the snapshot, else HEAD, else empty for new files) after each command and at turn end — `turn/diff/updated` only covers apply_patch.
