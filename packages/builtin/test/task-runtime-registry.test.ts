import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { TaskRuntimeRegistry, type RuntimeController, type TaskRuntimeIdentity } from "../src/task-runtime-registry.js";

class ControllerDouble implements RuntimeController {
  constructor(readonly cwd?: string) {}
  readonly events: { method: string; params: Record<string, unknown> }[] = [];
  onEvent(method: string, params: Record<string, unknown>): void { this.events.push({ method, params }); }
}

function identity(taskId: string, cwd: string, workspaceId = cwd): TaskRuntimeIdentity { return { taskId, cwd, workspaceId }; }

test("isolated worktrees route interleaved same-relative-path events independently", () => {
  const registry = new TaskRuntimeRegistry<ControllerDouble>();
  const first = new ControllerDouble("/tmp/worktree A");
  const second = new ControllerDouble("/tmp/worktree B");
  registry.register(identity("task-a", "/tmp/worktree A", "wt-a"), first, { isolated: true, validatedCwd: "/tmp/worktree A" });
  registry.register(identity("task-b", "/tmp/worktree B", "wt-b"), second, { isolated: true, validatedCwd: "/tmp/worktree B" });
  assert.equal(registry.beginTurn("task-a", "turn-a").ok, true);
  assert.equal(registry.beginTurn("task-b", "turn-b").ok, true);

  assert.equal(registry.routeEvent({ taskId: "task-b", method: "item/fileChange/outputDelta", params: { path: "src/index.ts", delta: "B" }, eventId: "b-1", turnId: "turn-b" }).accepted, true);
  assert.equal(registry.routeEvent({ taskId: "task-a", method: "item/fileChange/outputDelta", params: { path: "src/index.ts", delta: "A" }, eventId: "a-1", turnId: "turn-a" }).accepted, true);
  assert.deepEqual(first.events.map((event) => event.params.delta), ["A"]);
  assert.deepEqual(second.events.map((event) => event.params.delta), ["B"]);
  assert.equal(resolve(first.cwd!, String(first.events[0]!.params.path)), "/tmp/worktree A/src/index.ts");
  assert.equal(resolve(second.cwd!, String(second.events[0]!.params.path)), "/tmp/worktree B/src/index.ts");
  assert.equal(registry.get("task-a")?.capability, "isolated-worktree");
  assert.equal(registry.get("task-b")?.capability, "isolated-worktree");
});

test("same checkout stays serialized even when task IDs differ", () => {
  const registry = new TaskRuntimeRegistry<ControllerDouble>();
  registry.register(identity("first", "/repo", "repo"), new ControllerDouble());
  registry.register(identity("second", "/repo", "repo"), new ControllerDouble());
  assert.equal(registry.beginTurn("first", "turn-1").ok, true);
  const blocked = registry.beginTurn("second", "turn-2");
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason ?? "", /shared checkout/);
  assert.equal(registry.finishTurn("first", "turn-1"), true);
  assert.equal(registry.beginTurn("second", "turn-2").ok, true);
});

test("canonical cwd collisions fail closed and isolation requires host validation", () => {
  const registry = new TaskRuntimeRegistry<ControllerDouble>();
  registry.register(identity("canonical-a", "/repo/./src/../", "repo-a"), new ControllerDouble(), { isolated: true, validatedCwd: "/other" });
  registry.register(identity("canonical-b", "/repo", "repo-b"), new ControllerDouble());
  assert.equal(registry.get("canonical-a")?.cwd, "/repo");
  assert.equal(registry.get("canonical-a")?.capability, "shared-checkout-serialized");
  assert.equal(registry.beginTurn("canonical-a", "turn-a").ok, true);
  assert.equal(registry.beginTurn("canonical-b", "turn-b").ok, false);
});

test("duplicate and stale events are dropped while child events remain observable", () => {
  const registry = new TaskRuntimeRegistry<ControllerDouble>();
  const controller = new ControllerDouble();
  registry.register({ ...identity("task", "/repo", "repo"), threadId: "root-thread" }, controller);
  const started = registry.beginTurn("task", "parent-turn");
  const generation = started.generation!;
  assert.equal(registry.routeEvent({ taskId: "task", workspaceId: "other", method: "turn/started", params: {}, eventId: "wrong-workspace", threadId: "root-thread", turnId: "parent-turn", generation }).accepted, false);
  assert.equal(registry.routeEvent({ taskId: "task", method: "turn/started", params: {}, eventId: "root", turnId: "parent-turn", generation }).accepted, true);
  assert.equal(registry.routeEvent({ taskId: "task", method: "turn/started", params: {}, eventId: "root", turnId: "parent-turn", generation }).accepted, false);
  assert.equal(registry.routeEvent({ taskId: "task", method: "turn/started", params: {}, eventId: "child", threadId: "child-thread", turnId: "child-turn", child: true, generation }).accepted, true);
  assert.equal(registry.routeEvent({ taskId: "task", method: "turn/started", params: {}, eventId: "old", turnId: "old-turn", generation }).accepted, false);
  assert.equal(controller.events.length, 2);
});

test("cancel settles queued sends and approvals owned by that task", async () => {
  const registry = new TaskRuntimeRegistry<ControllerDouble>();
  registry.register(identity("task-a", "/a", "a"), new ControllerDouble());
  registry.register(identity("task-b", "/b", "b"), new ControllerDouble());
  const queued = registry.enqueue("task-a", "do work");
  const approval = registry.requestApproval("task-a", { id: "approval-a", threadId: "thread-a" });
  assert.equal(approval.accepted, true);
  assert.equal(registry.resolveApproval("task-b", "approval-a", "accept"), false);
  assert.equal(registry.resolveApproval("task-a", "approval-a", "accept", { threadId: "other-thread" }), false);
  assert.equal(registry.cancel("task-a"), true);
  assert.deepEqual(await queued.promise, { accepted: false, reason: "cancelled" });
  assert.equal(await approval.promise, undefined);
  assert.equal(registry.resolveApproval("task-a", "approval-a", "accept"), false);
  assert.equal(registry.get("task-a")?.pendingApprovalIds.length, 0);
});

test("reload invalidates old generation and does not replay dispatches or checkpoints across tasks", async () => {
  const registry = new TaskRuntimeRegistry<ControllerDouble>();
  registry.register(identity("task-a", "/a", "a"), new ControllerDouble());
  registry.register(identity("task-b", "/b", "b"), new ControllerDouble());
  const generation = registry.beginTurn("task-a", "turn-a").generation!;
  registry.checkpoint("task-a", "cp-a", { file: "/a/src/index.ts" });
  const queued = registry.enqueue("task-a", "send later");
  assert.equal(registry.reload("task-a"), true);
  assert.equal(registry.routeEvent({ taskId: "task-a", method: "turn/completed", params: {}, eventId: "late", turnId: "turn-a", generation }).accepted, false);
  assert.deepEqual(await queued.promise, { accepted: false, reason: "reloaded" });
  assert.deepEqual(registry.readCheckpoint("task-a", "cp-a"), { file: "/a/src/index.ts" });
  assert.equal(registry.readCheckpoint("task-b", "cp-a"), undefined);
  assert.equal(registry.get("task-a")?.status, "idle");
});
