# Muster IDE parity matrix · 13 September 2026

This bounded research supports MC-802 and MC-804. It compares the complete IDE workflow around agent tasks, rather than treating chat rendering as the product boundary. Statuses mean:

- **Implemented**: evidenced in current Muster source or focused DOM tests.
- **Missing**: no current runtime contract or UI path.
- **Experimental / not exposed**: upstream documents the capability, but Muster does not expose it as a stable workflow.

## Evidence baseline

OpenAI’s Codex App Server is the rich-client protocol used by the Codex VS Code extension. It exposes thread start/resume/fork/read/list, turn start/steer, streamed item events, approvals and completion notifications. Approval requests include threadId and turnId, which clients use to route UI state. The current runtime folds provider coordination into the versioned agentWorkspace snapshot. See [Codex App Server](https://learn.chatgpt.com/docs/app-server), especially [lifecycle and thread APIs](https://learn.chatgpt.com/docs/app-server#lifecycle-overview), [API overview](https://learn.chatgpt.com/docs/app-server#api-overview), and [approval contracts](https://learn.chatgpt.com/docs/app-server#approvals). OpenAI also states that the Codex IDE extension does not provide the Scheduled management interface; scheduled local-project tasks are managed in ChatGPT desktop or web. See [Scheduled tasks](https://learn.chatgpt.com/docs/automations#scheduled-tasks).

the reference IDE documents an Agent side pane with model, tools, context, checkpoints, queued messages and steer, plus a separate Agents Window for background agents and worktrees. See [the reference IDE Agent overview](https://cursor.com/docs/agent/overview), [Worktrees](https://cursor.com/docs/configuration/worktrees), [Browser](https://cursor.com/docs/agent/tools/browser), and [Background Agents](https://docs.cursor.com/background-agent). the reference IDE’s worktree docs explicitly keep the main checkout untouched and use an explicit apply/delete workflow.

The two open-source references are [OpenCode agent documentation](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/agents.mdx) and [Zed Agent Panel documentation](https://github.com/zed-industries/zed/blob/main/docs/src/ai/agent-panel.md) plus [Zed Parallel Agents](https://github.com/zed-industries/zed/blob/main/docs/src/ai/parallel-agents.md). OpenCode provides child-session navigation and permission-scoped Task delegation. Zed provides a Threads Sidebar, independent threads, external agents, Terminal Threads, worktree selection, checkpoints and token usage. These are reference designs, not dependencies.

## Parity matrix

| Workflow surface | Codex / upstream evidence | the reference IDE | OpenCode | Zed | Muster status and decision |
|---|---|---|---|---|---|
| Thread creation and history | thread/start, thread/list, thread/read, archive/unarchive; persisted status | Agent pane threads, history and archive | Sessions with parent/child navigation | Threads Sidebar grouped by project; archive/history | **Implemented**: tabs, history, pin, rename, archive, persisted rich transcript. **Missing**: child-aware discovery; current listThreads excludes subagents. |
| Project/workspace identity | Thread cwd; thread/list cwd filter; project metadata | Projects, multi-root Agents Window, worktree picker | Project worktree boundary and external-directory permission | Threads grouped by project; multi-root/worktree picker | **Implemented**: cwd filtering and per-thread model/access. **Missing**: first-class workspace lease; MC-601 design covers it. |
| Spawned-agent hierarchy | thread/fork; experimental parentThreadId/ancestorThreadId filters; multi-agent is separate | Multitask and background agents | Child sessions, parent/child navigation, Task permissions | Independent threads, no universal child tree | **Runtime contract now present**: versioned agentWorkspace graph with nodes/events/capabilities. **UI implemented**: exact graph adapter renders hierarchy; no fabricated agents. |
| Live child status/messages | thread/status/changed, item events, deltas, approvals | Child status, logs and takeover in Agents Window | Child session events | Thread status indicators and streamed tools | **Runtime emits** graph node status and bounded events. **UI implemented**: selected child status and directional parent/child event timeline. |
| Child diffs/review | File-change items expose proposals before approval and final completion | Worktree result review and explicit apply | Permission-gated edits/tools | Worktree diff review and Git merge | **Implemented for current thread**: live inline/full-file diff and keep/undo. **Missing**: child workspace-scoped diff stream/apply. |
| Model/reasoning controls | thread/turn settings accept model and reasoning | Model selector and per-agent settings | Agent/provider configuration | Model/provider selector and profiles | **Implemented**: model, effort, access per tab. **Missing**: child-specific settings payload/actions. |
| Context and attachments | Input items, file/skill items, stream events | @ files, folders, URLs, browser, rules, skills, images | Tools and external-directory permissions | @ files, directories, symbols, threads, selections, diagnostics | **Implemented**: broad @ mentions, immutable browser snapshots, exact metadata for supported refs, inspector. **Gap**: every context kind needs complete metadata. |
| Browser | Client-specific tool integration | Native browser pane, screenshots, logs, network, tab isolation, approvals | Provider/tool dependent | Agent tools/MCP dependent | **Implemented**: browser pane/editor, diagnostics, screenshots, picks, visual edits, MCP. **Experimental boundary**: browser is not an App Server primitive. |
| Terminal | Shell/tool items and approvals as streamed items | Native terminal tools and approval | bash permission plus external-directory policy | Terminal Threads beside agent threads | **Implemented**: managed native shell registry, output/search/reveal/close, chat entry. **Missing**: child-agent terminal links. |
| Checkpoints/recovery | thread/rollback; thread/resume; client restores files while messages remain | Checkpoint preview/restore | Session state and Git | Restore Checkpoint; local state separate from Git | **Implemented**: per-message restore/redo and durable run states. **Missing**: child/worktree checkpoint namespace. |
| Cancellation/steer/queue | turn/interrupt and turn/steer; accepted steer must not be resent | Queue and steer controls | Permission-aware Task control | Queue and steer | **Implemented**: stop, queue, steer active tab, approval cleanup. **Child controls**: UI enables Stop/Steer only when graph capabilities advertise support; actions and result feedback use agentAction/agentActionResult pending runtime handlers. |
| Scheduling | Not an App Server IDE primitive; IDE extension has no Scheduled management UI | Background agents and product automations | Harness-dependent | Not universal in Agent Panel | **Not exposed**: use ChatGPT desktop/web scheduler or a separately authorized integration. |
| Permissions/approvals | Server requests exact decisions scoped by threadId/turnId | Manual, allow-listed and auto-run | Per-tool ask/allow/deny | Tool Permissions and Profiles | **Implemented**: access modes and command/patch/elicitation cards. **Missing**: child-specific approval routing. |

## MC-802 Agent workspace UI

The existing chat surface now contains a compact Agent workspace action. When the runtime sends the versioned agentWorkspace snapshot on state or telemetry, the view renders:

- parent/child hierarchy from graph nodes keyed by threadId and parentThreadId;
- selected agent status, role, turn and thread;
- parent↔child timeline from graph events;
- bounded per-agent changed paths and usage;
- Stop, Steer and Open thread actions.

The action payload is exactly one message per click:

~~~ts
{
  type: "agentAction",
  action: "stop" | "steer" | "open",
  agentId: string,
  threadId?: string
}
~~~

MC-801/803 must route this to the owning child session and return authoritative updates through agentActionResult plus a refreshed agentWorkspace. Each node’s additive changeRecords carries id, threadId, optional turnId/itemId, path, status, optional diff, truncated, and unavailable so the UI can show immutable receipts. The graph capabilities control whether child Stop/Steer controls are available; Open thread uses the thread manager action path, and Threads opens muster.thread.catalog. Until graph data arrives, the workspace remains an honest empty state. Visible timeline is capped at 80 records, changed paths at 100, and receipts at 100 per selected agent. Existing chat, full-file diff, browser and terminal controls remain intact.

## Acceptance gates

Focused UI tests cover hierarchy rendering, selected child details, action routing, absent/malformed runtime data and bounded timeline stress. Parent live verification must still prove:

1. real child payloads route to the correct tab and survive tab switches;
2. Stop and Steer act on the selected child with no sibling mutation;
3. Open thread selects the provider thread and keeps its activity, changes and usage;
4. child diffs stay scoped to their workspace/controller;
5. disconnected child runs do not replay dispatched writes;
6. model/effort/access remain per child when supported;
7. narrow/short layouts retain typing, diff review, browser and managed terminal actions.

Scheduling remains outside the Agent workspace until the host chooses a supported automation integration. the reference IDE worktrees, OpenAI App Server APIs, and child-session references establish the target shape; they do not claim current Muster runtime support.
