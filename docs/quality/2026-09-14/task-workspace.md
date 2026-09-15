# Task workspace frontend contract

The task workbench is a view over the runtime registry. It does not create tasks, read threads a second time, or infer parallel execution from local tabs. The producer contract is a versioned `taskWorkspace` snapshot:

```ts
interface TaskRuntimeIdentity {
  taskId: string;
  workspaceId: string;
  cwd: string;
  threadId?: string;
}

interface TaskRuntimeSnapshot extends TaskRuntimeIdentity {
  name: string;
  status: "idle" | "running" | "waiting" | "cancelled" | "completed" | "failed";
  activeTurnId?: string;
  capability: "isolated-worktree" | "shared-checkout-serialized";
  workspaceOwner?: string;
  changes?: { path: string; adds?: number; dels?: number }[];
}

interface TaskWorkspaceSnapshot {
  version: 1;
  activeTaskId: string;
  tasks: TaskRuntimeSnapshot[];
}
```

The UI renders bounded named cards and one focused task detail. Grid and split layouts are presentation preferences persisted with the active view. Cards show status, workspace capability, owner, and reported change count. A card without `threadId` remains visibly non-addressable. The focused chat action activates an existing thread; it never opens a duplicate transcript or dispatches a new turn.

Changes expose `Open diff` and `Pin review` using the existing `openPath` and `openReview` host messages, preserving the native full-file diff and review surface. Agent child hierarchy, parent/child messages, node-local patch receipts, stop/steer capability gates, and usage remain in the existing Agent workspace and consume the same `agentWorkspace` graph.

The offline `?scenario=tasks` fixture supplies three scripted tasks: one serialized current checkout, two isolated worktrees, named owners, running/waiting/completed statuses, and a missing thread identity. It labels itself as scripted and reports explicit no-live-runtime action feedback. `?scenario=tasks&state=empty` exercises the empty registry state. This fixture is review support only and does not claim concurrent provider execution.

Acceptance checks cover valid and malformed identity snapshots, serialized versus isolated capability labels, bounded task cards, no fabricated controls for missing thread identity, grid/split persistence, full-file diff/review messages, empty state, narrow layout, and long graph lists.
