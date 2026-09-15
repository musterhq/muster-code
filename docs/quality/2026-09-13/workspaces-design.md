# MC-601 independent agent workspaces — design and acceptance

Status: design only. This document does not authorize worktree creation, branch creation, merge, or deletion.

## Purpose and boundaries

An isolated agent task gets its own checkout, provider working directory, live edit controller, checkpoint namespace, approvals, and activity stream. The user's current checkout remains available and keeps its uncommitted edits. A task may be reviewed, resumed, exported, or explicitly applied later; no task result is merged into the current checkout automatically.

The existing runtime already has the right durable metadata primitives (`DurableRun`, `ActivityRecord`, `UsageLedgerEntry`, `ContextReference`) but editing is still process-wide. `AgentPane` has one `LiveEditController`, one `editOwner`, and one turn-watch. `LiveEditController` has one file map, checkpoint map, watch snapshot, and `muster.liveEdit` context. Its current queue is safe for serialized shared-checkout turns, not for concurrent independent edits. `runParallel` currently creates tabs but changes one shared `activeId` while turns race; this must remain gated until leases and controllers are task-scoped.

The narrowest extension seam is at `extension.ts`: construct a registry beside the existing source checkout controller, have `AgentPane` resolve a workspace-scoped runtime from each tab, and leave the current controller path intact for source-root tabs during rollout. `LiveEditController` can then be made lease-scoped with a constructor `{ cwd, workspaceId }` while preserving its existing review commands through an active-workspace resolver.

## Proposed model

The runtime owns a `WorkspaceRegistry` keyed by stable `workspaceId`. Each lease points to a validated path below a private Muster worktree root and has an explicit base:

```ts
type WorkspaceLeaseState = "creating" | "ready" | "running" | "canceling" | "orphaned" | "discardable" | "removed";
interface WorkspaceLease {
  workspaceId: string;
  taskId: string;
  sourceRoot: string;          // original checkout; never mutated by lease operations
  root: string;                // isolated checkout used as provider cwd
  baseRef: string;             // resolved commit/ref; never inferred at merge time
  branch?: string;             // only when explicitly requested
  state: WorkspaceLeaseState;
  dirtySeed?: { patchPath?: string; files: string[]; sourceHead: string };
  createdAt: number;
}
```

The default safe mode starts a detached worktree at an explicit resolved commit. If the user asks to start from the current dirty checkout, creation records `HEAD`, exports tracked changes as a binary-safe patch, copies selected untracked files, and applies them to the isolated root. Any conflict makes the lease `orphaned` with a diagnostic; it never writes back to the source root. A branch name is optional and must be supplied by the user or caller. Never invent a branch name as an implicit merge target.

Each lease gets a `LiveEditController` constructed with that lease root and a controller id. Every provider invocation receives the same `cwd` and `workspaceId`; every edit, checkpoint, approval, queue item, telemetry record, and pane event carries `workspaceId` and `runId`. The original shared controller remains the implementation for the current checkout until this registry is complete.

The pane tab stores `workspaceId` and renders the lease state alongside `DurableRun.state`. Switching tabs changes the active view only; it cannot change the provider cwd or route an event to another tab. A lease's `runId` is the only authority for resuming a task. A persisted run with `dispatched: true` is recoverable metadata and an explicit resume choice, never an instruction to replay a write.

## Lifecycle

1. Resolve and validate the source root and requested base ref. Confirm the destination is a new path under the private worktree root, is not the source root, and is not already leased.
2. Create the worktree from the resolved commit. Seed current dirty content only when explicitly requested, recording the source HEAD, patch path, copied untracked files, and conflicts.
3. Persist the lease before starting a provider turn. Start a task scoped controller and provider cwd. A failure after registration leaves a recoverable `orphaned` lease with no hidden cleanup.
4. Run turns with a per-lease checkpoint and approval registry. Cancellation first requests provider interruption, then drains pending approvals and queued follow-ups. If dispatch was confirmed, mark the run interrupted or disconnected and require an explicit resume; do not resend the prompt.
5. On completion, expose status, diff, activity, usage, and checkpoint actions against the lease root. “Apply to current checkout” is a separate explicit operation with a fresh source diff/conflict check; it is not part of task completion.
6. Discard requires the task to be stopped and all pending approvals settled. If the lease is dirty, export or retain a patch and require an explicit discard choice. Remove only the validated lease path and then run `git worktree prune` scoped to the repository. Persist removal only after the command succeeds.

## Minimal contracts

Runtime and pane contracts should add the smallest fields needed for routing:

```ts
interface WorkspaceRef { workspaceId: string; root: string; sourceRoot: string; baseRef: string; branch?: string; state: WorkspaceLeaseState; }
interface TaskRunRef { workspaceId: string; runId: string; state: RunState; dispatched?: boolean; turnId?: string; }
interface WorkspaceDiff { workspaceId: string; baseRef: string; files: { path: string; adds: number; dels: number; status: string }[]; patchPath?: string; }
```

`state` and `telemetry` messages carry `workspace?: WorkspaceRef`, `run?: TaskRunRef`, and existing `activityTimeline`, `usageLedger`, and `contextReferences`. `edit` and `review` messages carry `workspaceId`; a decision includes `workspaceId`, `path`, and an optional hunk index. `openPath` resolves only within the active workspace unless the user explicitly opens the source checkout. A registry API needs `create`, `get`, `list`, `diff`, `cancel`, `resume`, `exportPatch`, and `discard`; `apply` belongs behind a separate explicit command that checks source cleanliness and base commit.

