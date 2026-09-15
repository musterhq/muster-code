# Thread management lane · 13 September 2026

## MC-803 implementation

`src/thread-catalog.ts` adds a typed catalog over the existing `queryCodex` app-server adapter. It uses the documented cursor-based `thread/list` filters (`cwd`, `searchTerm`, `archived`, `isPinned`, and optional subagent `sourceKinds`), client-filters every response back to the currently open workspace roots, and retains the durable app-server thread ID as identity.

The catalog supports non-resuming metadata reads (`thread/read` with `includeTurns`), user-facing rename (`thread/name/set`), pinning (`thread/metadata/update`), archive/unarchive, and durable fork (`thread/fork`, with optional explicit `lastTurnId`). Fork ancestry and spawned-agent parentage are represented as separate relation fields. There is no delete or automatic import/migration path. An optional `callOwned` adapter hook lets runtime route mutations for loaded threads to their owning warm connection; when no owner is loaded, the explicit stored-thread management allowlist safely falls back to a one-shot query. Live turn control never uses that fallback.

`muster.thread.open` and `muster.thread.continue` hand a stored `thread/read` result to `AgentPane.openCatalogThread(record, read, mode)`. The runtime opens a real chat tab hydrated from stored turns; `open` leaves it read-only until the user sends, while `continue` marks the same tab as the continuation target. `muster.thread.inspect` is the separate read-only Markdown metadata/items view. Existing `muster.thread.resume` and provider history remain unchanged; catalog reads do not resume or subscribe to a thread.

When hydrating a stored parent, the pane replays persisted turn and item events through `AgentGraphAdapter`, including collaboration spawn/message direction and child status/turn/usage/change records. Event timestamps from storage are retained; missing timestamps are represented as unknown replay time rather than current live activity. Child details can then be opened through the scoped catalog/read path.

Child approvals carry their child thread ID in pending state and remain observable after the parent turn finishes. Parent cleanup does not auto-decline those requests; explicit tab closure settles them because the owning UI is being closed.

The shared-workspace edit lease also follows observed descendants: parent completion leaves the lease active while any child is pending or running, queues new root/inline edits, and releases/drains once when the final descendant settles. Closing the owner tab is refused while descendants remain active, preserving a resolvable warm owner instead of orphaning child writes.

## Operator commands

- `muster.thread.catalog` selects an allowed-workspace thread.
- `muster.thread.list` opens a picker without arguments or returns one typed page with structured filters.
- `muster.thread.listSubagents` lists interactive and subagent source kinds.
- `muster.thread.open` opens the stored thread as a real AgentPane chat after a non-resuming read; the user sends to continue.
- `muster.thread.continue` opens a real chat tab for a user initiated continuation without dispatching a turn.
- `muster.thread.inspect` opens persisted metadata plus turns/items as a read-only document without resuming.
- `muster.thread.rename`, `muster.thread.pin`, `muster.thread.archive`, `muster.thread.unarchive`, and `muster.thread.fork` all work from the Command Palette without hidden required arguments.

Command handlers report capability-aware errors when the app-server rejects an unsupported or experimental method. Archive has a confirmation step; fork is durable by default and ephemeral only when explicitly requested.

## Official API basis

The implementation follows the official [Codex App Server API overview](https://learn.chatgpt.com/docs/app-server): `thread/list` supports cursor pagination, `cwd`, `searchTerm`, `archived`, `isPinned`, and source filters; `thread/read` does not resume; `thread/name/set`, `thread/metadata/update`, `thread/archive`, `thread/unarchive`, and `thread/fork` have the parameter shapes used here. Parent/ancestor filters are experimental and require `experimentalApi`; the local app-server client already advertises that capability, while failures remain surfaced as capability errors.

## Checks and integration

- `thread-catalog.test.ts`, `agent-control.test.ts`, and `agent-orchestration.test.ts`: 14 focused behavioral tests passed for workspace filtering, pagination/filter payloads, cold and warm mutation routing, durable IDs, fork/spawn relation separation, unknown IDs, capability errors, exact child control payloads, graph membership, open/continue handoff, persisted collaboration replay, and timestamp preservation. Child controls use the owning warm conversation and an active expected turn ID; the runtime returns a structured owner/capability failure when that route is unavailable.
- `terminal-workspace.test.ts`: 4 passed after the adjacent terminal lane.
- Built-in typecheck reaches runtime-owned `agent-orchestration.ts` optional-field errors; no thread-catalog error is reported.
- Manifest command and extension wiring verification passed.

Frontend can consume `ThreadRecord`, `ThreadPage`, `ThreadRead`, and `ThreadCatalogError` through the command IDs. `AgentPane.conversationForThread(threadId)` now lets catalog mutations use `callOwnedThread` on the warm owner. Parent-child relation labels should keep `forkedFromId` visually distinct from `spawnedParentId`. Child raw events remain in `agentWorkspace`; parent transcript, run IDs, usage ledger, checkpoints, and activity are protected from child overwrites while supported same-workspace file changes continue through the live diff path.
