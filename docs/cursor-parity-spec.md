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
