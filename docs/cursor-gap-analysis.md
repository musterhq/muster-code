# Cursor 3.18.25 vs Muster Code — deep gap analysis (2026-09-06)

Ground truth for Cursor is the installed app bundle (`/Applications/Cursor.app`, 40 MB workbench + 49 MB glass bundle), mined string by string; ground truth for Muster Code is commit `e1b204e`. Scores are honest: 1 = missing, 3 = present but rough, 5 = at Cursor's level.

## 0. The GitHub repo (github.com/cursor/cursor)

- `main` holds a README and SECURITY.md only: it is Cursor's public **issue tracker**, not source.
- `openAIVerify`, `patchContinue`, `smallFixes`, `pricing`, `pricingBrowser`, `closeErrorsOnDeepLink` all stop on **27–30 March 2023**. They are the original open-source prototype (Electron Forge + React + CodeMirror, ~165 files, the user's own OpenAI API key; `openAIVerify` = "Checks that the openAI api key provided is valid").
- Cursor today is a closed-source VS Code fork. Its source is not public anywhere; the only way to replicate it is what we have been doing: mining the shipped bundle (`docs/cursor-feature-atlas.md`) and matching behaviour.

## 1. Verdict

| Area | Cursor | Muster Code | Score |
|---|---|---|---|
| Core loop (prompt → agent → streamed edits → review) | native | works end to end on real Codex turns | 4 |
| Stability under failure (network, provider errors, restarts) | retries, Resume / Try again / Reload cards, persisted drafts and state | timeouts fail silently after 180 s, no retry, drafts lost on reload | **2** |
| Composer and pickers | React, Lexical editor, side preview, hover popovers | webview textarea + backdrop, Cursor-shaped menus | 3 |
| Messages, tool cards, thinking | grouped tool rows, "Thought for Ns", shimmer, queued messages, needs-attention states | flat rows, "Thought", running dot | **2** |
| Inline diff, review, checkpoints | | verified; token boxes, hunk widgets, multi-file, checkpoints with thread revert | 4 |
| Plan mode | | plan card, .plan.md editor, Build | 4 |
| Context kinds | files, code, docs (crawled index), git, PRs, terminals, past chats, rules, browser, images, MCP resources, projects | all but crawled docs, MCP resources, projects; no semantic codebase index | 3 |
| Browser / visual editor | | at parity or beyond in agent tools; no network panel, annotations | 4 |
| Settings, rules, MCP, skills, hooks, modes | dedicated React pages, indexing, memories, beta flags | one webview page from cached catalog | 3 |
| Cursor Tab | Cursor's own model, sub-100 ms, next-edit prediction everywhere | prompt to Codex per pause, seconds of latency, opt-in | **1.5** |
| Agents at scale (subagents, background/cloud agents, worktrees, Agents window) | first-class | none rendered | **1** |
| Onboarding, accounts, usage, notifications | sign-in flow, usage %, chime, dock badge | Codex login in a terminal, usage chip only | 2 |
| Editor extras (selection hover widget, commit messages, Explain/Fix on hover) | present | none | 1 |
| Automated verification | `workbench.anysphere-ui-automations.js` harness | dev socket harness + script checks, no UI assertions | 2 |

Biggest gaps, in order of user impact: **failure handling**, **message/tool rendering polish**, **Cursor Tab**, **selection hover widget + editor extras**, **agents at scale**.

## 2. Stability

**What Cursor does (mined)**
- Transport retries with server/transport error accounting; after repeated failures an error card "Connection failed — The connection failed N times. Please check your network connection and try again" with **Resume** / **Try again** / **Reload Window** buttons (`extraButtons` on the last human bubble). Edited-message resubmits are tracked (`pendingResubmit`) so two edits cannot race.
- Usage limits are first-class: "Included usage: N%", "You will now be charged for usage on this model", spend limits, on-demand pricing dialogs.
- Composer state lives in the workbench storage (`composerData`), so drafts, tabs, pending decisions and scroll positions survive reloads and crashes; `hasBlockingPendingActions` marks composers that need the user.
- Agent tabs carry attention states (`needsAttention`, "Needs Attention" grouping), completion chime (`playChimeSound`), dock badge (`setBadgeCount`).
- A UI automation harness ships in the bundle (`workbench.anysphere-ui-automations.js`).

**Where Muster Code stands**
- A turn that goes silent fails after 180 s with an error line; no Resume / Try again; no reconnect when the app-server dies; interrupted turns cannot be resumed (Codex has no resume, but the turn could be re-sent with the same context).
- Draft text, queued messages and in-flight approvals are lost on window reload; messages of tabs without a thread yet are memory-only. Threads with history reload fine.
- Errors surface as plain text bubbles or VS Code notifications; usage limits only as the status chip percentage.
- Two structural risks: the workbench patch resolves minified service names by regex (`Be`, `Si`, `Xt`, …) and breaks on any base upgrade; webview code lives in a template literal where a lone backslash silently changes a regex (caught only by `scripts/dev/pane-check.py`).
- Verified with real turns: plan/build, inline diff, steer, stop, edit-and-resend, full-access painting, shell-edit adoption, approvals plumbing. Not yet: Debug/Triage/Multitask/Spec/Ask behaviours, ⌘K, terminal ⌘K, checkpoint redo, Claude turns, Muster Tab, browser tools from Codex's exec runtime.

**Fixes in order**: (1) turn error card with Try again / Resume (re-send with the same thread) and Reload; reconnect the warm process on death; (2) persist composer draft, queue and pending approvals per tab in workspace state; (3) usage-limit card from `account/rateLimits` and app-server error codes; (4) needs-attention state on tabs + chime + badge; (5) UI assertions in the harness (probe rows, cards, chips already exist — add expected-state checks per flow); (6) base-upgrade guard: the patch script must fail loudly and a smoke test must run after every assemble.

## 3. UI / UX

**Composer** (Cursor: Lexical editor with mention nodes, pills row, image thumbnails 32 px, drag-and-drop and paste of images, `@` side preview of the hovered file, pill hover popover Open ⏎ / Remove ⌫ / Collapse Esc, "Add to Side Chat", branch menu ⌘', voice mode ⌘⇧Space with recording state).
Ours: textarea with backdrop pills and a chips row, menus rebuilt on Cursor's structure, dictation through a command. Missing: image paste and drop into the composer, pill hover popover, side preview, real inline mention nodes (backdrop pills cannot carry icons), find in chat ⌘F.

**Messages** (Cursor: tool rows with Cursor's own verb per tool from `tool-action-labels` — Searching files / Searched files, Grepping / Grepped, Reading / Read, Listing / Listed, Editing / Edited, Reading lints, Exploring tools, Searching web, Writing plan, Working on task, Asking questions, Looking up blame, Fetching, Switching mode; consecutive rows collapse into groups; "Thought for 12s" with a shimmer while thinking; queued messages shown under the last bubble; per-file edit cards with expandable diff; citations; the welcome bubble "Hi there! Welcome to Cursor…" on first run).
Ours: one row per tool call titled Ran / Called / Searched (Codex only reports command, MCP, web search and file change items, so read/list/grep show as commands), "Thought" without duration, no grouping, no shimmer. Missing: thought timer, grouping of consecutive tool rows, Codex's `readLints`-style summaries (derive from commands), first-run welcome, "Generating…" shimmer on the assistant bubble.

**Tabs and history** (Cursor: chat tab context menu with Fork this chat / Open in New Tab / rename / pin; history grouped Today / Yesterday / This week / Older; agents MRU picker ⌃Tab; chat-as-editor ⌘D; layout switcher ⌘⌥Tab; Agents view).
Ours: tabs with close, history with search, pin, rename, archive, export. Missing: fork, open-as-editor, date grouping, MRU picker, context menu.

**Pickers** (Cursor: model picker with "Auto", Max Mode confirmation, thinking level per model, favorites, search; mode menu with descriptions and shortcuts).
Ours: model menu from `model/list` with per-provider efforts, mode menu with descriptions. Missing: Auto, Max-mode style confirmation for expensive efforts, search in the picker.

**Editor** (Cursor: hover widget over a selection with "Add to Chat ⌘L" and Edit ⌘K; `Investigate Error in Chat` on lint hover; commit message generation in SCM; inline "Explain").
Ours: ⌘L and ⌘⇧D shortcuts only; no hover widget, no SCM sparkle, no Explain.

**Settings** (Cursor: General, Chat, Tab, Models, Rules, Memories, Indexing & Docs, MCP with Needs Attention / Connected groups, Beta, Network; each a React page).
Ours: one webview with General, Models, Modes, Rules, MCP, Skills, Plugins, Hooks, Docs from the cached catalog. Missing: Memories, Indexing & Docs (crawling), Beta/feature flags, Network, usage and billing detail.

**Feel**: Cursor animates state changes (shimmer, fades, collapsible groups), uses its own icon font, and every menu is keyboard- and screen-reader-complete (`data-component="menu-row"`, aria attributes). Ours uses codicons, has no transitions beyond the caret, and menus are divs without ARIA roles.

## 4. Functionality matrix

| Capability | Cursor | Muster Code | Gap |
|---|---|---|---|
| Agent tools rendering | 30+ tool kinds with verbs | command / MCP / web search / file change / plan | render read/list/grep from command text; ask-question cards |
| Subagents | task tool, sub-composer tabs, agent status/transcript tools | Codex 0.152 runs multi-agent (`<multi_agent_role>`), nothing rendered | render child threads as sub-tabs |
| Background / cloud agents, worktrees | native (890 references), `.cursor/worktrees` | none | V2 |
| Agents window (Glass) | separate window | none | V2 |
| Codebase index (semantic search) | embeddings per workspace, `Semantic search` tool | none (Codex uses ripgrep) | optional: local embeddings; Codex's grep is usually enough |
| Docs | crawled and indexed, "Add new doc" | single-page fetch cached | crawl a site to depth 2 |
| Memories | "Remember This", memories settings | none | store per-workspace notes into rules automatically |
| Bugbot / Agent Review | "Review changes against <branch> for issues" live status in SCM | review-on-commit prompt, /review command | SCM view integration |
| Cursor Tab | own model, partial accept, next edit, snooze | Codex prompt per pause (seconds) | needs a small fast model; not achievable with Codex turns |
| Voice | built-in | command (`hear`) | acceptable |
| Images | paste/drop, thumbnails, vision | attach button, `@image:` | paste/drop |
| Commit messages | SCM sparkle | none | one command |
| MCP | servers, resources, prompts, OAuth, elicitation | servers, elicitation cards, login via CLI | resources/prompts |
| Hooks | executed by Cursor | executed by Codex (inherited), listed in settings | fine |
| Rules | 4 kinds, nested dirs | 4 kinds | nested `<dir>/.cursor/rules` |
| Browser | tabs, tools, pick, screenshots, annotations, network | tabs, tools, pick, screenshots, DevTools, bookmarks, cert, headless | annotations, network panel |
| Remote / SSH, settings sync, teams | yes | no (Code-OSS base; Open VSX only) | out of scope |
| Privacy mode, no telemetry | opt-in | always local, telemetry off | ahead |

## 5. What to do next, in order

1. **Failure handling** (2): error card with Try again / Resume / Reload, warm-process reconnect, usage-limit card, persisted drafts and queue.
2. **Message polish** (3): thought timer with shimmer, grouped tool rows with Cursor's verbs, "Generating…" state, welcome bubble, edit cards with expandable diff already exist — add file icons and line counts inline.
3. **Editor extras**: selection hover widget (Add to Chat ⌘L / Edit ⌘K), Explain on hover, commit message generation, `Investigate Error` on lint hover.
4. **Composer**: image paste/drop with thumbnails, pill hover popover, side preview, ⌘F find.
5. **Tabs/history**: fork, open-as-editor, date grouping, MRU picker, context menu; needs-attention + chime + badge.
6. **Subagents**: render Codex child threads as sub-composer tabs with status.
7. **Settings**: Memories (rules written from chat), Docs crawl, Beta flags, usage/billing.
8. **Cursor Tab**: only worth pursuing with a fast local or hosted small model; the Codex path stays opt-in.
9. V2: background agents, worktrees, Agents window, SCM Bugbot.

Every item above has its Cursor reference in `docs/cursor-feature-atlas.md` or in this file's mined strings.
