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
