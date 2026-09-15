# Muster quality and design review · 12 September 2026

The product already has a substantial runtime and editor integration. The highest-impact problems were state ownership, misleading review language, and missing visibility into context and usage. This change adds a distinct Muster conversation surface and regression coverage around the existing realtime diff pipeline. It does not establish that every existing feature is production-ready.

## What is implemented across the two repositories

| Repository | Existing implementation inspected | Role in this change |
|---|---|---|
| `muster` | Codex app-server lifecycle, warm sessions, interruption, persisted-thread resumption, event/request forwarding, token usage, reasoning-economy rules; CLI chat/board/live-diff modules; gateway and browser surface packages | Preserve the transport. Carry reported reasoning-output tokens through its result, with a regression assertion. |
| `muster-code` | Code-OSS distribution, built-in agent pane, models/access discovery, context picker, browser and MCP bridge, plans, checkpoints, streamed inline diffs, multi-file review, settings and themes | Persistence, readability, activity/usage display, preview-before-approval, browser error handling, appearance controls, icons and renderer regression tests. |

The CLI, gateway dashboards, and external capability packs were not redesigned or certified by this pass. The desktop's integrated terminal still uses the existing terminal engine and shell behavior. A product icon theme changes its glyphs, not how commands execute.

## Changes in this pass

- Per-chat drafts and retained context survive tab changes and webview recreation. Open chat metadata and drafts are saved in workspace state. Provider history remains the source for resumed conversation text.
- Explicitly attached context remains on a removable shelf after send. References are refreshed each turn; duplicate mentions within a prompt expand once, including images. The former silent stop after twelve context blocks is removed. Existing file/link excerpts still have size/line limits.
- Browser selections become content-addressed snapshots in `.muster/browser/context-*.json`. Later selections or navigation do not overwrite earlier attached selections. Missing snapshots are reported to the model rather than silently replaced.
- Long messages have a keyboard-operable Show full message / Show less button. Full text is retained. Tool, reasoning, diff and plan expansion state is restored; a manually collapsed streaming diff stays collapsed.
- Answer markdown is rendered once per animation frame. Reading earlier content disables following the live tail; Jump to latest restores it.
- Events and follow-ups are routed to their owning chat. Shared-workspace file-edit turns queue behind the active edit owner because the current checkpoint controller is shared. Worktree-isolated parallel editing remains a future gate. Inline edits are prevented from colliding with an active chat edit.
- Activity details show selected model/effort, event-derived phase, elapsed running time, reported input/cached-input/output/reasoning-output tokens, and a clearly marked estimate of the expanded text prompt. Missing counts are unavailable, not zero. These are not converted to dollars or subscription allowance.
- Full Access keeps applied changes and their live diff visible. Dismiss review clears review state; Undo changes reverses edits. Genuine provider approvals remain approvals. Proposed patch content supplied by `item/started` is displayed before deciding its approval. Permission requests now use their documented response shape.
- Browser navigation uses the actual load promise, surfaces failed loads, catches rejected navigation, normalizes local development URLs, and prevents an older navigation promise from replacing newer state. Selections and visual edits from another page are cleared on navigation.
- The default palette now uses neutral graphite surfaces. Five color themes are available: Muster Graphite, Muster Dark, Midnight, Light and Sand. Style opens Appearance settings with density, text size, accent, product icons, file icons and advanced native customization. The existing diff color roles are preserved in every palette.
- Bundled, licensed Lucide glyphs replace the broken webview font path. The Muster Icons product theme covers core native navigation, terminals, agent, source-control and common action icons. Third-party extension artwork and file icons remain independently selectable.
- The default request for provider reasoning summaries is `auto`, with concise/detailed/none available in `muster.codex.reasoningSummary`. Model and effort are unchanged. A shorter summary is not a claim of lower internal reasoning usage.

## Realtime/full-file diff contract

No edits were made to `live-edit.ts`, `apply-patch.ts`, `line-diff.ts` or `unified-diff.ts`. The workbench renderer changes only the review wording and records whether approval widgets are needed. The chat renderer is now in `agent-view.ts`; moving it out of the host is a separation for testing, not removal of the feature.

Regression tests execute the actual workbench renderer with Monaco service doubles. They cover 500-line full-file decoration ranges, every removed line, both views of the same file, no mutation of an unrelated editor, streamed unfinished-hunk controls, zone reuse, Full Access preserving diff colors, switching back to review mode, file/index-specific decisions, deletion-only diffs and cleanup. Parser tests cover 250-to-310-line replacement streamed in 1-, 7-, 83- and 1,024-character chunks, including Unicode and visible intermediate content. Existing hunk, reverse-apply, add/delete, and multi-hunk tests remain.

This is contract testing, not proof of the complete Electron/editor/provider integration. A native streamed edit, cancellation mid-patch, dirty-file reconciliation, and undo/redo smoke test are still required before calling a release production-grade.

## Visual inspection