## Acceptance matrix

No row is accepted from a unit test alone. Each row needs the listed automated evidence plus a parent-supervised desktop flow where applicable.

| ID | Scenario | Expected result | Evidence |
|---|---|---|---|
| W1 | Create from explicit commit | Lease root is a separate valid worktree at the resolved commit; source files and dirty state are unchanged | Registry test + `git status`/path assertions |
| W2 | Create from current dirty checkout | Tracked patch and selected untracked files are represented in lease; source remains byte-for-byte unchanged | Binary/Unicode patch test + before/after hashes |
| W3 | Invalid base, destination, or duplicate lease | Creation fails before provider start; no source mutation; partial destination is cleaned or marked recoverable | Negative path tests |
| W4 | Two tasks stream edits concurrently | Each controller paints only its lease; no file map, checkpoint, review, or event crosses task boundaries | Concurrent event stress test + two visible review panes |
| W5 | Switch tabs while both runs stream | Active tab changes presentation only; each tab retains its draft, activity, diff, and run state | DOM test + desktop tab switch flow |
| W6 | Approval arrives for task A while task B runs | Approval card appears only in A; accepting/declining cannot mutate B or source checkout | Routed request test + manual approval flow |
| W7 | Cancel before provider dispatch | Run becomes interrupted/failed safely; no provider write replay; lease remains resumable/discardable | dispatch-state unit test |
| W8 | Cancel after dispatch or disconnect | Run is marked disconnected/interrupted with `dispatched`; resume requires explicit user action and uses provider turn identity | restart simulation + no-duplicate-turn assertion |
| W9 | Restore a task checkpoint | Only files under that lease return to checkpoint contents; source checkout and other leases remain unchanged; inverse redo is scoped | checkpoint property test |
| W10 | Dirty buffer inside lease | Restore/reject handles dirty documents without overwriting unrelated user edits; conflict is surfaced for review | Electron dirty-buffer smoke test |
| W11 | Complete task with changes | Diff, usage ledger, activity, and patch export remain available after tab/webview reload | persistence test + reload flow |
| W12 | Apply task patch explicitly | Source base/ref is rechecked; conflicts stop the operation; success records source operation and preserves an undo artifact | integration test + supervised apply flow |
| W13 | Discard clean lease | Provider stopped, approvals drained, worktree removed, registry record transitions to removed | cleanup test |
| W14 | Discard dirty or orphaned lease | User receives exact patch/export choice; no silent data loss; stale process/worktree is recoverable | negative cleanup test |
| W15 | Process crash during creation/cancel | Startup reconciles leases and worktrees, marks uncertain state orphaned, and never auto-resumes or deletes unknown paths | restart/reconciliation test |
| W16 | Long output and many files | Bounded metadata remains responsive; diffs/patch export are complete even when UI cards are truncated | 300-file/large-output stress test |
| W17 | Concurrent worktree commands | Commands use each task's cwd and environment; no command executes in source root accidentally | command capture test |
| W18 | No repository / non-Git source | Isolation is disabled with a clear reason or uses a documented copy strategy; no fake worktree success | negative environment test |

## Review findings outside this frontend lane

- `AgentPane.runParallel` currently mutates the single `activeId` from multiple async runs and shares `LiveEditController`; it needs an isolation gate before claiming parallel edits. Owner: runtime/orchestrator.
- `LiveEditController`'s `checkpoint`, `files`, `streams`, `watch`, `settled`, and `muster.liveEdit` context are process-wide. A worktree implementation must instantiate one controller per lease or introduce a proven namespace; changing only tab routing is insufficient. Owner: runtime.
- `beginTurnWatch` and `syncTurnWatch` inspect one cwd and global workspace status. Concurrent turns against the source checkout can adopt each other's files even when provider events are routed correctly. Owner: runtime.
- `expandContext` now reports exact references for links, browser snapshots, and files, but code/symbol, rules, git, folders, live browser, terminal, docs, and past-chat blocks still append without a `ContextReference`. The workspace inspector must either receive references for every attached block or label those sources as unavailable/uncounted; it must not imply the list is complete. Owner: runtime/context.
- Existing `restore` uses absolute paths and can revert a file after a user edit unless dirty-buffer conflict detection is added to the lease controller. The worktree design makes this safer by scoping paths, but dirty documents still need a smoke gate. Owner: runtime/live-edit.
- `inlineEdit` assigns `editOwner` but does not mark a tab running; its guard therefore cannot prevent a chat turn or another inline edit from entering the shared controller while the provider request is still active. Add an explicit edit lease or running state before enabling concurrent workspace work. Owner: runtime/live-edit.
- The current typecheck is blocked by `test/browser-contract.test.ts` using `import.meta` under the package's CommonJS test configuration. The native model-menu finding is separate: model menu placement is deterministic in the fixture, so native verification should confirm popup timing before changing CSS or hiding working controls. Owner: orchestrator/test owner.

## Explicit non-goals

This design does not introduce automatic merging, silent source checkout mutation, branch deletion, force cleanup of arbitrary paths, provider write replay, or concurrent editing in the existing shared controller. It also does not certify native Electron behavior; that belongs to MC-701 after implementation.
