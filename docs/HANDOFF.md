# Muster Code — Handoff Spec

Read this first. It is written so that any builder (Codex included) can continue exactly the way the work has been done so far: research Cursor from its own bundle, build the Cursor shape, verify live in the running app, never guess.

## 0. Acceptance criteria and owner rulings (verbatim intent)

- **"CURSOR is the AIM AND ACCEPTANCE CRITERIA."** Replicate Cursor 3.18's UI/UX exactly. Not the VS Code / Copilot chat style. Verify against `/Applications/Cursor.app` (installed, logged in). "The nuances are very subtle yet effective" — mine Cursor's own CSS/JS for exact values (`docs/reference/`), do not eyeball.
- Standalone app, not an extension ("those work half assed"). Every VS Code feature + every Cursor feature + every Codex app feature (browser, annotations, computer use) "in a code environment to check what code is being changed".
- Codex-first on the owner's ChatGPT plan. **Models and modes are never hardcoded**: models come from the app-server (`model/list`, with reasoning efforts), access modes from `permissionProfile/list` (Full access / Manual approval / Read only presets as the app exposes them), custom modes from config.
- **Threads are inherited with their full history** (the owner's existing Codex threads, by the app's names, every detail, scrollable end to end). Per-thread model/mode switching. Pinned threads. History tab.
- Modes: Agent, Plan, Ask, plus a **Kanban mode** (a new mode like Plan, backed by muster's board), plus custom modes.
- The inline diff is **realtime streaming**: "words and green and red batches, not post hoc", "LIKE CURSOR". Done — see §4.
- **Preview of the code diff inside the chat** (Cursor shows each edited file as a card with a +/- diff block in the message flow) is required.
- "Light yet all batteries", "full scale end product, not an MVP", "all my threads intact". Closed source, repo under the `musterhq` GitHub org.
- The owner tests; the builder codes. Do not launch GUI windows or pop dialogs on the owner's screen without purpose; one relaunch per verified change is acceptable; screenshots are fine.
- Owner's Codex usage was at 93% on 2026-09-03: be economical, batch work, verify before claiming.

## 1. Architecture

```
dist/Muster Code.app            ← Code-OSS 1.126 (VSCodium arm64 zip) + overlay + patches (scripts/assemble.sh)
├─ product.json                 ← product/product.overlay.json merged (one level deep) — checksums forced to {} by the patch script
├─ out/vs/workbench/workbench.desktop.main.js  ← patched: chat-extension guard + injected product/muster-inline-diff.js
├─ out/vs/workbench/workbench.desktop.main.css ← product/muster-workbench.css appended (Cursor skin + inline-diff widgets)
└─ extensions/muster.muster-code               ← packages/builtin (built by esbuild → dist-ext)
   extensions/muster.theme-muster              ← packages/theme (Muster Dark = Cursor Dark palette + layout defaults)
```

- **Extension host side** (`packages/builtin`): the Agent pane (webview in the secondary sidebar), Codex threads as chat sessions, the default chat participant + language-model provider (native chat kept as plumbing), the live-edit state machine, the dev control socket. Engine: `@musterhq/core` (the open-source muster, linked from the sibling checkout) — `runCodexAppServer` with `onEvent(method, params)` / `onRequest(method, params) → response | undefined` hooks (core commit `44be654`).
- **Workbench side** (`product/muster-inline-diff.js`): injected into the bundle after its `export{...}` statement, so it sees the module-level service identifiers. Resolved at patch time by `scripts/patch-workbench.py` from anchors: CommandsRegistry (`("commandService"),X=new class{constructor(){this._commands=new Map`), `ICodeEditorService`, `IModelService`, `ILanguageService`, `ICommandService` (each `X=createDecorator("<name>")`). It registers `muster.inlineDiff.render` / `muster.inlineDiff.clear` and calls back `muster.edit.hunk` / `muster.edit.file` / `muster.edit.go`.
- **Why a workbench patch**: extension-API decorations cannot right-align widgets or be clicked, and webview insets fail under profile contention. Cursor itself is a workbench contribution (`acceptRejectPartialEditWidget`, `inline-diff-*`, `pure-ai-prompt-bar`); we mirror that.
- **Codex protocol**: JSON-RPC over the app-server; events `item/*`, `turn/*` forwarded raw to `LiveEditController.onEvent`; server→client requests (id + method) go to `onRequest` (approvals, user input, MCP elicitations = computer-use). Full method list in §6.

## 2. Repo map

| Path | Role |
|---|---|
| `scripts/assemble.sh` | Fetch base zip → unpack → overlay → branding (plist, helper renames, launchers) → build + copy extensions → `patch-workbench.py` → append skin CSS → ad-hoc codesign |
| `scripts/patch-workbench.py` | Idempotent: chat-extension guard, inject inline-diff contribution (anchors resolved by regex, exits 1 if missing), `checksums = {}` |
| `scripts/overlay-product.mjs` | product.json overlay (objects merge one level deep — `checksums` must be cleared by the patch step, not the overlay) |
| `product/product.overlay.json` | Names, ids, `defaultChatAgent` (must exist; workbench dereferences it), API-proposal grants for `muster.muster-code` |
| `product/muster-workbench.css` | Cursor skin for native chrome + `.muster-*` inline-diff widget styles (values from `docs/reference/`) |
| `product/muster-inline-diff.js` | Workbench contribution (decorations, tokenized ghost view zones, hunk overlay widgets, review bar) |
| `packages/builtin/src/extension.ts` | Activation: participant, sessions, model provider, `LiveEditController`, `AgentPane`, commands, status-bar cluster, dev control |
| `packages/builtin/src/agent-pane.ts` | The Agent pane webview (composer, messages, edit cards, review bar) — to be rebuilt per §7b |
| `packages/builtin/src/codex.ts` | `listThreads`, `readHistory`, `runTurn` (app-server, keepAlive, `model_reasoning_summary=detailed`), `interruptTurn` |
| `packages/builtin/src/apply-patch.ts` | Streaming `apply_patch` parser (`push(delta) → touched files`, `render(file, origin)`), tested |
| `packages/builtin/src/line-diff.ts` | Myers line diff → hunks (`baseStart/baseCount/targetStart/targetCount/removed[]`), `applyHunk`, tested |
| `packages/builtin/src/live-edit.ts` | Live-edit state: origin/baseline/target per file, 33 ms coalesced flush with minimal edits (no undo stops), reconcile on `item/completed` + revert to clear dirty, accept/reject per hunk/file, drives the painter |
| `packages/builtin/src/dev-control.ts` | `MUSTER_CODE_DEV_SOCK` unix socket: `replay`, `exec`, `state`, `text` (JSON lines) |
| `packages/builtin/types/*.d.ts` | Vendored VS Code 1.126 proposed typings in use |
| `packages/theme/` | Muster Dark theme + `configurationDefaults` (activity bar top, custom title bar, secondary sidebar visible, inline diffs) |
| `docs/cursor-ux-spec.md` | Measured Cursor spec (tokens, composer, bubbles, cells) |
| `docs/cursor-parity-spec.md` | Owner's checklist with status + "Mined from Cursor 3.18.25" section |
| `docs/cursor-feature-atlas.md` | Feature-by-feature sweep of Cursor's bundle (extensions, decoded shortcuts, modes, plan mode, layouts, context kinds, settings) |
| `docs/reference/cursor-inline-diff.css`, `cursor-widgets.css`, `cursor-tokens.txt`, `*.png` | Raw extracts from Cursor's bundle + reference frames |

## 3. Build, run, verify

```bash
pnpm install                       # CI=true if non-TTY
pnpm assemble                      # → dist/Muster Code.app (BASE_TAG=1.126.04524)
cd packages/builtin && pnpm typecheck && pnpm test && pnpm build

# dev launch (own profile; socket path must stay short)
MUSTER_CODE_DEV_SOCK=/tmp/mc-dev.sock "dist/Muster Code.app/Contents/MacOS/Muster Code" --user-data-dir /tmp/mc-udd /tmp/mc-sample

# hot-swap without reassembling
rm -rf "dist/Muster Code.app/Contents/Resources/app/extensions/muster.muster-code" && cp -R packages/builtin/dist-ext "…/extensions/muster.muster-code"
python3 scripts/patch-workbench.py "…/out/vs/workbench/workbench.desktop.main.js" product/muster-inline-diff.js "…/product.json"
# refresh the appended CSS block ("/* ── Muster inline diff" marker) then reload:
printf '%s\n' '{"cmd":"exec","command":"workbench.action.reloadWindow"}' | nc -U /tmp/mc-dev.sock

# stream a patch into the running editor (no Codex quota needed) and inspect
printf '%s\n' "$(python3 -c 'import json;print(json.dumps({"cmd":"replay","patch":open("patch.txt").read(),"pace":45,"chunk":4,"itemId":"dev-1"}))')" | nc -U /tmp/mc-dev.sock
printf '%s\n' '{"cmd":"state"}' | nc -U /tmp/mc-dev.sock
screencapture -x shot.png          # full screen captures whatever the owner is doing — prefer the app window only:
# WID=$(osascript -e 'tell app "System Events" to id of window 1 of process "Muster Code"'); screencapture -x -l "$WID" shot.png (fall back to full screen only if the window id lookup fails)
```

Rules learned the hard way: a window reload serves the workbench CSS from Electron's cache — after editing `product/muster-workbench.css` relaunch the app (the injected workbench JS is cached the same way, so relaunch after `patch-workbench.py` too); use the harness `muster.css` / `muster.cssParse` / `muster.dom` commands to check what the browser actually parsed and rendered; when killing the dev app from a script, write the pkill pattern with a bracket (`Muster [C]ode`) or pkill matches the script's own shell; after `reloadWindow` never delete the socket file (the new ext host recreates it within ~2 s; deleting it strands the harness); kill every stale instance before relaunching (`ps -A | grep mc-udd`; two instances on one profile → "Could not register service worker", blank webviews); the workbench patch must run after any product.json edit (checksums); `engines.vscode` must be a real version; extension id = manifest `name` ("muster-code"); `defaultChatAgent` must exist; the chat-extension auto-disable must stay patched.

## 4. Done and verified (2026-09-03)

- App assembles, launches, activates (60 Codex threads discovered), Cursor layout defaults, Muster Dark = Cursor Dark palette (`#181818/#141414/#F0F0F0`, diff `#3FA26633/#B8004933`).
- **Realtime inline diff, Cursor architecture**: streamed `item/fileChange/outputDelta` → parsed incrementally → rendered into the file's own editor at ~30 fps; added lines get `diffEditor.insertedLineBackground` + ruler marks; removed lines are **syntax-tokenized view zones without line numbers**; each settled hunk has a right-aligned "n of m · Reject ⌘N · Accept ⌘Y" overlay on the line after it (pending hunk has none); the view follows the active modification; on `item/completed` the buffer converges to disk and is reverted clean (no save-conflict prompts). Accept/reject per hunk (baseline advances), per file, all; keyboard ⌘Y/⌘N/⌘⏎/⌘⌫ (when `muster.liveEdit && editorTextFocus`), ⌥F5/⇧⌥F5 navigation. Verified live via the socket harness with screenshots (3 hunks, clean disk state, no errors).
- Agent pane: composer per Cursor tokens, edit cards with live +/-, review bar "▸ N files +a −d · Reject · Accept" with per-file rows.
- Core hooks (`onEvent`/`onRequest`) + request-detection fix, unit-tested (core 737/737).

Verified after reload (2026-09-03 14:10 IST): Accept button visible (green), bottom bar "⌃ 1 / 3 ⌄ · Undo All ⌘⌫ · Keep All ⌘⏎" rendered, compact widget on long lines, accept-hunk → 2 hunks left, undo-file → clean buffer + original disk. The fixes were:
- Accept button invisible → `isolation: isolate` added to `.muster-btn` / `.muster-nav` (the green `::before` at z-index −1 needs a stacking context).
- Bottom review bar off-screen → Monaco's overlay container has width only; the bar is now positioned by `top = editor height − bar height − 14`.
- Widgets now switch to a compact (shortcut-only) form when the line's text would collide (`textEnd + 32 > width − right − widgetWidth`), as Cursor does.

## 5. Cursor facts that drive the build (all mined; details in the reference files)

- Tokens: bg 20/14/8/6/4 % of `editor.foreground`; stroke 20/12/8/4 %; text quaternary 36 %; icon secondary 66 %; colored `*-secondary` 24 %; radius 4/6/12; font 11/12/13/14; line-height 22 in chat.
- Inline diff: green `insertedLineBackground` (fallback `rgba(12,233,27,.2)`), red view zones opacity .9 padding-left .5px, inner-change boxes `rgba(12,233,27,.15)` / `rgba(242,13,59,.25)`, first-line 10 px right fade; hunk widget = counter (min-width 36, 12 px tabular, padding 2/6, bg 67 % of bg-secondary) + secondary Reject (bg stroke-secondary) + primary Accept (charts.green 85 % over editor bg, button fg), 22 px tall, `.keyboard-shortcut` opacity .7; file bar `pure-ai-prompt-bar` (max 720 px, gap 40): "n / m", "Undo"/"Undo All" text, "Keep"/"Keep All" primary with hint, multi-file "Keep all changes" + next-file chevron.
- Composer placeholders by mode: new "Plan, Build, / for skills, @ for context"; agent "Plan, search, build anything"; chat "Ask, learn, brainstorm"; edit "Work on explicitly added files (no tools)"; follow-up "Add a follow-up"; pending question "Reject, suggest, follow up?"; plan steering "Steer the plan, or add more details".
- Plan mode: `.plan.md` opens as a rendered plan editor (breadcrumb with plan icon, "Preview ⌄", model picker, amber "Build ⌘⏎ ⌄"); chat shows a plan card (file header + export/expand, title + summary, "N To-dos" box with radio circles and "··· k more", footer "View Plan" · model · "Build ⌘⏎ ⌄"); human bubbles clip with a fade and carry "Restore Checkpoint" (26 px icon button) or "Stop ⇧⌘⌫" while running; plan-mode pill is amber with the plan icon.
- Chat pane header: title pill of the thread, "+", history clock, "…", close; chat tabs are threads.

## 6. Codex app-server protocol (from the generated schema; 161 methods)

Client → server (use these, never hardcode what they return): `model/list`, `permissionProfile/list`, `config/read`, `config/value/write`, `config/batchWrite`, `experimentalFeature/list`, `thread/list`, `thread/read`, `thread/resume`, `thread/start`, `thread/fork`, `thread/rollback`, `thread/compact/start`, `thread/name/set`, `thread/goal/{get,set,clear}`, `thread/metadata/update`, `thread/archive`, `thread/unarchive`, `thread/delete`, `thread/loaded/list`, `turn/start`, `turn/steer`, `turn/interrupt`, `review/start`, `skills/list`, `hooks/list`, `plugin/list`, `plugin/read`, `mcpServerStatus/list`, `mcpServer/tool/call`, `mcpServer/resource/read`, `account/read`, `account/rateLimits/read`, `account/usage/read`, `fs/*` (`readFile`, `writeFile`, `readDirectory`, `watch`…), `command/exec` (+ `write`, `resize`, `terminate`), `fuzzyFileSearch/*`, `externalAgentConfig/{detect,import}`, `thread/realtime/*` (voice), `attestation/generate`.

Server → client notifications: `item/started`, `item/completed`, `item/agentMessage/delta`, `item/reasoning/{summaryTextDelta,textDelta,summaryPartAdded}`, `item/fileChange/outputDelta`, `item/fileChange/patchUpdated`, `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`, `item/mcpToolCall/progress`, `item/plan/delta`, `turn/plan/updated`, `turn/diff/updated`, `turn/started`, `turn/completed`, `thread/status/changed`, `thread/tokenUsage/updated`, `account/rateLimits/updated`, `model/rerouted`, `skills/changed`, `hook/{started,completed}`.

Server → client **requests** (must be answered; core routes them to `onRequest`, declining by default): `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `item/tool/call`, `mcpServer/elicitation/request` (computer use: bundled plugins `computer-use@openai-bundled`, `unified-computer-use@openai-bundled`; answer like T3 Code does), `openai/form`, `thread/shellCommand`.

Streaming edit format: `item/fileChange/outputDelta {delta, itemId, threadId, turnId}` carries `apply_patch` text (`*** Update/Add/Delete File:`, `*** Move to:`, `@@` hunks, ` `/`+`/`-` lines); `item/completed` for a `fileChange` item lists `changes:[{path,kind,diff}]` after the server wrote the files.

## 7. Backlog, in order, with the specs

a. **Inline diff polish**: verify the three staged fixes; word-level inner-change boxes (diff within changed line pairs); first-line right fade; multi-file bar ("Keep all changes" + next file); `Add File`/`Delete File`/`Move to` visuals; keybinding `when` should also require the active editor to be a live file (context key per resource); undo/redo semantics after accept; per-hunk widgets clickable (done) and hover states; light theme values from Cursor Light (`docs/reference`).

b. **Agent pane rebuild** (Cursor chat, nothing hardcoded):
   - Header: thread title pill (editable via `thread/name/set`), "+" new agent (⇧⌘L), history (clock) opening the History tab (all threads by name, project, age, turns, size; pin/unpin; archive), "…" (settings, export), close. Chat tabs = open threads; pinned threads persist (workspace state) and show first.
   - Inherit threads: list via `thread/list` (+ local rollout discovery for unnamed ones), open via `thread/read`/`thread/resume` and render the **entire** history: human bubbles, assistant markdown, reasoning ("Thinking"/"Thought" details), tool cards (Read file, terminal with output), file-change cards **with the +/- diff preview block in the message** (Cursor's cell: file header, stat, expandable diff), plan cards, approvals as they were answered. Scroll to end, unlimited scrollback.
   - Composer: placeholder per mode (§5), "@" context picker (files/folders/code/docs/git/past chats/rules/terminals/web…), "/" skills from `skills/list`, attachments (images), mic, send/stop with "Generating.. Stop ⇧⌘⌫". Mode pill (⌘. cycles): Agent / Plan / Ask / **Kanban** / custom modes; access mode from `permissionProfile/list` (labels as returned; the owner calls them Full access / Manual approval / Read only) sent as the thread's approval/sandbox settings; model pill from `model/list` with the model's own reasoning efforts; all per thread, persisted through `thread/settings` and workspace state.
   - Plan mode: `turn/plan/updated` + `item/plan/delta` → plan card with to-dos and "View Plan / Build"; plans saved as `.plan.md` under the workspace (Cursor: `.cursor/plans/<name>.plan.md`; use `.muster/plans/`), opened in a rendered plan editor with the toolbar (§5).
   - Kanban mode: the muster board (columns of tasks/threads) rendered in the pane/editor; a task → thread; board state from muster core.
   - Approvals and questions: `onRequest` → cards with buttons (Allow once / Always / Deny; user-input forms; elicitation for computer use) — never auto-decline silently in Full access; in Manual approval show the card.
   - Status bar cluster: "Muster Tab", "Agent Stats", rate limits from `account/rateLimits/updated`.
   - Markdown renderer: headings, lists, tables, task lists, code blocks with language + copy + "apply", inline code, links, file/line links opening the editor, streaming caret.

c. **Cmd-K inline prompt** (critical): floating input at the cursor/selection in the editor and terminal, streams a diff into the selection using the same painter (`muster.inlineDiff.render`), Accept/Reject, follow-ups.

d. **Tab completions**: `inlineCompletionsAdditions` provider fed by a Codex/local model, partial accept, snooze; status bar "Muster Tab".

e. **Checkpoints**: per human message "Restore Checkpoint" = `thread/rollback` + workspace snapshot (git stash-like under `.muster/checkpoints`).

f. **Rules / MCP / Skills / Hooks views**: `.muster/rules`, `mcpServerStatus/list`, `skills/list`, `hooks/list`, `plugin/list` in settings-style pages like Cursor's.

g. **Terminal tool execution**: `item/commandExecution/*` → terminal cards with live output, "Run in terminal"/"Skip"; `command/exec` for the app's own commands.

h. **Multi-file review** (`app-layout-multi-diff-*`): a review editor listing changed files with per-file Keep/Undo and "Review next file".

i. **Agents window / board (V2)**, **browser** (T3-style preview MCP + screenshots/annotations), **git review**.

## 8. Method

1. Before building a surface, mine Cursor's bundle for it (strings → component → CSS rules → tokens); record the facts in `docs/`.
2. Build; typecheck + unit-test; hot-swap; reload via the socket; drive it via `replay`/`exec`; screenshot; compare with the Cursor frame; iterate. Claim only what the screenshot shows.
3. Commit small, push to `musterhq/muster-code` main; keep `docs/cursor-parity-spec.md` statuses current.

## Rules learned — 2026-09-03 (browser tools, composer)
- Code-OSS's main process guards every new webContents with `will-navigate` → `preventDefault()`; a browser view must `removeAllListeners("will-navigate")` (now + `setImmediate` + first `did-start-loading`) or links never work.
- `loadURL` to the URL a view already shows returns before the new document commits; never poll `document.readyState` after navigating — await `did-finish-load`/`did-stop-loading` in the main process (`awaitLoad`).
- Static dev servers (python `http.server`) serve stale pages from Chromium's heuristic cache; localhost requests get `Cache-Control: max-age=0` and reload uses `reloadIgnoringCache()`.
- Codex spawns MCP servers itself; hand it a launcher script with the environment baked in (temp dir, per window), never a bare Electron binary that depends on `ELECTRON_RUN_AS_NODE` from config. With tool search enabled Codex calls MCP tools from its `exec` runtime (a separate process); trace the shim (`<sock>.log`) to see whether calls arrive.
- The webview script check must gate the build: a broken template escape reached the app twice. Pipeline: `tsc` → webview `node --check` → `esbuild` → swap → reload; each step `|| exit 1`.
- Popover data must be in-memory: no `findFiles`, `git`, or app-server spawn on the keystroke path (`{"cmd":"suggest"}` measures it).
- Real Codex turns cost the user's plan; verify with the shim harness first, and run one confirming turn only for provider-side behaviour.
- Never debounce with `setTimeout` in the pane webview: an occluded window gets 1 s-aligned timers (measured 130–640 ms late). Post immediately and guard with a sequence number; the harness composer probe needs ~2 s waits for the same reason.
- Codex app-server: `turn/steer {threadId, expectedTurnId, input}` joins a running turn; `thread/revert {threadId, beforeTurnId}` is the rollback for paginated threads (`thread/rollback` is refused); both must go to the warm process that owns the thread (`callCodexConversation`).
- `turn/diff/updated` fires only for apply_patch edits; shell edits need the turn watcher (`beginTurnWatch`/`syncTurnWatch` in live-edit).
