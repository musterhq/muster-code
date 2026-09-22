# T3 Code renderer and client-runtime contracts — 22 September 2026

Reference: `pingdotgg/t3code` at `b5a0f810108d42ca8635b5a3d75a6e885bb3a254` (MIT). Local sparse reference checkout: `/private/tmp/t3code-reference-20260922`.

The purpose is to reuse compatible architecture and behavior with attribution, not to transplant the T3 visual identity.

| T3 source | Contract to carry into Muster |
| --- | --- |
| `AGENTS.md` | Treat WebSocket payload volume, CSS GPU cost and long-list rendering as release concerns. Performance claims require measurements. |
| `docs/internals/overview.md` | Provider processes, terminals, Git and files belong to the workspace-owning runtime. The renderer consumes authenticated RPC state and must not substitute local client authority. |
| `docs/internals/connection-runtime.md` | One retry owner per environment. Views never start competing reconnect loops. Backoff is capped; offline/auth failures wait for a state change. |
| `packages/contracts/src/settings.ts` | Streaming modes are explicit: whole turn, completed paragraph/closed code block, or token. Panel animation duration is a bounded setting. |
| `apps/web/src/components/ChatMarkdown.tsx` and `markdown-incremental.test.tsx` | Keep completed Markdown/code subtrees stable while only the mutable tail updates. Do not remount every code block on each token. |
| `apps/web/src/components/chat/MessagesTimeline.tsx` and logic | Virtualize long timelines, preserve reading position, and separate live follow behavior from manual scrollback. |
| `apps/web/src/components/chat/ChatComposer.tsx`, `ComposerCommandMenu.tsx`, `ProviderModelPicker.tsx` | Composer controls share state and keyboard behavior; pending input/approval/error/usage banners are part of the composer surface rather than disconnected screens. |
| `packages/client-runtime/src/state/threads.ts` | Keep active streaming state off expensive durable snapshot encoding; publish bounded changes and persist settled checkpoints. |
| `packages/client-runtime/src/state/subagentRuntime.ts` | Fold agent activity by stable task identity, bound repeated strings/history and preserve first-seen ordering independently of updates. |
| `packages/client-runtime/src/providerSkills.ts` and `packages/contracts/src/composerContext.ts` | Skills and file/app context are typed composer payloads, validated against provider capability before dispatch. |

## Known T3 evidence that prevents naive copying

- [Large event replay freeze](https://github.com/pingdotgg/t3code/issues/4596) documents superlinear replay when thousands of events are published individually. Muster must batch/collapse catch-up and use snapshot fallback.
- [Per-chunk persistence lag](https://github.com/pingdotgg/t3code/issues/5110) documents database and render amplification. Muster must separate ephemeral live delivery from bounded durable checkpoints while preserving exact final text.
- [Current T3 releases](https://github.com/pingdotgg/t3code/releases) include explicit fixes for avoiding chat-history scans, reusing completed code lines and preserving composer transition frames.

These are performance contracts, not a claim of parity. Acceptance needs recorded frame time, event counts, replay time, memory and recovery behavior on representative long-running threads.
