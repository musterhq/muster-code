import { test } from "node:test";
import assert from "node:assert/strict";
import { activeDescendantCount, canCloseWithActiveDescendants, editLeaseActive } from "../src/edit-lease.js";

const graph = [
  { threadId: "root", status: "completed" },
  { threadId: "child", parentThreadId: "root", status: "running" },
  { threadId: "grandchild", parentThreadId: "child", status: "pendingInit" },
  { threadId: "done", parentThreadId: "root", status: "completed" },
];

test("parent completion keeps the shared edit lease while descendants remain active", () => {
  assert.equal(activeDescendantCount(graph, "root"), 2);
  assert.equal(editLeaseActive(false, graph, "root"), true);
  assert.equal(editLeaseActive(true, graph, "root"), true);
  assert.equal(canCloseWithActiveDescendants(graph, "root"), false);
});

test("child settlement releases the lease exactly when no active descendant remains", () => {
  const settled = graph.map((node) => node.threadId === "child" ? { ...node, status: "completed" } : node).map((node) => node.threadId === "grandchild" ? { ...node, status: "completed" } : node);
  assert.equal(activeDescendantCount(settled, "root"), 0);
  assert.equal(editLeaseActive(false, settled, "root"), false);
  assert.equal(canCloseWithActiveDescendants(settled, "root"), true);
});

test("unknown owner graphs fail closed for close safety", () => {
  assert.equal(canCloseWithActiveDescendants([{ threadId: "sibling", parentThreadId: "other", status: "running" }], "root"), true);
});
