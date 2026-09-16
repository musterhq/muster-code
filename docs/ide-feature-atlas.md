# the reference IDE feature atlas (mined from the installed bundle)

Source of truth for every statement below: files under `/Applications/the reference IDE/Contents/Resources/app` (the reference IDE, commit `280eca2911f1774689696e5f1efa5a4f97a87af0`, product date 2026-08-31). Nothing here is inferred from docs or memory. Byte offsets (`@N`) refer to `out/vs/workbench/workbench.desktop.main.js` (42,008,009 bytes, 19,584 lines) unless another file is named. Human-readable `y(N,null)` labels were decoded from `out/nls.messages.json` (13,620 entries). Minified identifiers are quoted where they matter for cross-checking (e.g. `m1s="composer.startComposerPrompt"`).

Where a fact could not be established from the bundle it is listed in section 10, not guessed.

---

## 1. Extensions and what each contributes

All built-in the reference IDE extensions live in `extensions/cursor-*` and are published as `anysphere.*`. Most have no `contributes` block at all: their behavior lives in the workbench JS and they expose it through proposed APIs (`cursor`, `cursorNoDeps`, `cursorAgentHost`, `cursorTracing`, `cursorPseudoterminal`, `control`). Only the `package.json` contributions are listed; empty arrays are shown as "none".

| Extension | description | activation | enabledApiProposals | extensionKind | contributes |
|---|---|---|---|---|---|
| `cursor-agent-exec` | "Provides agent execution capabilities for the reference IDE, enabling agents to run commands, interact with files, and use tools with user permissions and approvals" | `*` | control, cursor, cursorAgentHost, cursorTracing, cursorPseudoterminal | (default) | none |
| `cursor-agent-host` | "Hosts the reference IDE agent orchestration in the AgentExec extension host" | `*` | control, cursor, cursorNoDeps, cursorAgentHost, cursorTracing, cursorPseudoterminal | (default) | none |
| `cursor-agent-worker` | "Install and run the reference IDE agent worker from extension startup" | onStartupFinished | cursor, cursorNoDeps | (default) | none |
| `cursor-always-local` | "Implements experimentation features for the reference IDE" | onStartupFinished, `onResolveRemoteAuthority:background-composer` | cursor, control, externalUriOpener, contribSourceControlInputBoxMenu, textDocumentTextLength | ui | `menus.scm/inputBox`: `cursor.generateGitCommitMessage` when `scmProvider == git`; `jsonValidation`: `.cursor/environment.json` → `./schemas/environment.schema.json`, `.cursor/permissions.json` → `./schemas/permissions.schema.json`; `configuration` title "the reference IDE Always Local" (no properties); commands/keybindings: none |
| `cursor-browser-automation` (displayName "the reference IDE Browser Automation") | "MCP server for browser automation in the reference IDE" | onStartupFinished | control, cursor, cursorTracing | ui | none |
| `cursor-checkout` | "Checkout provider for branch migration operations" | `*` | cursor | (default) | none |
| `cursor-commits` | "Tracks requests and commits for the reference IDE online metrics" | onStartupFinished | control, cursor, cursorTracing, cursorNoDeps | workspace; depends on `vscode.git` | none (empty commands/keybindings/menus) |
| `cursor-deeplink` (displayName "the reference IDE") | "Handles deep-link URIs." | onStartupFinished, onUri | cursor, control, externalUriOpener | ui | command `cursor-deeplink.debug.triggerDeeplink` "Debug: Trigger Arbitrary Deeplink" (category "the reference IDE Deeplink") |
| `cursor-explorer` (displayName "the reference IDE Explorer") | "Workspace extension for the reference IDE Explorer" | onStartupFinished | cursor | workspace | none |
| `cursor-file-service` | "Handles indexing and retrieval for the reference IDE" | (none; no `main`) | (none) | (default) | none |
| `cursor-local-agent-runtime` | "Hosts the reference IDE Private Inference outside workspace extension hosts" | `*` | cursor | ui | none |
| `cursor-mcp` | "Handles MCP for the reference IDE" | onStartupFinished, onUri | control, cursor, cursorTracing | workspace | none (empty commands/keybindings/menus/configuration) |
| `cursor-ndjson-ingest` (displayName "the reference IDE NDJSON Ingest") | "HTTP server for ingesting NDJSON logs to workspace/.cursor/debug.log" | `onCommand:cursor.ndjsonIngest.start`, `onCommand:cursor.ndjsonIngest.reassignPort` | (none) | workspace | commands `cursor.ndjsonIngest.start` "the reference IDE NDJSON Ingest: Start Server", `.stop`, `.copyCurl` "Copy curl command", `.reassignPort` "Reassign port and restart server", `.showStatus` "Show server info"; configuration "NDJSON Ingest": `ndjson.port` (number, default 0, "Set to 0 for auto-allocation in range 7242-7942."), `ndjson.bindAddress` (default "127.0.0.1") |
| `cursor-polyfills-remote` | "Polyfills for workspace extension host" | `*` | (none) | workspace | none |
| `cursor-resolver` | "Background composer remote authority resolver for the reference IDE" | `onResolveRemoteAuthority:background-composer` | cursor, cursorNoDeps, resolvers | ui (has `browser` entry too) | `resourceLabelFormatters`: scheme `vscode-remote`, authority `background-composer+*`, label `${path}`, separator `/`, tildify, `workspaceSuffix: "cloud-agent"` |
| `cursor-resolver-helper` | "Connection token provider for the reference IDE resolver" | `onResolveRemoteAuthority:background-composer`, onStartupFinished | cursor, cursorNoDeps | ui | none |
| `cursor-retrieval` | "Handles indexing and retrieval for the reference IDE" | onStartupFinished | control, cursor, cursorNoDeps, cursorTracing, textSearchProvider2 | workspace | commands `cursor.grepClient.debug` "Debug Grep Client", `cursor.codebaseTelemetry.triggerSnapshot` "Trigger Codebase Snapshot" (category Developer; commandPalette `when: isDevelopment`); configuration "the reference IDE Retrieval": `cursor-retrieval.canAttemptGithubLogin` (boolean, default true, "Whether or not the reference IDE should attempt github login to augment retrieval results", scope resource); languages: `.cursorignore` and `.cursorindexingignore` → language `ignore` |
| `cursor-shadow-workspace` (displayName "the reference IDE Shadow Workspace") | "Manages a hidden local window that AI agents can use to refine their code before showing it to you." | onStartupFinished | cursor | workspace | none (empty commands/configuration) |
| `cursor-socket` | "TCP/TLS socket provider for the reference IDE extensions" | `onResolveRemoteAuthority:background-composer`, onStartupFinished | cursor, cursorNoDeps | ui | none |
| `cursor-worktree-textmate` (name `worktree-textmate`, displayName "Worktree TextMate Syntax") | "Provides TextMate-only syntax highlighting for .cursor/worktrees files without activating language servers." | (none) | (none) | ui | 28 `languages` with ids `worktree-<lang>` (typescript, typescriptreact, javascript, javascriptreact, python, go, rust, java, c, cpp, php, ruby, html, css, json, yaml, sql, swift, shellscript, protobuf, hcl, terraform, terraform-vars, terraform-stack, terraform-deploy, terraform-test, terraform-mock, terraform-search) matched by `filenamePatterns` `**/.cursor/worktrees/**/*.<ext>`; matching `grammars` in `./syntaxes/worktree-*.tmLanguage.json`; `configurationDefaults` set `editor.semanticHighlighting.enabled: false` per worktree language |

No `cursor-*` extension contributes `views`, `viewsContainers`, `customEditors`, `walkthroughs`, or `keybindings`. The `.plan.md` custom editor, all chat views, and every keybinding are registered in the workbench JS (sections 2, 4, 5).

### product.json (the reference IDE-specific)

- Identity: `nameShort`/`nameLong` "the reference IDE", `applicationName` "cursor", `dataFolderName` ".cursor", `serverDataFolderName` ".cursor-server", `serverApplicationName` "cursor-server", `tunnelApplicationName` "cursor-tunnel", `urlProtocol` "cursor", `darwinBundleIdentifier`/`linuxIconName` "co.anysphere.cursor", `win32AppUserModelId` "Anysphere.the reference IDE", `quality` "stable", `version` "3.18.25", `vscodeVersion` present.
- Gallery: `extensionsGallery.serviceUrl` "https://marketplace.cursorapi.com/_apis/public/gallery", `itemUrl` ".../items", `resourceUrlTemplate` "https://marketplace.cursorapi.com/{publisher}/{name}/{version}/{path}", `controlUrl` "https://api2.cursor.sh/extensions-control". Updates: `updateUrl` "https://api2.cursor.sh/updates", `backupUpdateUrl` "http://cursorapi.com/updates", `serverDownloadUrlTemplate` "https://cursor.blob.core.windows.net/remote-releases/${commit}/vscode-reh-${os}-${arch}.tar.gz", `releaseNotesUrl` "https://www.cursor.com/changelog", `reportIssueUrl` "https://github.com/getcursor/cursor/issues/new", `statsigLogEventProxyUrl` "https://api3.cursor.sh/tev1/v1".
- `trustedExtensionPublishers` includes "anysphere". `trustedExtensionProtocolHandlers`: `vscode.git`, `vscode.github-authentication`, `vscode.microsoft-authentication`, `anysphere.cursor-deeplink`, `anysphere.cursor-mcp`. `cursorTrustedExtensionAuthAccess`: `["anysphere.cursor-retrieval","anysphere.cursor-commits"]` (a the reference IDE-only key).
- `extensionEnabledApiProposals` grants the the reference IDE proposals (`cursor`, `cursorTracing`, ...) to `anysphere.remote-ssh`, `anysphere.remote-wsl`, `jeanp413.open-remote-ssh` (which also gets `cursor`), plus the stock VS Code list (GitHub PR extension gets `chatParticipantAdditions`, `chatSessionsProvider`, `remoteCodingAgents`, etc.).
- `extensionReplacementMapForImports`: `ms-vscode-remote.remote-ssh`→`anysphere.remote-ssh`, `remote-containers`→`anysphere.remote-containers`, `remote-wsl`→`anysphere.remote-wsl`, `jeanp413.open-remote-ssh/-wsl`→anysphere equivalents, `ms-python.vscode-pylance`→`anysphere.cursorpyright`, `ms-vscode.cpptools`→`anysphere.cpptools`, `ms-dotnettools.csharp`→`anysphere.csharp`. `remoteExtensionTips` point WSL/SSH/Dev Containers at the `anysphere.*` forks.
- `linkProtectionTrustedDomains` adds cursor.com/.sh/.so, review.cursor.com, app.graphite.com/.dev, github.com, and MCP OAuth hosts (mcp.notion.com, mcp.sentry.dev, mcp.atlassian.com, mcp.intercom.com, mcp.asana.com, mcp.linear.app, api.dashboard.plaid.com, mcp.squareup.com, app.datadoghq.com, mcp.figma.com, mcp.context7.com, mcp.prisma.io, playwright.dev, `http://go`).
- `aiConfig: {"ariaKey":"control-key"}`. `builtInExtensions` are only the three `ms-vscode.js-debug*`/profile-table entries.
- `removeLinesBeforeCompilingIfTheyContainTheseWords` names internal build flags (informative for feature names only): `__disable_composer_handle_debugging__`, `__disable_cursoreval__`, `__disable_ai_debugger__`, `__disable_shadow_workspace_debugging__`, `__disable_multi_file_applies__`, `__disable_embedding_model_switch__`, `__disable_cpp_control_token__`, `__disable_cpp_eval__`, `__disable_backend_selection_keyboard_shortcuts__`.

