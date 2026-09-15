# Runtime lane · 13 September 2026

This lane covers the native app-server boundary and the built-in agent pane runtime. It does not certify the packaged Electron/native integration or provider availability.

## MC-101 · durability and run lifecycle

The pane now persists a bounded rich transcript projection (user/assistant/tool/plan messages), typed activity records, context references, usage ledger entries, and the current run record in `muster.openChats`. A reload converts an in-flight `preparing`, `running`, or `waiting` run to `disconnected` with an explicit reason. It never replays the prompt. Provider history remains the source for a tab opened without a persisted transcript projection. `state` and `telemetry` expose both the structured `run` and additive `runState` alias for older renderers.

Run records distinguish `preparing`, `running`, `waiting`, `disconnected`, `interrupted`, `complete`, and `failed`; the core app-server result now exposes `dispatchState` (`not-dispatched`, `dispatched`, or conservative `unknown`) and `turnId` so a caller can tell whether `turn/start` crossed the replay boundary.

## MC-102 · approvals, checkpoints, and queue

Approval cards are namespaced when provider item IDs collide across tabs. Decisions restore the tab's run state and are routed to the owning tab. Inline edit approval callbacks use the captured tab, preventing a tab switch from showing the request in another chat. Existing shared-workspace edit serialization and queue cancellation remain in place; worktree-isolated parallel editing is still future work. Checkpoints remain owned by the active edit owner and are recorded after turn cleanup.

## MC-103 · inspectable context

`expandContext` retains its prompt and image outputs and adds `references`. File references include exact requested range, included line count, source path, source mtime, truncation, and a token estimate. Browser snapshots include their immutable snapshot path and mtime. Other context kinds carry a typed source and bounded estimate where available; unresolved supported mentions are explicitly marked `unavailable`. The metadata is additive and does not alter explicit model/effort selection.

## MC-104 · usage ledger

The pane records each provider `thread/tokenUsage/updated` snapshot against its turn ID and closes a per-turn ledger entry at completion. Missing values remain absent; zero is preserved. Cached-input and reasoning-output tokens are carried through the core result and pane result. The UI receives both the current usage snapshot and the bounded ledger as additive fields.

## Verification

- `pnpm --filter @musterhq/core typecheck` passed.
- Core app-server test suite passed (737 tests), including stream reuse, request routing, interrupted turns, serialization, resume, stale-thread recovery, and no-replay boundaries.
- Runtime state tests passed: 7 focused `conversation-state` tests, including bounded circular-safe event metadata, stable activity IDs, edit ownership, and queue cancellation waiter settlement.
- `pnpm --filter @muster-code/builtin typecheck` is currently blocked by the existing `test/browser-contract.test.ts` CommonJS/`import.meta` configuration error; runtime source errors are absent when that test is excluded.
- Full built-in test invocation remains blocked by the existing generated `agent-view` harness syntax failure; this lane did not modify `agent-view.ts`.

## Remaining defects and risks

Rich event persistence is bounded and local workspace state can still fail to write under host shutdown. Historical provider rollouts do not reconstruct every old rich event; only events captured by the pane are durable. A disconnected run needs an explicit user-led resume decision. Shared workspace checkpoint ownership intentionally serializes edits, and native packaged smoke coverage for dirty buffers, cancellation, undo/redo, and reconnect remains required.
