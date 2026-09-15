# Agent orchestration · MC-801 · 13 September 2026

## Evidence and boundary

The official OpenAI App Server contract documents `thread/fork`, `thread/read`, paginated `thread/list`, `thread/status/changed`, and bidirectional `item/*`/`turn/*` notifications. The generated schema from the installed Codex binary (`codex app-server generate-ts`) confirms:

- `Thread` carries `parentThreadId`, `forkedFromId`, `agentNickname`, `agentRole`, `source`, runtime `status`, and `turns`.
- `ThreadItem` carries `collabAgentToolCall` with `senderThreadId`, `receiverThreadIds`, `prompt`, requested model/effort, and `agentsStates`; it also carries `subAgentActivity`, `fileChange`, and normal turn/item identifiers.
- `CollabAgentStatus` is `pendingInit | running | interrupted | completed | errored | shutdown | notFound`.
- `thread/list` parent/ancestor filters and `thread/fork` are experimental or provider-owned capabilities. The adapter therefore observes provider-created children and reports capability flags instead of presenting local pane tabs as spawned agents.

Primary source: [official Codex App Server API overview](https://learn.chatgpt.com/docs/app-server?translationFallback=es-419), especially the API overview, fork, status, and item pagination sections. Local schema generation was read-only and did not invoke a model turn.

## Implemented contract

`packages/builtin/src/agent-orchestration.ts` provides `AgentGraphAdapter`, which folds real provider events into a bounded durable graph:

- `AgentNode`: provider thread ID, parent ID, task prompt/name, role, status, turn ID, per-agent usage, changed paths, and update time.
- `AgentGraphEvent`: stable provider event ID when supplied, lifecycle kind, thread/parent/turn IDs, and bounded summary.
- `AgentGraphSnapshot`: versioned graph plus canonical `agents` UI projection and explicit capabilities: provider spawn observed, fork control unavailable, child steer unsupported, child interrupt unsupported.

Duplicate provider events with explicit `eventId`/`id` are ignored. Events without provider IDs receive observation sequence IDs and are retained as distinct events. `AgentGraphAdapter.from()` validates and restores bounded state. No child is synthesized from a local tab, and no write is replayed as a consequence of persistence or graph restoration.

`AgentPane` exposes the graph under the single authoritative `agentWorkspace` field on `state` and `telemetry`, persists it internally with the chat snapshot, and forwards provider `collabAgentToolCall`, `thread/status/changed`, turn, usage, and file-change events through the adapter. The existing diff owner remains the workspace edit lease; child observations do not bypass it.

The `agentAction` message accepts `open`, `steer`, `interrupt`, and `stop` with graph membership validation. Root-thread steer/interrupt actions use the existing owning app-server connection. Child actions return a structured failure explaining that independent child control is unavailable; no guessed process or local-tab action is substituted.

## Unsupported or unresolved capabilities

The current app-server client does not expose a durable subscription manager for independently reopening every child thread after a process restart. Parent-to-child messaging and child stop/steer need provider thread control and are not advertised as available by this lane. `thread/fork` can be added as an explicit user action after a provider capability check, but automatic fan-out would violate the no-fake-progress boundary. Native packaged QA still needs a real provider-created child run to validate end-to-end UI routing, status changes, approvals, diffs, and usage attribution.

## Verification

- Generated schema command completed successfully without a model call.
- Focused adapter tests cover provider child creation, status, turn, usage, file changes, duplicate event IDs, durable round-trip, and malformed events.
