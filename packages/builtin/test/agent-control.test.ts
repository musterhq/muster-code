import { test } from "node:test";
import assert from "node:assert/strict";
import { childControlRequest, isChildOfRoot } from "../src/agent-control.js";

test("child control uses exact app-server target payloads", () => {
  assert.deepEqual(childControlRequest("child", "turn-7", "interrupt"), { method: "turn/interrupt", params: { threadId: "child", turnId: "turn-7" } });
  assert.deepEqual(childControlRequest("child", "turn-7", "steer", "check the failing test"), { method: "turn/steer", params: { threadId: "child", expectedTurnId: "turn-7", input: [{ type: "text", text: "check the failing test" }] } });
  assert.throws(() => childControlRequest("child", "", "interrupt"), /active child/);
});

test("child membership rejects root, sibling, unknown, and cyclic targets", () => {
  const nodes = [{ threadId: "root" }, { threadId: "child", parentThreadId: "root" }, { threadId: "grandchild", parentThreadId: "child" }, { threadId: "sibling", parentThreadId: "root" }, { threadId: "cycle-a", parentThreadId: "cycle-b" }, { threadId: "cycle-b", parentThreadId: "cycle-a" }];
  assert.equal(isChildOfRoot(nodes, "child", "root"), true);
  assert.equal(isChildOfRoot(nodes, "grandchild", "root"), true);
  assert.equal(isChildOfRoot(nodes, "root", "root"), false);
  assert.equal(isChildOfRoot(nodes, "sibling", "other-root"), false);
  assert.equal(isChildOfRoot(nodes, "missing", "root"), false);
  assert.equal(isChildOfRoot(nodes, "cycle-a", "root"), false);
});