1. Original native chat: state controls existed, but the screen retained the Code-OSS watermark and generic chrome; sparse empty chat and low-contrast context UI. [Starting screenshot](01-before.png).
2. Rebuilt native chat: Muster wordmark and sage palette rendered correctly, with the new welcome, context and activity surfaces. Native browser failure displayed a clear connection-refused message. These states were observed live; not all were saved as final evidence.
3. Offline fixture of the real renderer: long-message expansion, applied diff preview, retained context, activity details and reload persistence were exercised. [Saved conversation fixture](02-conversation-fixture.png). Its transcript and counts are sample data, not a paid agent run. The final Lucide font and narrow-width access controls were also visually inspected. [Final fixture with bundled icons and applied diff](03-final-fixture.png).
4. Narrow sidebar: controls wrap, access remains readable, and retained references have visible remove controls. Expanded activity consumes more vertical space by design and can be collapsed.

The Mac locked before final native theme-picker and icon-theme checks. No claim of native verification is made for those controls. The latest app is assembled separately under `dist/verified/Muster Code.app`, leaving the running app undisturbed.

## Verification

- Muster Code: TypeScript check, extension bundle, and 27 tests passed (including chat/settings DOM, renderer, context, URL, theme, parser and diff tests).
- Muster core: build and 25 targeted Codex transport tests passed, including the reasoning-output token assertion.
- Distribution: staged assembly applies the pinned base, product overlay, built-ins, theme assets, workbench patches and ad-hoc signing.
- No paid model turns were used. No project-wide gateway/CLI suite or cross-platform/native accessibility certification was run.

## Usage strategy for Astra without silently weakening work

OpenAI's guidance says allowance depends on model, context, reasoning, tools, retrieval and caching; prompt length alone cannot predict it. Preserve conversation and tool prefixes to improve cache reuse. Aggressive compaction changes the prefix and can reduce cache reuse. Tool search can defer definitions until needed. These are documented mechanisms, not a measured savings percentage for Muster. [Usage guidance](https://learn.chatgpt.com/docs/pricing#what-are-the-usage-limits-for-my-plan), [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching#how-to-optimize-prompt-caching).

The implemented changes remove duplicate context expansion, expose cache/input/output counts, avoid extra model calls to generate UI labels, and reduce webview rendering work. Retained sources are intentionally refreshed so the model does not work from stale files. This can cost more than omitting attachments; the shelf makes the choice explicit.

Next, measure repeated representative tasks with identical completion criteria: correctness, first-response latency, completion time, uncached input, output, reasoning output and unnecessary retries. Keep Astra for demanding decisions. Offer a visible, opt-in lower-cost model for bounded work; never silently route away from an explicit model choice. Integrate the existing core reasoning-economy decisions only after task-specific evaluations show they retain quality.

Use app-server-supported controls for this transport. Direct Responses API cache breakpoints and `configuration_update` are not assumed to be interchangeable with app-server parameters. [App-server lifecycle and approvals](https://learn.chatgpt.com/docs/app-server#approvals).

## Further UI additions, in priority order

| Priority | Addition | Acceptance condition |
|---|---|---|
| P0 | Durable activity timeline | Typed events with stable IDs survive restart; tool output, approvals, diffs and errors reopen exactly where they were. Historical text loading currently does not restore every rich event. |
| P0 | Recoverable run states | Preparing, running, waiting, disconnected, interrupted and complete states are explicit. Resume never blindly replays a dispatched write. Drafts and approvals survive reconnect. |
| P0 | Native diff smoke gate | Realtime full-file edits, multi-file review, dirty buffers, cancellation and undo/redo pass in the packaged Electron app before release. |
| P1 | Context inspector | Each reference previews its exact included range, source timestamp, truncation and token estimate; pinned references can be sent once or refreshed each turn. |
| P1 | Task and terminal workspace | Agent-owned terminal sessions with task labels, working directory, exit status, output search, reopen and command-to-diff links; retain native shell compatibility. |
| P1 | Browser diagnostics | Back/forward availability, page loading state in editor tabs too, network errors, console filters, resizable inspector and annotation-to-source navigation. |
| P1 | Usage inspector | Provider-sourced per-turn ledger, cache reuse trend, expensive-context attribution, configurable budget heads-up and explicit model-change choices. |
| P1 | Visual regression suite | Same fixtures in every palette, 320/380/720px sidebar widths, keyboard-only use, reduced motion, contrast and zoom checks. |
| P2 | Independent agent workspaces | Worktree-isolated edits and per-task checkpoint controllers before enabling truly concurrent editing. |
| P2 | Custom icon and theme editor | Per-theme preview and reset, independent file/product icon packs, import/export of appearance presets and system light/dark following. |

Native product-icon and color-theme contributions provide customization without replacing editor behavior. [Product icon themes](https://code.visualstudio.com/api/extension-guides/product-icon-theme), [theme customization](https://code.visualstudio.com/docs/configure/themes).
