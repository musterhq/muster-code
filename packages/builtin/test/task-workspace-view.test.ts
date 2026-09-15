import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTaskWorkspace } from "../src/task-workspace-view.js";

test("task workbench accepts runtime identity and preserves serialized checkout capability", () => {
  const snapshot = normalizeTaskWorkspace({ version: 1, activeTaskId: "task-a", tasks: [
    { taskId: "task-a", workspaceId: "ws-a", cwd: "/work/a", threadId: "thread-a", name: "Review auth", status: "running", capability: "shared-checkout-serialized", activeTurnId: "turn-a", changes: [{ path: "src/auth.ts", adds: 4, dels: 1 }] },
    { taskId: "task-b", workspaceId: "ws-b", cwd: "/work/b", name: "Docs", status: "idle", capability: "isolated-worktree", workspaceOwner: "worktree-b" },
  ] });
  assert.equal(snapshot?.activeTaskId, "task-a"); assert.equal(snapshot?.tasks[0]?.workspaceId, "ws-a"); assert.equal(snapshot?.tasks[0]?.capability, "shared-checkout-serialized"); assert.equal(snapshot?.tasks[1]?.workspaceOwner, "worktree-b");
});

test("task workbench rejects incomplete or fabricated identity and unknown status", () => {
  assert.equal(normalizeTaskWorkspace({ version: 1, activeTaskId: "missing", tasks: [] }), undefined);
  const snapshot = normalizeTaskWorkspace({ version: 1, activeTaskId: "ok", tasks: [
    { taskId: "ok", workspaceId: "ws", cwd: "/work", name: "Valid", status: "completed", capability: "isolated-worktree" },
    { taskId: "bad", workspaceId: "ws", cwd: "/work", name: "Bad", status: "running", capability: "parallel" },
    { taskId: "missing-cwd", workspaceId: "ws", name: "Bad", status: "running", capability: "shared-checkout-serialized" },
  ] });
  assert.equal(snapshot?.tasks.length, 1); assert.equal(snapshot?.tasks[0]?.taskId, "ok");
});