---

## 2. Shortcut table (decoded, calibrated)

### Decoding method and calibration

Keybindings are stored as integers: `KeyMod.CtrlCmd=2048`, `Shift=1024`, `Alt=512`, `WinCtrl=256`, low byte = `KeyCode` (VS Code enum: Enter=3, Escape=9, Tab=2, Backspace=1, Space=10, arrows 15-18, Digit0..9=21..30, KeyA..Z=31..56, F1..=59.., `;`=85 `=`=86 `,`=87 `-`=88 `.`=89 `/`=90 `` ` ``=91 `[`=92 `\`=93 `]`=94 `'`=95). Chords put the second key in bits 16+.

Because the reference IDE's minifier binds command ids to variables (`m1s="composer.startComposerPrompt"` @17160684) and uses them 14 MB later (`id:m1s,...keybinding:{primary:B3l,weight:1600}` @31106214, with `B3l=2087` @17164073), the extractor built a global assignment map and resolved `id:VAR` / `primary:VAR` / class-static `X.ID` patterns.

Calibration against stock VS Code registrations in the same file (all decoded correctly):
`workbench.action.toggleSidebarVisibility` 2080 → ⌘B; `workbench.action.togglePanel` 2088 → ⌘J; `workbench.action.toggleAuxiliaryBar` 2592 → ⌘⌥B; `workbench.action.gotoSymbol` 3117 → ⌘⇧O; `workbench.action.gotoLine` primary 2085 (Ctrl+G) with `mac:{primary:293}` → ⌃G; `workbench.action.reloadWindow` 3120 → ⌘⇧R; `workbench.action.splitEditor` 2141 → ⌘\; `workbench.action.reopenClosedEditor` 3122 → ⌘⇧T; `workbench.action.terminal.toggleTerminal` 2139 → ⌘`; `workbench.action.showCommands` secondary `[59]` → F1; `workbench.action.newBrowserTab` 2098 → ⌘T. `workbench.action.quickOpen`/`showCommands` primaries are referenced through unresolvable class statics (`Pvo.ID` 2094 = ⌘P, `Evp.ID` primary via a variable) so calibration used the commands above instead.

Glyphs: ⌘ = CtrlCmd (Ctrl on Windows/Linux unless a `win:`/`linux:` override is listed), ⌃ = WinCtrl, ⌥ = Alt, ⇧ = Shift. Weights (`w`) are the registration weights. `when` clauses are quoted from the minified source (`le.has(...)` = ContextKeyExpr.has).

### Chat / Agent

| Command id | mac keys | when / precondition | what it does (title string) |
|---|---|---|---|
| `composer.startComposerPrompt` | ⌘I (2087), secondary ⌘⇧I (3111), w1600 | none | title "Open Chat"; runs `composer.startComposerPrompt2` (opens/focuses the agent chat) |
| `aichat.newchataction` | ⌘L (2090), w500 | `!isGlass` | title "Open Chat"; also runs `composer.startComposerPrompt2`. `editor.action.addSymbolToChat` is mapped onto this id (`FOr` map) — this is the "Add to chat" path |
| `composer.newAgentChat` | ⌘⇧L (3114), secondary ⌘⇧I (3111), w1600 | none | "Open New Agent Chat"; in the Agents window runs `glass.newAgent`. `editor.action.addSymbolToNewChat` maps onto it |
| `aichat.newfollowupaction` | ⌘Y (2103; Windows Ctrl+Shift+Y 3127), w410 | none | "Focus Chat Followup" |
| `composer.createNewComposerTab` | ⌘T (2098) and ⌘N (2092), w600 | ⌘T: `composerFocused || focusedView =~ ^workbench.panel.aichat.view || activeEditor == workbench.editor.composer || agentsPaneFocused`; ⌘N: same `&& !editorTextFocus && !filesExplorerFocus && !explorerViewletFocus` | "New Chat Tab" (icon `add`) |
| `composer.closeComposerTab` | ⌘W (2101), w500 | `(composerFocused || focusedView =~ ^workbench.panel.aichat.view) && !editorTextFocus` | "Close Tab" |
| `composer.cancelComposerStep` | ⌘⇧⌫ (3073), w600 | `composerFocused || focusedView =~ ^workbench.panel.aichat.view` | "Cancel Chat": cancels the current step, else rejects all pending diffs (telemetry source `cmd_backspace`) |
| `composer.cancelComposerStepInputFocused` | ⌘⇧⌫ (3073); mac also ⌃C (289), w600 | composerFocused / chat view | "Cancel Chat (Input Focused)"; its label is what the "Stop ⌘⇧⌫" hint renders |
| `composer.acceptComposerStep` | ⌘⏎ (2051) and ⌘⌥⏎ (2563), w600 | composerFocused / chat view (`&& !jLi` for the first) | "Accept pending agent pane action" |
| `composer.approvePendingShellToolDecision` | ⏎ (3), w600 | `!isGlass && ...` | approve pending shell tool |
| `composer.approvePendingShellToolDecisionAllowlist` | ⇧⏎ (1027), w600 | `!isGlass && ...` | "Approve pending shell tool and allowlist" |
| `composer.skipPendingShellToolDecision` | Esc (9), w600 | `!isGlass && ...` | "Skip pending shell tool" |
| `composer.cancelTerminalToolCall` | ⇧⌫ (1025), w600 | composerFocused / chat view | "Cancel Terminal Tool Call" |
| `composer.triggerCreateWorktreeButton` | ⌘⇧⏎ (3075), w600 | `composerFocused` | "Create Worktree / Submit" |
| `composer.openModeMenu` | ⌘. (2137), secondary ⌘⌥. (2649) and ⇧Tab (1026), w600 | `(composerFocused || focusedView =~ ^workbench.panel.aichat.view || activeEditor == workbench.editor.composer || chatModeMenuFocused) && !editorTextFocus && !terminal.focusInAny` | "Open chat mode menu". Before opening it auto-switches to `plan` when `shouldSuggestPlanMode(text)` (once per composer, `planModeSuggestionUsed`; telemetry `composer.plan_mode.entry_point` entrypoint `keyboard_shortcut`) and to `debug` when `shouldSuggestDebugMode(text)`; no-op for `project` mode |
| `composer.toggleChatAsEditor` | ⌘D (2082), w600 | `composerFocused && !editorTextFocus` | "Toggle open as editor": cycles location `["pane","editor"]`; no-op when unified mode is `chat` |
| `composer.previousChatTab` / `composer.nextChatTab` | ⌘[ (2140) / ⌘] (2142), w200 | `composerFocused && !editorTextFocus` | previous / next chat tab |
| `composer.openModelToggle` | ⌘/ (2138), secondary ⌘⌥/ (2650), w200 | `composerFocused && !editorTextFocus` | "Open model toggle" (also toggles the background-composer follow-up model) |
| `composer.cycleModelParameter` | mac ⌘⇧/ (3162); win Ctrl+Alt+/ (2650) + Ctrl+Shift+/; linux Ctrl+Shift+/; w201 | `composerFocused && !editorTextFocus` | "Cycle model parameter" |
| `composer.openAddContextMenu` | ⌘⌥P (2606), w200 | `composerFocused && !editorTextFocus` | "Open add context menu" (the `@` picker) |
| `composer.selectPreviousComposer` / `composer.selectNextComposer` | ⌘⌥← (2575) / ⌘⌥→ (2577), w410 | `(composerFocused || agentsPaneFocused) && !editorTextFocus` | "Select Previous Chat" / "Select Next Chat" |
| `composer.selectPreviousSubComposerTab` / `composer.selectNextSubComposerTab` | ⌘⌥← / ⌘⌥→, w200 | `composerFocused` | sub-composer (subagent) tab navigation; `composer.selectSubComposerTab1`..`8`, `...TabLast` exist without keybindings found |
| `composer.find.focus` | ⌘F (2084), w200 | `composerFocused && ...` | "Find in Chat" |
| `composer.find.hide` / `.next` / `.previous` | Esc / F3 or ⏎ / ⇧F3 or ⇧⏎, w200 | `composerFindWidgetFocused` | find widget navigation |
| `composer.toggleVoiceDictation` | ⌘⇧Space (3082), w201 | `!isGlass && !terminalFocus` | "Toggle Voice Mode" (category the reference IDE) |
| `composer.cancelVoiceDictation` | Esc, w201 | `(activeEditor == workbench.editor.composer || (view == chat view && composerIsVisible)) && voiceInputRecording` | "Cancel Voice Mode" |
| `composer.fixerrormessage` | ⌘⇧D (3106), w1400 (editor action) | precondition `composer.isCursorOnLint && !composerFocused && !chatModeMenuFocused` | "Investigate Error in Chat" (fix linter error with AI) |
| `composer.sendToAgent` | ⌘L (2090), w600 | `editorHasPromptBar && editorPromptBarFocused` | "Turn Cmd+K to Composer" (moves the Cmd-K prompt into chat) |
| `composer.openBrowserTab` | ⌘⇧B (3104), w600 | `!isGlass` | "Open Browser" |
| `cursor.openBranchMenu` | ⌘' (2143), w600 | `composerFocused` | "Open Branch Menu" |
| `cursor.openAgentChangesEditor` | ⌘⇧R (3120), w500 | `composerFocused` | "Open Agent Changes" (icon `diff`) |
| `workbench.action.openAgentsView` | mac ⌃⇧S (1329); win/linux Ctrl+Shift+/ (3162); w200 | `!isInBackgroundComposerWindow` | "All Agents" (category View) |
| `workbench.action.quickOpenPreviousRecentlyUsedAgent` | ⌘Tab (2050) with `mac:{primary:258}` → ⌃Tab, w200 | `(agentsPaneFocused || composerFocused) && cursor.chatEditorGroup.enabled != true && !isInBackgroundComposerWindow` | quick-access MRU picker, prefix `"agents mru "` (placeholder "Switch between recently used agents") |
| `workbench.action.quickOpenLeastRecentlyUsedAgent` | ⌘⇧Tab (3074) with mac ⌃⇧Tab (1282), w200 | same | "Quick Open Least Recently Used Agent" |
| `workbench.action.quickOpenNavigateNextInAgentsPicker` / `...PreviousInAgentsPicker` | ⌃Tab / ⌃⇧Tab, w250 | `inAgentsMRUPicker` | cycle inside the picker |
| `cursor.canvas.openVisibleInlinePreview` | ⌘⏎ (2051), w601 | `canvasInlinePreviewActivePath` | "Open visible inline canvas preview" |

### Layout / windows

| Command id | mac keys | when | title |
|---|---|---|---|
| `workbench.action.toggleUnifiedSidebarFromKeyboard` | ⌘⌥U (2611), w600 | `!isAuxiliaryWindowFocusedContext` | "Toggle Agents Side Bar" (delegates to `workbench.action.toggleUnifiedSidebar`). A keybinding migration entry records the legacy binding 2609 (⌘⌥S) with original when `cursor.agentIdeUnification.enabled == true && !isAuxiliaryWindowFocusedContext`, introduced 2026-02-18, sunset after 30 days |
| `workbench.action.toggleAgentsFromKeyboard` | ⌘⌥J (2600), w600 | `!isAuxiliaryWindowFocusedContext && isGlass == false` | "Toggle Agents" (delegates to `workbench.action.toggleAgents`, which in Glass runs `glass.togglePanel`) |
| `workbench.action.maximizeChatSize` | ⌘⌥E (2595) | none | "Maximize Chat Size"; toggles `agentChatMaximized`; layout-control icon `maximize`/`minimize`, menu titles "Maximize Chat" / "Minimize Chat" |
| `workbench.action.openLayoutSwitcher` | ⌘⌥Tab (2562), w200 | none | "Switch Layout" (overlay `.layout-switcher-overlay`) |
| `cursor.toggleAgentWindowIDEUnification` | ⌘E (2083), w600 | `workbenchState != empty && isGlass == false` | "Swap Agent Sidebar Location" |
| `cursor.openOrFocusGlassWindow` | ⌘⌥N (2604), w200 | `!isGlass` | "Open or Focus Agents Window"; File-menu entries "New Agents Window" (when `cursor.hasOpenGlassWindow == false`) / "Switch to Agents Window" (when true), group `1_new` order 3.5 |
| `workbench.action.toggleAuxiliaryBar` | ⌘⌥B (2592) | `!isAuxiliaryWindowFocusedContext` | stock; surfaced in the chat view title menu as "Toggle Chat Pane" |
| `workbench.action.toggleSidebarVisibility` | ⌘B (2080) | `!isAuxiliaryWindowFocusedContext` | "Toggle Primary Side Bar Visibility" |

### Plan editor (`Markdown Plan Editor` category)

| Command id | mac keys | precondition | title |
|---|---|---|---|
| `planEditor.toggleMode` | ⌘⇧V (3124), w600 | `markdownPlanEditorActive || (editorLangId == markdown && resourcePath =~ /\.plan\.md$/i)` | "Toggle Editor Mode" (rich ↔ raw) |
| `planEditor.acceptPlan` | ⌘⏎ (2051), w600 | `markdownPlanEditorActive` | "Build Plan": dispatches DOM `CustomEvent("acceptPlan")` on the editor container; ignored when focus is inside `.plan-todo-edit-textarea` |
| `planEditor.actions.find` | ⌘F (2084), w600 | `markdownPlanEditorActive` | "Find" |
| `planEditor.findNext` / `planEditor.findPrevious` | F3 (61) sec ⌘G (2085) / ⇧F3 (1085) sec ⌘⇧G (3109), w600 | `markdownPlanEditorActive` | "Find Next" / "Find Previous" |
| `planEditor.closeFindWidget` | Esc, w600 | `markdownPlanEditorActive` | "Close Find Widget" |

### Cmd-K (inline edit) and inline diffs

| Command id | mac keys | when | title / effect |
|---|---|---|---|
| `aipopup.action.modal.generate` | ⌘K (2089) `args:{invocationType:"new"}`; ⌘⇧K (3113) `args:{invocationType:"toggle"}`; w1401 | ⌘K: `editorFocus || editcontextbarcursor`; ⌘⇧K: `editorFocus`; precondition `!ZVu` | opens the Cmd-K prompt bar |
| `editor.action.inlineDiffs.focusEditor` | ⌘K (2089), secondary ⌘⇧K, w1402 | `editorHasPromptBar && editorPromptBarFocused` | returns focus to the editor from the prompt bar |
| `aipopup.action.closePromptBar` | Esc, w2105 | `editorTextFocus`; precondition `editorHasPromptBar && editorPromptBarFocused` | "Close Prompt Bar" |
| `workbench.action.closeActiveEditorPromptBars` | Esc, w100 | `editorHasPromptBar && !editorPromptBarFocused && editorTextFocus` | close prompt bars |
| `cmdk.togglePromptBarModel` | ⌘/ (2138), secondary ⌘⌥/ (2650), w200 | `editorHasPromptBar && editorPromptBarFocused` | model toggle inside Cmd-K |
| `editor.action.inlineDiffs.acceptAll` | ⌘⏎ (2051), w500 | (inline diff context) | accept all inline diffs |
| `editor.action.inlineDiffs.acceptPartialEdit` | ⌘Y (2103; Windows Ctrl+Shift+Y), w500 | `editorTextFocus`; precondition `inlineDiffs.activeEditorWithDiffs` | "Accept Partial Edit" |
| `editor.action.inlineDiffs.rejectAll` | ⌘⇧⌫ (3073), w500 | | "Reject All Edits" |
| `editor.action.inlineDiffs.rejectAllAcrossAllEditors` | primary 2053 (⌘ + KeyCode 5, i.e. the Ctrl key itself — anomalous, reported as found), w500 | | reject across editors |
| `editor.action.inlineDiffs.rejectPartialEdit` | ⌘N (2092), w500 | | reject partial edit |
| `editor.action.inlineDiffs.cancelEdits` | ⌘⇧⌫ (3073), w600 | | cancel edits |
| `editor.action.inlineDiffs.nextChange` / `.previousChange` | ⌥J (552) / ⌥K (553), w100 | | "Go to Next Change" / previous change |
| `editor.action.inlineDiffs.nextDiffFile` / `.previousDiffFile` | ⌥L (554) / ⌥H (550), w1100 | | next / previous file in review |
| `cursorai.action.generateInTerminal` | ⌘K (2089), w10200 | `!isGlass && ...` (terminal focus) | "Generate in Terminal" (terminal Cmd-K) |
| `cursorai.action.hideGenerateInTerminal` | Esc, w10200 | same | hide prompt bar |
| `cursorai.action.cancelGenerateInTerminal` / `.rejectGenerateInTerminal` | ⌘⌫ (2049), w10200 / w10201 | same | cancel / reject |
| `cursorai.action.acceptGenerateInTerminal` / `.acceptAndRunGenerateInTerminal` | ⌘⏎ (2051), w10200 / w10201 | same | accept / accept and run |

### the reference IDE Tab

| Command id | mac keys | when | notes |
|---|---|---|---|
| `editor.action.inlineSuggest.commit` | Tab (2), w200/201 | `inInlineEditsPreviewEditor` etc. | accept suggestion |
| `editor.action.inlineSuggest.jump` | Tab (2), w201 | | jump to the predicted edit |
| `editor.action.inlineSuggest.acceptNextWord` | ⌘→ (2065), w101 | | partial accept; `cursor.cpp.enablePartialAccepts` says partial accepts use "the editor.action.inlineSuggest.acceptNextWord keybinding" |
| `editor.action.inlineSuggest.hide` | Esc | | dismiss |
| `editor.action.inlineSuggest.showNext` / `.showPrevious` | ⌥] (606) / ⌥[ (604) | | |
| `editor.action.acceptCppSuggestion` | (no numeric keybinding found in registration scan) | | command id exists |
| `editor.cpp.snooze`, `editor.cpp.unsnooze`, `editor.cpp.toggle`, `editor.cpp.disableenabled`, `editor.cpp.login`, `editor.cpp.openPro` | no keybinding | | palette commands (section 7) |

### Browser editor

`workbench.action.newBrowserTab` ⌘T (2098, w500), `workbench.action.reloadBrowserTab` ⌘R (2096, w600), `workbench.action.focusBrowserLocationBar` ⌘L (2090, w600) — all when `activeEditor == <browser editor id>` (the latter also `&& !ake && !hYe && !XAn`), category View, precondition `Hft`.

### Other

`aiSettings.usingOpenAIKey.toggle` ⌘⇧0 (3093, w401) "Toggle OpenAI key"; Focus AI Settings Search ⌘F when `isSettingsPaneFocused` (w401); `cursor.openVSCodeSettingsFromMenu` ⌘⇧, (3159) when `!isGlass`; `workbench.action.editorDictation.stop` Esc "Stop Dictation in Editor".

No keybinding registration was found for `composer.cycleMode`, `composer.cycleModel`, `composer.resetMode`, `composer.openAsPane`, `composer.openChatAsEditor`, `composer.openAsBar`, `composer.showComposerHistory`, `composer.renameChat`, `composer.duplicateChat`, `composer.exportChatAsMd`, `composer.shareChat`.

---

## 3. Modes and placeholders

### Built-in modes (`modes4` default array, @17967000; `composerModesService`)

Each entry: `{id, name, actionId, icon, description, thinkingLevel:"none", shouldAutoApplyIfNoEditTool, autoFix, autoRun, fullAutoRun?, enabledTools, enabledMcpServers}`.

| id | name (pill label) | actionId | icon | description (mode picker) | flags |
|---|---|---|---|---|---|
| `agent` | "Agent" | `composerMode.agent` | `infinity` | "Plan, search, make edits, run commands" | shouldAutoApplyIfNoEditTool, autoFix, autoRun |
| `triage` | "Triage" | `composerMode.triage` | `rocket` | "Coordinate long-horizon tasks with delegated subagents" | autoRun; enabledTools `[TASK_V2, APPLY_AGENT_DIFF]` |
| `plan` | "Plan" | `composerMode.plan` | `todos` | "Create detailed plans for accomplishing tasks" | none |
| `spec` | "Spec" | `composerMode.spec` | `checklist` | "Create structured plans with implementation steps" | none |
| `debug` | "Debug" | `composerMode.debug` | `bug` | "Systematically diagnose and fix bugs using runtime traces" | shouldAutoApplyIfNoEditTool |
| `multitask` | "Multitask" | `composerMode.multitask` | `circles` | "Run and coordinate multiple tasks in parallel" | shouldAutoApplyIfNoEditTool, autoRun |
| `chat` | "Ask" | `composerMode.chat` | `chat` | "Ask the reference IDE questions about your codebase" | autoFix |
| `project` | "Project" | `composerMode.project` | `folder` | "Special conversation mode for project-level discussions" | none |

`getModeDescription()` (@32835540) overrides: agent → "Plan, search, build anything", chat → "Ask the reference IDE questions about your codebase", edit → "Manually decide what gets added to the context (no tools)", plan → "Create detailed plans for accomplishing tasks", spec → "Create structured plans with implementation steps", multitask → "Run and coordinate multiple tasks in parallel", triage → "Coordinate long-horizon tasks with delegated subagents".

`PROTECTED_MODE_IDS = ["agent","chat","edit","background","plan","spec","debug","multitask","triage","project"]`. `edit` and `background` (cloud) modes exist in code paths but are not in the default `modes4` list. Mode switch is stored per composer as `unifiedMode` (`composerModesService.setComposerUnifiedMode(handle, id)`).

### Custom modes

`ACTION_ID_PREFIX = "composerMode."`; a custom mode gets `actionId = "composerMode." + name.toLowerCase().replace(/\s+/g,"_")` (suffixed `_2`, `_3`… on collision) and a registered F1 action titled `Open Chat in ${name} Mode` (precondition for `background`: `LW.INSTANCE`) that runs `composer.startComposerPrompt2` with the mode id. Setting a keybinding for a mode goes through `keybindingEditingService.addKeybindingRule/editKeybinding`; conflicts raise `[composerModesService] Keybinding "${kb}" already used by mode "${name}" (${id})`.

### Mode-switch shortcuts

`composer.openModeMenu` ⌘. (also ⌘⌥. and ⇧Tab) opens the mode menu (see section 2). Telemetry ids `composer.shift_tab_plan_render` and `composer.shift_tab_debug_render` confirm ⇧Tab is the render path for plan/debug suggestion. There is no per-mode default keybinding in the bundle (custom ones are user-added).

### Composer placeholders (`ure` memo @28858700)

Evaluated in this order:
1. "You're out of usage" (usage exhausted)
2. explicit `e.placeholder`
3. "Continue chatting in the reference IDE" (imported `claude-code` header)
4. next-prompt suggestion text (`cursor.composer.suggestNextPrompt`)
5. subagent/worktree specific: "Add more optional details"; debug mode: "Issue reproduced, please proceed" / "The issue has been fixed. Please clean up the instrumentation." (dynamic-config overridable) / "Enter additional context about the issue"
6. pending non-question tool calls → "Reject, suggest, follow up?"
7. worktree applied → "Continue locally"; worktree → "Ask follow-ups in the worktree"
8. follow-up state → "Add a follow-up"
9. `o()` (unresolved flag) → "Plan, Build, / for skills, @ for context"
10. by mode: `chat` → "Ask, learn, brainstorm"; `edit` → "Work on explicitly added files (no tools)"; `background` → "Build, research, debug at a longer horizon" (`CWv`); `agent`/default → "Plan, search, build anything".

Plan-specific placeholders (@31027445): when a plan exists and mode is `plan` → "Steer the plan, or add more details"; when `plan.isSpec === true` → "Spin up a new thread with this plan as context".

Other composer strings: "New Agent" (default chat title), "Untitled Chat", "New Chat", "New Project", "Draft" (agents picker subtitle), "Send", "Submit", "Add Context", "Add image", "Attach screenshot", "Dictate", "Voice". Human message fade overlay class: `composer-fade-overlay`.

---

## 4. Plan mode end-to-end

### Where plan files live

`PlanStorageService` (@21201150–21212000):
- User plans dir: `~/.cursor/plans` (`getUserPlansDir()` = `pathService.userHome()` + `.cursor/plans`). Workspace plans dir: `<firstWorkspaceFolder>/.cursor/plans` (`getWorkspacePlansDir()`).
- `writePlanFileWithFallback(name, content)`: create `~/.cursor/plans`, write there; on `NoPermissions` error only, fall back to `<workspace>/.cursor/plans` (log "Permission denied writing to user plans directory, falling back to workspace .cursor/plans"), else throw "Cannot write plan file: permission denied for user home directory and no workspace folder is available".
- One-time migration `migrateFromUserDataDir()` moves `*.plan.md` from `<userRoamingDataHome>/plans` to `~/.cursor/plans` (storage flag `composer.planMigrationToHomeDirCompleted`), replacing open editors.
- Registry persisted in storage keys `composer.planRegistry` (map id → `{id, name, uri, createdBy, editedBy[], referencedBy[], builtBy{}, lastUpdatedAt, createdAt}`) and `composer.planRedirects`.
- "Save to Workspace" (`movePlanToWorkspace(uri, workspaceFolderUri)`) moves a user-dir plan into `<workspace>/.cursor/plans`.
- Legacy `planFileUtils` (@18990300): writes to `<workspace>/.cursor/plans/<name>-<composerId8>.plan.md` with a header `<!-- composerId bubbleId -->`, and appends `plans/` to `<workspace>/.cursor/.gitignore` if missing. `jH(uri)` treats a file as a plan when scheme is `cursor-plan` or the path ends `.plan.md` and contains `/.cursor/plans/` (or is under the user plans dir).

### File naming

- `createPlanForComposer({name,...})`: `sanitizeFileName(name)` = lowercase, `[<>:"/\|?*]`→`_`, whitespace→`_`, collapse `_`, trim `_`, max 100 chars; file = `${sanitized}_${uuid.slice(0,8)}.plan.md`; a virtual URI `cursor-plan:` scheme is returned alongside.
- `computeUniqueFileName(name, id)` = `${sanitized}-${id.slice(0,8)}.plan.md`.
- Legacy `Nju(name, composerId)` = `${name.replace(/[^a-zA-Z0-9-_ ]/g,"").trim()}-${composerId.slice(0,8)}.plan.md`.
- `zEh(uri)` extracts the plan id with `/\/([^/]+)\.plan\.md$/`.

### File format

Serializer `y5e` (@21200870):
```
---
<js-yaml dump of {name, overview, todos:[{id, content, status, dependencies?}], isProject, phases?:[{name, todos:[...]}]} with {indent:2, lineWidth:-1, quotingType:'"', forceQuotes:false}>---

<body markdown>
```
Parser `_5e` uses `Jqs = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/`; missing fields default to `name:""`, `overview:""`, `todos:[]`, `isProject:false`, todo `status:"pending"`, `dependencies:[]`. A sanitizer (`g0f`) quotes unquoted `content|name|overview` values containing `: ` or ` #` and retries ("YAML frontmatter parsed after sanitization").

Legacy format migration (`MarkdownPlanEditorInput._migrateOldFormatIfNeeded` @22986393 and `C5i` @21199149): header comment `<!-- composerId [bubbleId] [n] -->` in the first 5 lines, title from first `# ` heading (default "Untitled Plan"), a `### To-dos` section parsed with `/^- \[([ x])\] (.+)$/` → `status: "x" ? "completed" : "pending"`; the section is stripped from the body and rewritten as frontmatter.

Todo status literals in the bundle: `"pending"`, `"in_progress"`, `"completed"`, `"cancelled"`. Plan build status enum `mce`: `PENDING="pending"`, `IN_PROGRESS="in_progress"`, `COMPLETE="complete"` (breadcrumb shows "Built ✓" at COMPLETE, "Building..." while `active`).

### The `.plan.md` editor

- URI scheme for virtual plans: `mt.cursorPlan = "cursor-plan"` (@378282). Body text model scheme `plan-body` (query = original URI).
- Editor pane id `markdownPlanEditor` (`jie.ID`), view-state key `markdownPlanEditorViewState`; editor input `MarkdownPlanEditorInput` typeId `workbench.input.markdownPlan`, `EditorID = "workbench.editor.markdownPlan"`; working-copy typeId `markdownPlan`; context keys `markdownPlanEditorActive` (per editor) plus a global one. Input is not serialized for `cursor-plan:` resources.
- Modes: `planEditorModeService` with `wce = {RICH:"rich", RAW:"raw"}`; `switchEditorMode(uri, mode)`; the toggle command is ⌘⇧V. The plain markdown editor has the parallel `markdownEditor.editMarkdown` "Edit Markdown" / "Toggle Editor Mode" (category "Markdown Editor", context `markdownEditorActive`).
- Auto-save scheduler on body change unless the plan is being streamed (`composerPlanService.isPlanBeingStreamed(uri)`); save goes through `composerPlanService.updatePlanFileContent(uri, content, composerId)` and fires telemetry `composer.plan_mode.plan_manually_edited`.
- File icon: any path ending `.plan.md` → icon `list-todo`, color `iconYellowPrimary` (amber) — this is the "plan icon breadcrumb" in the screenshot.
- Language detection: `hWg(uri)` = scheme `cursor-plan` or `.plan.md` suffix; precondition for the mode toggle also accepts `editorLangId == markdown && path =~ /\.plan\.md$/i`.

### Breadcrumb toolbar (`o8h` @35669000; container `.breadcrumbs-extra-actions.plan-breadcrumb-controls`, attribute `data-plan-breadcrumb-controls="true"`, mounted into `.breadcrumbs-row` by `planBreadcrumbManager`)

Left to right:
1. Model picker (`xv_`) with hover "Model used to build this plan" (the "Sonnet 4.5 ⌄" in the screenshot; model names come from the server model list, not the bundle).
2. Build split button (`Nv_`, class `breadcrumbs-action-btn`, tone `plan` = amber): main label "Build" (or "Building..." when status `active`), right part shows the ⌘⏎ hint (`Tne("⏎")`) and a chevron; dropdown `plan-build-dropdown-menu` / `plan-build-dropdown-breadcrumb` (anchor top-right, width 220) with items: "Build Locally" (`agent`), "Build in Cloud" (`background`, shown when cloud build is available; icon `cloud`), "Build in Parallel" (tooltip "Parallelize Build with Multitask Mode."; shown when `showParallelBuild`, i.e. the plan was not created by a background agent). When build status is COMPLETE the button is replaced by `<span class="plan-breadcrumb-built-indicator">Built<span class="codicon codicon-check-two">`.
3. Ellipsis "More options" menu (`Sie`, anchor top-left): section "Editor Mode" → "Preview" (`rich`, check when active) / "Markdown" (`raw`); then, unless the file is already inside the workspace `.cursor/plans` or is streaming: divider + "Save to Workspace".

The "Preview ⌄" control in the screenshot corresponds to this Editor Mode section (rich = "Preview", raw = "Markdown"); no "Source" label exists in the bundle.

### What "Build" does

Handler `T(mode)` in `o8h` (@35670300):
1. `unifiedMode = mode ?? "agent"` (`"background"` for cloud, `"multitask"` for parallel).
2. Resolve the composer: the plan's `createdBy` composer if loaded, else the selected composer, else load by id.
3. If a composer exists: for `multitask` first run `GEh` (@30180445) which sets `unifiedMode = "multitask"` and submits the literal user text `"Build"` via `submitChatMaybeAbortCurrent(composerId, "Build", {ignoreQueuing:true, isPlanExecution:true, simulatedMsgReason: BUILD_IN_PARALLEL})`; then `composerPlanService.acceptPlan(handle, uri, mostRecentPlanBubbleId, "manual", {unifiedMode})` and `composerViewsService.showAndFocus(composerId, {focusMainInputBox:true})`. So Build continues in the **same chat**, switching that chat's mode from `plan` to the chosen build mode.
4. If no composer: `composerPlanService.acceptPlanByUri(uri, {unifiedMode})`.
5. The keybinding path: `planEditor.acceptPlan` (⌘⏎) → `CustomEvent("acceptPlan")` on the editor container → window event `markdownPlanEditor:acceptPlan` → `I("agent")`.

The resulting human bubble is a plan-execution message: `planExecution.executionLabel` = "Build Plan in Parallel" when `simulatedMsgReason === BUILD_IN_PARALLEL`, otherwise "Build"; the simulated-message action label for BUILD_IN_PARALLEL is `{action:"Build", icon:"circles"}` (@18890987). The row shows a Stop button while generating or a "Restore Checkpoint" button (class `restore-button`) afterwards, and a `plan-execution-title`.

"Build in New Agent" (`plan-todos-section__phase-action--build`) is a separate button on phase sections of project plans that starts a **new** agent for that phase. Telemetry: `composer.plan_mode.plan_created`, `composer.plan_mode.plan_accepted`, `composer.plan_mode.switch_to_plan.accept/reject`, `composer.plan_mode.entry_point`.

### The plan card in chat (`AgentTranscriptPlanCard` @15005200)

Props `{title, detail:"ide"|"glass", overview, onOpen, buildControls}`. Rendered as an expandable card (`iSi`, not collapsible, header variant `default` in glass / `flat` in IDE):
- Header: secondary label "Created Plan" + primary title (`data-testid="composer-plan-filename"`, size lg, weight medium, truncated) and a `chevron-right` icon when clickable (glass).
- Body (IDE): overview rendered as small markdown; then an actions row with a text button "View Plan" (`onOpen`) and the `buildControls` node (the "Sonnet 4.5 ⌄ · Build ⌘⏎ ⌄" footer in the screenshot is the same model picker + build split button component with `tone:"plan"`, `kbs` = ⌘⏎, dropdown items "Build Locally"/"Build in Cloud"/"Build in Parallel").
- In notifications / human-review rows the plan action is `{kind:"view-plan", label:"View Plan", variant:"primary", tone:"plan"}` with description color `yellow` when a `create_plan` tool call exists (@30314920).

To-dos rendering: the sticky todo summary (`todo-summary-sticky-container`, `data-composer-human-todo-summary`) shows `${total} To-dos`, `${completed} of ${total} To-dos Completed`, or `${inProgress.content}, ${completed+1} of ${totalActive}`; the list (`todo-summary-list`) draws per item an SVG circle indicator (`Pnb`: `<circle r=5.5 stroke=currentColor>`, in-progress uses `--cursor-text-primary`, others opacity 0.4) and content with classes `todo-summary-item-content`, `todo-in-progress`, `todo-completed`; the overflow row uses a `+` indicator (`todo-summary-more-indicator`) followed by `${remaining} more` (@29109453). Expanded max height 500/700 px, chevron `todo-summary-chevron`. Plan-editor to-dos use classes `ui-plan__todos-*`, `plan-todos-section__phase-action--add` ("New") and `--build`, and the inline edit textarea `plan-todo-edit-textarea`.

### Steering

- Placeholder "Steer the plan, or add more details" while in `plan` mode with a plan attached.
- Editing an earlier human message in plan mode (`startEditing(bubbleId, isPlanMode)`) forces the composer back to `unifiedMode: "plan"`.
- `composer.openModeMenu` may auto-enter plan mode from prompt text (`shouldSuggestPlanMode`).
- Human message context menu / click actions: `select`, `expand`, `revert-after-checkout` (restore to checkpoint), `edit`.

---

## 5. Layouts and panes

### Chat surfaces and ids

- View container `workbench.panel.aichat.view` (`_x`; regex `^workbench.panel.aichat.view` is the "chat view focused" test), view `workbench.panel.composerChatViewPane`, editor input `workbench.editor.composer` (chat opened as an editor tab), auxiliary bar part `workbench.parts.auxiliarybar` (the "pane"), unified sidebar part `workbench.parts.unifiedsidebar` (the Agents side bar).
- Composer locations (`agentLayoutService.getComposerLocation(id)`): `"pane"` and `"editor"` (the ⌘D toggle cycles `["pane","editor"]`). Commands: `composer.openAsPane` (title "Open Agent as Pane", icon `layoutSidebarRight`), `composer.openChatAsEditor` ("Open as Editor"), `composer.openAsBar` (id only), `composer.toggleChatAsEditor` (⌘D), `composer.openComposer`, `composer.focusComposer` ("Focus Agent"), `composer.splitEditorWithNewComposer`, `composer.duplicateChat`, `composer.renameChat` ("Rename Chat"), `composer.closeOtherComposerTabs`, `composer.closeOtherComposers`, `composer.clearComposerTabs`, `composer.showComposerHistory` ("Show Chat History"), `composer.showComposerHistoryEditor` ("Show Chat History (Editor)"), `composer.showBackgroundAgentHistory`, `composer.showViewMenu`, `composer.exportChatAsMd`, `composer.shareChat`, `composer.forkSharedChat`, `workbench.action.chat.open` (creates a composer with `openInNewTab:true` and optional query text).
- Composer overflow menu (@28346913): "Show History" (`composer.showComposerHistory`), separator, "Open as Editor", "Open as Pane", separator, "Reset Position" ("Reset Composer Position"), separator, "Open Composer Settings" (`aiSettings.action.open` with `"chat","cursor-settings-chat-composer"`).
- Chat tab context menu (@30837858): "Open in New Tab" (tooltip "Open chat in a new tab"; `agentLayoutService.openComposer({type:"local", id, openInNewTab:true, targetGroup})`), "Keep All" ("Keep all pending changes"), "Undo All" ("Undo all pending changes"), "Mark as Read" ("Mark chat as read") / unread, delete etc.
- Chat view title menu (@31128332): "Toggle Chat Pane" (`workbench.action.toggleAuxiliaryBar`, group `0_a_visibility`), "Maximize Chat" (`workbench.action.maximizeChatSize`, toggled by `agentChatMaximized`).
- Settings UI entries (General): "Open Chat as Editor Tabs" — "Show chats as editor tabs inside the chat area instead of the legacy stacked view" (context key `cursor.chatEditorGroup.enabled`), "Review Control Location", "Auto-Hide Editor When Empty" (`autoHideEditorWhenEmpty`), "Status Bar", "Window Restoration" ("Controls which windows the reference IDE restores on startup"; aliases "open agents window on startup"), "Tips" ("Show rotating tips on the empty screen", surface glass).

### Unified app layout (agent-IDE unification)

Context keys (`unifiedAppLayoutContextKeys.js` @19813800): `cursor.agentIdeUnification.enabled` (always `true`, "Compatibility context key for legacy user keybindings…"), `cursor.chatEditorGroup.enabled` ("Whether chat editor group mode is enabled"), `cursor.defaultSidebarLocation` (default `"right"`), `cursor.agentIdeUnification.sidebarLocation` (`"right"`/`"left"`), `cursor.agentIdeUnification.unifiedSidebarVisible`, `cursor.agentIdeUnification.agentsSurfaceVisible` ("Whether any agents surface is visible"), `cursor.noTitlebarLayout.enabled` ("Whether the no-titlebar layout is currently active (title bar hidden)"; class `no-titlebar-layout`), `cursor.onboarding.showing`, `agentChatMaximized`, `agentsPaneFocused`, `composerFocused`, `composerIsVisible`, `chatModeMenuFocused`, `isGlass`, `isInBackgroundComposerWindow`, `cursor.hasOpenGlassWindow`, `cursor.hasOtherMainWindow`.

Storage keys: `cursor/unifiedAppLayout`, `cursor/globalLayoutState`, `workbench.unifiedSidebar.hidden`, `workbench.unifiedSidebar.size`, `cursor/agentLayout.quickMenu.lastSelectedLayoutId`, `cursor/agentLayout.quickMenu.customLayouts`. Dev commands `cursor.dumpLayoutStorageData` / `cursor.applyLayoutStorageData`.

Default layouts (`yVi` @27556600; state = `{agentsVisible, chatVisible, editorsVisible, panelVisible, sidebarVisible, sidebarLocation, panelMaximized, partWidths}`):

| id | name | state |
|---|---|---|
| `default-agent` | "Layout • Left" | agents ✓, chat ✓, editors ✓, panel ✗, sidebar ✗, sidebarLocation `left` |
| `default-editor` | "Layout • Right" | agents ✗, chat ✓, editors ✓, panel ✗, sidebar ✓, sidebarLocation `right` |
| `default-zen` | "Layout • Zen" | agents ✗, chat ✗, editors ✓, panel ✗, sidebar ✗, `left` |
| `default-browser` | "Browser" | agents ✗, chat ✓, editors ✓, panel ✗, sidebar ✗, `left` |

Fallback preferred layout id is `default-editor`. Custom layouts are stored under `cursor/agentLayout.quickMenu.customLayouts`. Switcher UI: `workbench.action.openLayoutSwitcher` (⌘⌥Tab) renders `.layout-switcher-overlay` with `__backdrop`, `__container`, `__tile` (`is-selected`), `__icon-wrapper`, `__label`, `__separator`, and `layout-preview-icon__*` thumbnails. Related commands: `workbench.action.openAgentLayoutQuickMenu`, `workbench.action.openLayoutSettingsMenu` ("Open Layout Settings Menu"), `workbench.action.customizeLayout`, `workbench.action.toggleEditorVisibility` ("Toggle Editor Area Visibility"; when hiding editors it ensures chat is visible via `ensureChatVisibleOrCreate`), `workbench.action.maximizeEditorHideSidebar`, `workbench.action.minimizeOtherEditorsHideSidebar`, `workbench.action.evenEditorWidthsExcludingAgent`, `workbench.action.toggleInlineDiffs` ("Toggle visibility of inline diffs in the editor"), `workbench.action.toggleUnifiedSidebar` ("Toggle Agents Side Bar"), `workbench.action.toggleAgents` ("Toggle Agents"; when nothing is visible it restores the remembered aux-bar/unified-sidebar state or creates a pane composer `createComposer({view:"pane", unifiedMode:"agent", openInNewTab:true, skipClose:true})`), `cursor.toggleAgentWindowIDEUnification` ("Swap Agent Sidebar Location"), `workbench.action.toggleSidebarPosition`, `workbench.action.closeSidebar`. Layout-control (title bar) toggles: "Toggle Primary Side Bar", "Toggle Agents Side Bar", "Maximize Chat Size"/"Minimize Chat".

`.agent-layout` is the root class of the agent layout; the multi-diff review uses `.agent-layout-multi-diff-container.agent-layout`, `.review-pr-action-bar(-left|-right)`, `.agent-layout-multi-diff-content-area`, `.agent-layout-multi-diff-ellipsis-button`, `.agent-layout-multi-diff-badge` ("Latest"), and inline-diff widgets tint removed lines `rgba(191, 97, 106, 0.1)` when inside `.agent-layout`.

### Agents window (Glass)

Constants (`glassModeConstants.js` @21548230): `jTn = "Agents Window"`, `"New Chat"`, `"New Agent"`, feature gates `glass_automations_ui`, `custom_agents_enabled`, `glass.enable_open_agent_in_window`, storage `cursor.glass.enrolled`, `cursor.glassAutomationsUiAvailable`, `cursor.glassEnableOpenAgentInWindow`. Commands: `cursor.openGlassModeWindow`, `cursor.openAdditionalGlassModeWindowDev`, `cursor.switchToGlassWindow`, `cursor.openOrFocusGlassWindow` (⌘⌥N), `cursor.openGlassAndSwitchModelSlug`, `cursor.openGlassAndChangeToMultitask`, `cursor.openGlassAndStartCloudAgent` ("Open Agents Window and Start Cloud Agent"), `cursor.glassCloseWindow/Maximize/Minimize/Unmaximize`, `glass.newAgent`, `glass.togglePanel`, `glass.handleDeeplink`, `glass.applyIdeWorkspaceHandoff`. Menu titles: "New Agents Window", "Switch to Agents Window", "Close Agents window", "Maximize/Minimize Agents window". Promo banner: "Meet the new Agents Window" — "Run many agents in parallel — across repos, locally, on remote SSH, and in the cloud." / "Jump back to the Agents Window to keep working across repos."; button "Switch to Agents Window" or "Try it now". Glass navigation items (`NSo` @29073697): `back` ("Back", `arrow-left`), `new-agent` ("New Agent", icon `agent`, editorPanelType `full`), `new-project` ("New Project", `cube`), `new-cloud-meta-agent` ("New Agent"), `search` ("Search", `magnifying-glass`), `automations` ("Automations", `robot`), `marketplace` ("Marketplace", placeholder "the reference IDE Marketplace"). Glass settings: `cursor.glassWorkspaceLspMaxLocalWorkspaces` / `...RemoteWorkspaces` ("Maximum number of local/remote Agent Window workspaces that can run language servers.").

### Agents view / pickers

`workbench.action.openAgentsView` "All Agents"; quick-access providers: prefix `"agents mru "` (MRU picker; placeholder "Switch between recently used agents"; no results "No recent agents"; entries labeled by name, branch name, or bcId; foreground vs background agents open via `agentLayoutService.openComposer({type:"local"|"background", id})`) and a second provider with placeholder "Search chats and cloud agents" / help "Search chat history". Chat history uses `composer.showComposerHistory` ("Show Chat History") and the editor variant. Read/unread state: "Mark as Read". Pinned/starred threads: no strings found (section 10).

---

## 6. Context picker (`@`) kinds

Mention item type enum `Er` (@2838000): `none, doc, code, file, folder, git_commit="commits", git_pr="pr", git_diff="diffs", git, heading, staticheading, divider, link, current_file, toggle_commit_options, commit_notes, image, composer, reset, summarize, bugbot, files_and_folders, more, terminal, terminal_selection, review_changes, playwright_mcp, open_browser, ui_element="ui-element", cursor_command, pr_diff, projects, current_pr, browser, mcp_attachment="mcp-attachment", agent_store`.

Section labels `w5`: `code:"Code"`, `doc:"Docs"`, `file:"Files"`, `folder:"Folders"`, `git:"Commits"`, `commit_notes:"Commit History"`, `composer:"Past Chats"`, `reset:"Reset"`, `summarize:"Summarize"`, `bugbot:"Agent Review"`, `open_browser:"Open Browser"`, `files_and_folders:"Files & Folders"`, `terminal:"Terminals"`, `playwright_mcp:"Browser"`, `projects:"Projects"`. Default ordered kinds `Wkc = ["code","doc","file","folder","files_and_folders","git","composer","reset","summarize","terminal","playwright_mcp","projects"]`; slash-style kinds `Hkc = ["reset","summarize","bugbot","open_browser"]`.

Mention menu modes and titles (`V0h` @29928344): `all` → "Mentions", `files_and_folders` → "Files & Folders", `docs` → "Docs", `terminals` → "Terminals", `past_chats` → "Past Chats", `canvases` → "Canvas", `branch_diff_main` → "Branch (Diff with Main)", `browser` → "Browser". Anchored-tray browse categories: `{id:"files-and-folders", label:"Files & Folders", iconName:"folder"}`, `{id:"past-chats", label:"Past Chats", iconName:"chat-bubbles"}`; tray ids `anchored-tray-browse-past-chats`, `anchored-tray-browse-canvases`, `anchored-tray-back`. Empty-state ids `mention-menu-empty-top`, `mention-menu-empty-categories`; aria-label "Mentions"; "No results found"; sections collapse with "Show N more"; an "Add Skills" item (icon `add`) is appended.

Capability flags for the main composer picker (@28508172): `supportsGit`, `supportsLink`, `supportsDocs` (gated by `disable_docs_client_usage`), `supportsCursorRules`, `supportsCursorCommands`, `supportsSkills`, `supportsSubagents`, `supportsNotepads`, `supportsComposers` (past chats), `supportsFilesAndFolders`, `supportsFiles:false`, `supportsTerminal`, `supportsReviewChanges`, `supportsWorkflows`, `supportsProjects`. Glass section ordering: `["Skills","Commands","Modes","Subagents","Models","Projects","Open","Actions","Mentions","Other"]`; IDE slash-menu type labels `{skill:"Skills", command:"Commands", mode:"Modes", subagent:"Subagents", action:"Actions", mention:"Mentions", heading/divider:"Other"}`. Cmd-K context scope adds `cmdKDefinitions` (`zkc = {"cmd-k":["cmdKDefinitions"], generic:[], "terminal-cmd-k":[]}`), i.e. "Definitions" are offered in Cmd-K. Mention-chip actions include `openCursorRuleFile` (resolves `.cursor/rules/<filename>`), `openBrowserTab`, `openDoc`, `openCanvas`. Rules mention payload field `cursorRuleFilename`; commands `cursorCommand`; terminals `terminalFile`/`terminalSelection`; browser `browserSelection`/`consoleLog`; `agentStore`.

Labels **not** found as mention kinds in this build: "Linter errors", "Recent changes", "Notepads" (only the `supportsNotepads` flag and a developer export command "Export Notepads to Files" remain), "Web" as a mention header (the string "Web" exists but not bound to a mention section), "Definitions" (only via `cmdKDefinitions`).

---

## 7. Cmd-K and the reference IDE Tab

### Editor Cmd-K (prompt bar)

- Open: `aipopup.action.modal.generate` ⌘K (new) / ⌘⇧K (toggle). Close: Esc (`aipopup.action.closePromptBar` "Close Prompt Bar"). Focus editor: ⌘K again (`editor.action.inlineDiffs.focusEditor`). Next bar: `aipopup.action.nextPromptBar` ("Next Prompt Bar"). Focus edit: `aipopup.action.focusEdit`. Remove follow-up: `aipopup.action.cmdKRemoveFollowup`. Insert selection: `aipopup.action.insertEditSelection` ("Insert Edit Selection"). Model toggle: `cmdk.togglePromptBarModel` ⌘/. Conflict resolution: `cmdK.resolveConflictInCmdK` ("Resolve Conflict in Cmd+K"), `composer.resolveAllConflictsInChat`. Clear: `cmdK.clearPromptBar`. Submit fix: `editor.action.inlineDiffs.submitFix`. Feedback: `cursorai.action.reportGoodCmdK` / `reportBadCmdK`. Developer: `workbench.action.openLastCmdKPrompt` "Developer: Open Last Command K Prompt in Dashboard".
- Submit modes (`pGd` @25318581): `edit_selection` "Edit Selection" shortcut ⏎; `quick_question` "Quick Question" shortcut ⌥⏎ (Alt+⏎ on non-mac); `send_to_chat` "Send to Chat" shortcut ⌘L (Ctrl+L). Holding ⌥ switches the mode to `quick_question` live (`NAe` handler @25741093); `send_to_chat` executes `composer.sendToAgent`. Placeholders `Tnv`: `edit_selection` → "Edit selected code", `quick_question` → "Ask quick question", `send_to_chat` → "Send to chat"; follow-up placeholder "Add a follow-up". Retry text "Attempting fix (n/max)...". Debug panel label "Context shown to model". Telemetry `editor.cmdk.submit` with `chatMode`, `composer.turn_cmd_k_to_composer`. Setting `cursor.cmdk.useThemedDiffBackground2` ("Use themed background colors for inline diffs"). Auto-link parsing pref `shouldAutoParseCmdKLinks`; input source id `editor.cmdk`.
- Inline diff acceptance: see the Cmd-K keybinding table (⌘⏎ accept all, ⌘⇧⌫ reject all, ⌘Y / ⌘N partial accept/reject, ⌥J/⌥K change nav, ⌥L/⌥H file nav). Setting `cursor.inlineDiff.enablePerformanceProtection`.

### Terminal Cmd-K

`cursorai.action.generateInTerminal` ⌘K opens a prompt bar in the terminal (input source `terminal.cmdk`; placeholder "Command instructions", or "Add a follow-up" after a response; `supportsGit:false`, `supportsLink:false`, `showDocs:false`; ⌥⏎/`altKey` submit → chat mode). Accept ⌘⏎ (`acceptGenerateInTerminal`), accept-and-run ⌘⏎ (`acceptAndRunGenerateInTerminal`, higher weight), reject/cancel ⌘⌫, hide Esc. Settings: `cursor.terminal.usePreviewBox` ("Use preview box for terminal cmd-k. If turned off, responses are streamed directly into the shell."), `cursor.terminal.enableAiChecks` ("AI-based Terminal Completion Detection."). Stock `workbench.action.terminal.chat.*` ids also remain.

### "Add to chat" / quick question

- ⌘L with an editor selection → `aichat.newchataction` (mapped from `editor.action.addSymbolToChat`); ⌘⇧L → `composer.newAgentChat` ("Open New Agent Chat"; mapped from `editor.action.addSymbolToNewChat`). Related: `composer.addfilestocomposer`, `composer.addfilestonnewcomposer`, `composer.addsymbolstocomposer`, `composer.addsymbolstonewcomposer`, `workbench.action.problems.addToChat`, `workbench.action.problems.fixInChat`, `composer.fixerrormessage` (⌘⇧D "Investigate Error in Chat"), context menu title "Fix in Agent", `editor.action.knowledgeBase.add` "Add User Rule", `cursor.createRuleFromSelection`.
- "Quick question" exists only as the Cmd-K submit mode (⌥⏎), not as a standalone command.

### the reference IDE Tab (`cpp`)

- Configuration group id `cpp`, title "the reference IDE Tab": `cursor.cpp.disabledLanguages` (array, default `["markdown","plaintext"]`, "Disable the reference IDE Tab for these languages"), `cursor.cpp.enablePartialAccepts` (boolean, default false).
- Context keys: `cppEnabled` ("Whether the reference IDE Tab is currently enabled"), `cppSnoozed` ("Whether the reference IDE Tab is currently snoozed"), `tabPredictionGoToFileVisibleKey`, `tabPredictionCodePreviewVisibleKey`.
- Commands (all F1, no keybindings): `editor.cpp.snooze` "Snooze the reference IDE Tab" (precondition `!cppSnoozed && cppEnabled`; quick pick placeholder "Select the reference IDE Tab snooze duration", items "1 minute", "5 minutes", "15 minutes", "30 minutes", "1 hour", "3 hours" with description `Snooze for ${label}`; note the "3 hours" item's duration constant is `lop*4`), `editor.cpp.unsnooze` "Unsnooze the reference IDE Tab" (precondition `cppSnoozed`), `editor.cpp.toggle`, `editor.cpp.disableenabled` "Disable the reference IDE Tab", an "Enable the reference IDE Tab" action, `editor.cpp.login`, `editor.cpp.openPro`, "Developer: Report the reference IDE Tab Action".
- Persistent storage: `cppEnabled`, `cppSnoozed` (timestamp), `cppSnoozeDuration` (default 300 000 ms), `cppEnabledBeforeSnooze`; `snoozeCpp(ms)` sets `cppEnabled=false` and a timeout that calls `unsnoozeCpp()`.
- Telemetry ids: `cursor.acceptcppsuggestion`, `cursor.acceptcppsuggestionpartial`, `cursor.rejectcppsuggestion`, `cursor.revertcppsuggestion`, `cursor.peekcppsuggestion`, `cursor.suggestcpp`, `cursor.fullcppsuggestion`; metric `cppclient.reload`.
- Accept path: `editor.action.inlineSuggest.commit` (Tab), jump `editor.action.inlineSuggest.jump` (Tab), partial `editor.action.inlineSuggest.acceptNextWord` (⌘→), hide Esc; `editor.action.acceptCppSuggestion` command id present.

---

## 8. Checkpoints and multi-file review

### Checkpoints

`ComposerCheckpointService` methods: `createCurrentCheckpoint`, `checkoutToCheckpoint(handle, bubbleId)`, `checkoutToLatest(handle)` (requires `latestCheckpointId`), `createCheckoutCallback`, `createCheckoutCallbackWithInlineDiffs`, `validateCheckpointContent`, `getFilesToRevertForCheckpoint`, `getUrisForCheckpoints`; log "Completed reverting to message …/checkpoint". Each human bubble may carry `checkpointId`.

UI (@29119814, @29125726, @29127185):
- Human-message action slot (`human-message-action-slot`): while generating a Stop button labeled `Stop ${keybindingLabel}` (label of `composer.cancelComposerStepInputFocused`); otherwise a "Restore Checkpoint" icon button (aria-label/tooltip "Restore Checkpoint", classes `restore-button`, `data-reverting` while running) calling `revertToCheckpoint(bubbleId)`. `showRestoreButton = checkpointId !== undefined && !isCheckedOutToThisBubble && !isGeneratingAndLast`.
- After a restore: "Redo checkpoint" button (icon `redoTwo`, hint "Restore edits to the latest checkpoint") calling `checkoutToLatest`.
- Plan-execution rows use the same slot (`plan-execution-action-slot`, `stop-button`/`restore-button`).
- Click action `revert-after-checkout` on a human message also reverts; `showCheckedOutChip` marks the checked-out bubble. Telemetry `composer.checkout_to_message`.

### Multi-file review

- Editor: scheme `cursor.reviewchanges` (`mt.reviewChanges`), editor label "Review Changes", pane "Review Changes Editor"; opened via `reviewChangesService.openOrUpdateReviewChangesEditor(composerId, {fromBackgroundAgent?})` (toolbar button "Review Changes", telemetry `review_changes.opened` entrypoint `composer_toolbar_button`); Agent Changes editor `cursor.openAgentChangesEditor` (⌘⇧R) / `cursor.closeAgentChangesEditor`. View modes `_g`: `All="all"`, `Pending="pending"`, `DiffWithMain="diffWithMain"`, `PR="pr"`; diff view "Unified View" / "Split View" (`reviewChangesService.setDiffViewMode`), "Expand All"; blame tabs "All Changes" / "Chats".
- Composer footer labels (@28991719): "Keep All" / "Undo All" for multiple files; for a single pending decision the per-tool labels from `j5t`: `EDIT_FILE` → accept "Keep", reject "Undo"; `RUN_TERMINAL_COMMAND_V2` → "Run"/"Stop" ("Waiting for approval"); `WEB_SEARCH` → "Continue"/"Cancel"; `SWITCH_MODE` → "Switch"/"Skip"; `CONNECT_SCM` → "Connect GitHub"/"Skip"; `BACKGROUND_COMPOSER_FOLLOWUP` → "Send to background composer"/"Skip". Hints: "Accept all changes", "Undo all pending changes across all files", "Undo all applied changes across all files", "Keep all pending changes and save files"; worktree variants "Apply" ("Apply changes to the main working directory"), "Undo Apply"; DiffWithMain "Fix All". Undo requires confirmation: first click shows "Confirm" with hint "Click again to confirm undo".
- Breadcrumb review controls (`BreadcrumbReviewControls.js` @23306534): "Keep File", "Keep all changes", "Review Next File" / "Review next file" (hint = `nextDiffFile` ⌥L), previous-file chevron (⌥H), change counter `.breadcrumbs-change-counter`, buttons `.breadcrumbs-action-btn`.
- Inline overlay (@23312459): "Keep"/"Keep All" (primary, keybinding hint ⌘⏎) and "Undo"/"Undo All" (outline, ⌘⇧⌫).
- Programmatic: `inlineDiffService.acceptDiff(id)` / `rejectDiff(id)`, `composerService.applyWorktreeToCurrentBranch`, "Undo All" service path logs `[Composer] Undo All: …`. Telemetry ids `composer.accept_all`, `composer.reject_all`, `composer.accept_diff`, `composer.accept_diff_file`, `composer.accept_reject_diff_details`, `composer.review_cta_click`, `composer.toggled_changed_files_drawer`.
- Auto-review: `cursor.enableAutoReviewOnCommit`, Agent Review (Bugbot) strings "Review changes against {branch} branch for issues.", "No issues found", "Learn more about Agent Review", docs link `https://cursor.com/docs/agent/review#agent-review`, commands `cursor.runEditorBugbot`, `cursor.reviewBugbotFromAd`, `cursor.openBugbotPane`, built-in skill `review-bugbot` (`review-bugbot/SKILL.md`).

---

## 9. Settings keys (`cursor.*` / `composer.*`)

Registered through `Registry.as(Configuration).registerConfiguration` (@38327500–38335300 and others). Only these are VS Code settings; most other the reference IDE preferences live in `reactiveStorageService.applicationUserPersistentStorage` (see below).

| Key | type | default | description |
|---|---|---|---|
| `cursor.cpp.disabledLanguages` | array | `["markdown","plaintext"]` | "Disable the reference IDE Tab for these languages" |
| `cursor.cpp.enablePartialAccepts` | boolean | false | "Enable partial accepts for the reference IDE Tab, using the editor.action.inlineSuggest.acceptNextWord keybinding" |
| `cursor.terminal.usePreviewBox` | boolean | false (`xni`) | "Use preview box for terminal cmd-k. If turned off, responses are streamed directly into the shell." |
| `cursor.terminal.enableAiChecks` | boolean | true | "AI-based Terminal Completion Detection. " |
| `cursor.cmdk.useThemedDiffBackground2` | boolean | true (`fsn`) | "Use themed background colors for inline diffs" |
| `cursor.inlineDiff.enablePerformanceProtection` | boolean | true (`vsn`) | "Enable performance protection for inline diffs. When enabled, inline diff decorations will be suppressed if there are too many changes to prevent editor unresponsiveness." |
| `cursor.general.disableHttp2` | boolean | false | "Disable HTTP/2 for all requests, and use HTTP/1.1 instead. …" |
| `cursor.general.disableHttp1SSE` | boolean | false | "Disable HTTP/1.1 SSE for agent chat. …" |
| `cursor.general.gitGraphIndexing` | string enum `enabled|disabled|default` | `default` | "Index your git history to help the reference IDE understand which files are related to each other. …" |
| `cursor.general.globalCursorIgnoreList` | array | `[]` | "Global list of files to always ignore in the reference IDE features, across all workspaces. Uses glob patterns. …" |
| `cursor.general.pinnedTitleActions` | array | `[]` | "List of action IDs to always show in the editor title bar. …" |
| `cursor.general.reduceTransparency` | boolean | false | "When enabled, translucent surfaces and vibrancy effects are replaced with opaque backgrounds for improved readability." |
| `cursor.general.fontSmoothingAntialiased_v2` | boolean | true | "When enabled, uses grayscale antialiasing for thinner, crisper text that matches native macOS rendering." |
| `cursor.general.glassShowWarningNotifications` | boolean | false | "Show notifications for less urgent issues. Errors and informational notifications are always shown." |
| `cursor.general.emailPrivacyEnabled` | boolean | false | (nls) |
| `cursor.general.enableShadowWorkspace`, `cursor.general.leakDetectionEnabled` | — | — | ids present; registration block not captured |
| `cursor.preferNotificationsSameAsChat` | boolean | false | "Show notification toasts in the same location as the chat" |
| `cursor.debug.timeoutPrevention` | string enum `local_only|always|never` | `local_only` | (nls) |
| `cursor.windowSwitcher.sidebarHoverCollapsed` | boolean | false | "Enable hover-expanded state for the Cloud Agents sidebar. …" |
| `cursor.worktreeCleanupIntervalHours` | number (scope 2) | 6 | "Interval in hours for periodic worktree cleanup. Default is 6 hours." |
| `cursor.worktreeMaxCount` | number (scope 2) | 25 | "Maximum number of the reference IDE-managed worktrees to keep across all workspaces. …" |
| `cursor.worktreesGlobalMaxSizeGb` | number (scope 2) | 50 | "Maximum total size in GB for the the reference IDE worktrees directory across all workspaces. Set to 0 to disable this limit." |
| `cursor.glassWorkspaceLspMaxLocalWorkspaces` / `...RemoteWorkspaces` | number (scope 1) | `lsn` | "Maximum number of local/remote Agent Window workspaces that can run language servers." |
| `cursor.composer.cmdPFilePicker2` | boolean | false | "Enable Cmd+P / Ctrl+P shortcut for file picker in Composer" |
| `cursor.composer.shouldShowMarkdownHoverParticipantActions2` | boolean | false | "Show markdown hover participant actions" |
| `cursor.composer.shouldAutoSaveNonAgent` | boolean | true | "Automatically save files in normal composers" |
| `cursor.composer.shouldChimeAfterChatFinishes` | boolean | false | "Play a sound when a chat response is completed" |
| `cursor.composer.customChimeSoundPath` | string | "" | "Path to a custom sound file (mp3, wav, ogg) to play when Agent finishes responding. Leave empty to use the default sound." |
| `cursor.composer.codeBlockWordWrap` | boolean | false | "Wrap long lines in Agent chat code blocks." |
| `cursor.composer.subagentModel` | string | "" | "Model to use for subagent tasks" |
| `cursor.composer.queueMessageDefaultBehavior` | string enum | `c5_` | "Adjust the default behavior of sending a message while Agent is streaming" |
| `cursor.composer.queueManualSendBehavior2` | string enum | `u5_` | "Choose the default behavior of messages sent manually from the queue while Agent is streaming" |
| `cursor.composer.textSizeScale` | number enum `[0.85,1,1.15,1.3]` (labels "Small","Default","Large","Extra Large") | 1 | "Controls the text size scale (relative to base 12px) of AI chat messages." |
| `cursor.composer.planTextSizeScale` | string enum `default,0.85,1,1.15,1.3` (labels "Match Agent chat","Small","Default","Large","Extra Large") | `default` | "Text size scale for the markdown plan editor. `default` matches Agent chat text size (`cursor.composer.textSizeScale`). Other values fix the scale (0.85–1.3)." |
| `cursor.composer.conversationDensity` | string enum `compact-all-grouped,compact-ungrouped,detailed` (labels "Compact","Balanced","Detailed") | `compact-all-grouped` | "Controls how shell and edit-file tool calls are displayed and grouped in Glass Agent conversations." |
| `cursor.composer.editorConversationDensity` | same enum | `detailed` | "…in Editor Agent conversations." (other density ids present: `compact-shells`, `compact-grouped`) |
| `cursor.chatMaxWidth` | number | 840 | "Controls the maximum width in pixels of chat content." |
| `cursor.composer.usageSummaryDisplay` | `auto|always|never` | `auto` | "When to display the usage summary at the bottom of the chat pane: automatically when approaching limits, always, or never." |
| `cursor.composer.suggestNextPrompt` | boolean | false | "Suggest a follow-up after each turn; Tab to insert" |
| `cursor.composer.showEmptyStateTips` | boolean | true | "Show rotating tips on the empty screen." |
| `cursor.semanticSearch.includeCommitsWithFiles` | boolean | false | "Include commits with files results" |
| `cursor.blame.hoverDelay` | number 0–10000 | undefined | "Controls the delay in milliseconds before hovers in the the reference IDE Blame panes appear. If not set, uses `#editor.hover.delay#` with a minimum of 500ms." |
| `cursor.localTraceMode` | boolean | false | "Local Trace Mode" — "When enabled, records performance marks and measures locally … and mirrors VS Code RPCs into the DevTools Network tab." |
| `cursor.rpcFileLogger.enabled` / `.folder` | boolean / string | false / "" | "Enable logging of extension host RPC messages to JSON files viewable in Perfetto. Requires restart." / "Optional folder for RPC trace files. Defaults to logs/exthost." |
| `cursorAuth.signInEnforcement`, `cursorAuth.allowedTeamId`, `cursorAuth.allowedTeamIds`, `cursorAuth.allowedOrganizationIds`, `cursorAuth.allowedLoginEmails`, `cursorAuth.allowedLoginDomains` | boolean / strings (MDM policies `SignInEnforcement`, `AllowedTeamId`, …, minimumVersion "1.99") | false / "" | e.g. "Specify the required team id that a user must belong to in order to use the reference IDE. …" |
| `cursor-retrieval.canAttemptGithubLogin`, `ndjson.port`, `ndjson.bindAddress` | (from extensions, section 1) | | |

No `composer.*` VS Code setting is registered; every `composer.*` literal (623 distinct `cursor.*`/`composer.*` strings) is a command id, storage key, or telemetry event. Reactive-storage preferences visible in the defaults object `dN` (@17965000) include `alwaysKeepComposerInBound`, `autoApplyFilesOutsideContext`, `yoloCommandAllowlist/Denylist`, `smartAllowlistDenylist`, `yoloMcpToolsDisabled`, `yoloDeleteFileDisabled`, `yoloOutsideWorkspaceDisabled`, `yoloEnableRunEverything`, `enableSmartAuto`, `isWebSearchToolEnabled*`, `autoAcceptWebSearchTool`, `isWebFetchToolEnabled`, `webFetchDomainAllowlist`, `autoApproveModeTransitions`, `mcpAuthBlocking`, `backgroundComposerEnv`, `useLegacyTerminalTool`, `modes4`, `codeBlockDisplayPreference:"collapsed"`, `thinkingLevel`, plus `cppEnabled`, `cppSnoozed`, `cppSnoozeDuration`, `mcpServers`, `shouldAutoParseCmdKLinks`, `bestOfNCountPreference`, `dismissedGlassSettingsBanner`, `dismissedClaudeCodeImportCta`.

### Rules, skills, hooks, MCP, browser (paths and ids)

- Rules: project rules `.cursor/rules/*.mdc` (frontmatter `description`, `globs`, `alwaysApply`; nested `<subdir>/.cursor/rules/` supported), legacy `.cursorrules`, `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md` recognized as rule files. Rule type labels: "Always Applied" (`always`), "Agent Decides When to Apply" (`agent`), "Apply to Specific Files & Folders" (`glob`); also "Apply Manually", "Apply Intelligently". Scopes `all|user|project|team`. Commands: `cursor.createRuleFromSelection` (notification "Created manual rule '{name}' in .cursor/rules. Attach it explicitly when you want it applied." + "Open Rule"), `cursor.openCreatedRule`, `cursor.rules.convertLegacyAgentAppliedRules` (converts `**/.cursor/rules/**/*.mdc` agent-applied rules to `.md`), `editor.action.knowledgeBase.add` "Add User Rule", `editor.action.knowledgeBase.list` "View User Rules"; user-rule input title "New User Rule", placeholder "Style request, response language, tone...", prompt "User Rules apply to all of your chats"; settings section "Rules, Skills, Subagents"; "Create with Agent" button; context summary labels "the reference IDE & User Rules", project-rules, team-rules. No "Rules for AI" string exists in this build.
- Skills: `SKILL.md` under `.cursor/skills/`, `.cursor/skills-cursor/`, `.cursor/cloud-skills/*.md`, user skills; built-in skill ids include `review-bugbot`, `review-security`, `review`, `onboard` ("Get started with the reference IDE."), `loop`, `migrate-to-skills` ("Move the reference IDE rules and commands into Agent Skills."), `migrate-to-builds` ("Prepare a Cloud Agent environment for prebuilt builds."), `cursor-review-links` ("Open a pull request in the reference IDE."), `rename-chat`. Commands `cursor.skillStore.*` (copy/move/migrate skills to a store), `cursor.publishSkill.*`, `cursor.unpublishSkill.*`, `cursor.resyncSkill.*`, `cursor.skill.publishMenu`, storage `cursor.skills.recentlyUsed`, `cursor.subagents.recentlyUsed`. Slash commands: `.cursor/commands/` (`workbench.action.newUserCursorCommand`, `workbench.action.newProjectCursorCommand`). Subagents: `.cursor/agents` (`workbench.action.customize.openSubagents`). Placeholder hint "/ for skills, @ for context".
- Hooks (`CursorHooksService` @33535000): user `~/.cursor/hooks.json`, project `<folder>/.cursor/hooks.json`, enterprise `/Library/Application Support/the reference IDE/hooks.json` (macOS) / `C:\ProgramData\the reference IDE\hooks.json` (Windows) / `/etc/cursor/hooks.json` (Linux), plus Claude-compatible `~/.claude/settings.json`, `<folder>/.claude/settings.json`, `.claude/settings.local.json`. Commands `cursor.hooks.initializeUserHooks`; telemetry `composer.sessionEndHooks`, `composer.submitChat.beforeSubmitPromptHookMs`.
- MCP (`MCPService` @21407000): user `~/.cursor/mcp.json` (created as `{"mcpServers":{}}` on open), project `<folder>/.cursor/mcp.json`; also dashboard/team-managed, plugin-provided (`enable_cc_plugin_import`), and VS Code `.vscode/mcp.json` paths; OAuth cancel/auth flows; `cursor-mcp` extension handles `onUri` deep links; approved servers key `cursor/approvedProjectMcpServers`; mention kind `mcp-attachment`; storage `cursor.plugins.installedIds`.
- Browser: `cursor-browser-automation` extension (MCP server); workbench commands `cursor.browserView.*` (newTab, newHeadlessTab, navigate, reload, goBack/goForward, takeScreenshot, executeJavaScript, getConsoleLogs, getNetworkRequests, sendCDPCommand, setLocked, setRecordingType, configureDialogHandling, …), `cursor.browserAutomation.*`, `cursor.browserOriginAllowlist.*`; editor commands `workbench.action.openBrowserEditor`, `newBrowserTab` ⌘T, `reloadBrowserTab` ⌘R, `focusBrowserLocationBar` ⌘L; `composer.openBrowserTab` ⌘⇧B; context key `cursor.browserTabEnabled`; layout `default-browser`; element selection and screenshot flows call `composer.focusComposer`; mention kinds `browser`, `playwright_mcp` ("Browser"), `open_browser` ("Open Browser"), `ui-element`; storage `browserUrlPopupDismissed`; telemetry `composer.browserTabsTelemetry`.
- Worktrees: `.cursor/worktrees/` (`.cursor/worktrees.json`), settings above, commands `composer.openTerminalInWorktree`, `composer.openNewWindowInWorktree`, `composer.copyWorktreePath`, `composer.triggerCreateWorktreeButton` (⌘⇧⏎ "Create Worktree / Submit"), placeholders "Continue locally" / "Ask follow-ups in the worktree"; `.cursor/projects/<id>/{terminals,agent-transcripts,agent-tools}` transcript folders; `.cursor/environment.json` and `.cursor/permissions.json` schemas (cursor-always-local); `.cursor/debug.log` (ndjson ingest).

---

## 10. Open questions (not determinable from the bundle)

1. **Plan file display name.** The screenshot shows `custom-fields-implementation.plan.md`; the current serializer always appends `_<8 hex>` (`createPlanForComposer`) or `-<8 hex>` (`computeUniqueFileName`). Either the tab label strips the suffix (no such code found) or the screenshot predates this naming; the bundle does not settle it.
2. **"··· 4 more" glyph.** The todo overflow row renders a `+` indicator and the text `${n} more`; no "···"/"⋯" literal exists. The exact glyph in the screenshot could be a CSS/icon rendering not captured as a string.
3. **Which condition (`o()`) selects the placeholder "Plan, Build, / for skills, @ for context"** — the flag is a minified signal whose origin was not traced.
4. **Model names** ("Sonnet 4.5") and the model picker's entries come from the server model list, not the bundle.
5. **Top-level `@` menu order and the full set of headers** in the IDE (non-glass) picker beyond the enumerated kinds; "Web", "Link", "Git", "Rules", "Skills", "Subagents", "Commands", "Workflows", "Projects", "Canvas" strings exist but their exact grouping in the popup is built at runtime.
6. **Pinned / starred / archived thread strings** — none found for local chats ("Archive" exists only for background/cloud agents: `workbench.action.backgroundComposer.archive`).
7. **`editor.action.inlineDiffs.rejectAllAcrossAllEditors` primary 2053** decodes to ⌘ + KeyCode 5 (the Ctrl key), which is not a real chord; treat as unbound in practice.
8. **`editor.action.acceptCppSuggestion` keybinding** — no numeric `primary` found; Tab acceptance is observed only via `editor.action.inlineSuggest.commit` / `.jump`.
9. **`composer.openAsBar`** — id exists, no title, keybinding, or menu entry found.
10. **Custom mode icon set** — icon names (`infinity`, `rocket`, `todos`, `checklist`, `bug`, `circles`, `chat`, `folder`) are the reference IDE icon-font names (`fontFamily:"cursor"`, `--cursor-icon-content`); their glyph shapes are in the icon font, not recoverable as text.
11. **Windows/Linux `when` differences** were not separately audited beyond explicit `win:`/`linux:` overrides listed in section 2.
12. **`cursor.general.enableShadowWorkspace` / `cursor.general.leakDetectionEnabled` descriptions** — ids exist, their configuration blocks were not captured by the extractor.
