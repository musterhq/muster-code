# Task runtime registry contract

The runtime producer emits an additive `taskWorkspace` field in pane state:

```ts
{
  version: 1,
  activeTaskId: string,
  tasks: Array<{
    taskId: string,
    workspaceId: string,
    cwd: string,
    threadId?: string,
    name: string,
    status: "idle" | "running" | "waiting" | "cancelled" | "completed" | "failed",
    capability: "isolated-worktree" | "shared-checkout-serialized",
    activeTurnId?: string
  }>
}
```

`capability: "isolated-worktree"` is emitted only when the host registers a task with `isolated: true` and a matching `validatedCwd`. A distinct task ID, provider child thread, or display name is not isolation evidence. Provider children that inherit a parent cwd remain `shared-checkout-serialized`.

The registry canonicalizes lexical cwd/workspace keys, rejects task ID rebinding to another workspace, serializes active turns sharing either key, and routes events by task, workspace, generation, thread, and turn. Child events may carry a child thread/turn when the host has already established graph membership. Explicit provider event IDs are bounded replay keys; unnumbered output deltas remain distinct.

Queue entries, checkpoints, and approval promises belong to one task ID. Closing or cancelling a task settles its queued waiters and approvals before the provider interrupt is awaited. Reload increments the generation, clears pending dispatches, and drops late events without replaying sends. The registry has no provider spawn or filesystem write behavior; the host must supply a real worktree and controller before enabling isolated writes.
