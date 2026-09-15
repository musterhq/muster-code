import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentGraphAdapter } from "../src/agent-orchestration.js";

test("agent graph observes provider-created children and folds status, usage, and changes", () => {
  const graph = new AgentGraphAdapter("parent");
  graph.ingest("item/started", { threadId: "parent", item: { type: "collabAgentToolCall", id: "call-1", tool: "spawnAgent", senderThreadId: "parent", receiverThreadIds: ["child"], prompt: "Inspect auth flow", agentRole: "reviewer", agentsStates: { child: { status: "running" } } } });
  graph.ingest("turn/started", { threadId: "child", turn: { id: "turn-1" } });
  graph.ingest("thread/tokenUsage/updated", { threadId: "child", turnId: "turn-1", tokenUsage: { last: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 8, reasoningOutputTokens: 3 } } });
  graph.ingest("item/completed", { threadId: "child", item: { type: "fileChange", id: "change-1", changes: [{ path: "src/auth.ts" }] } });
  graph.ingest("turn/completed", { threadId: "child", turn: { id: "turn-1", status: "completed" } });
  const snapshot = graph.snapshot();
  assert.equal(snapshot.rootThreadId, "parent");
  assert.equal(snapshot.nodes.find((node) => node.threadId === "child")?.parentThreadId, "parent");
  assert.equal(snapshot.nodes.find((node) => node.threadId === "child")?.status, "completed");
  assert.deepEqual(snapshot.nodes.find((node) => node.threadId === "child")?.usage, { inputTokens: 12, cachedInputTokens: 4, outputTokens: 8, reasoningOutputTokens: 3 });
  assert.deepEqual(snapshot.nodes.find((node) => node.threadId === "child")?.changes, ["src/auth.ts"]);
  assert.equal(snapshot.capabilities.providerSpawnObserved, true);
});

test("agent graph deduplicates explicit provider event ids and round-trips durable state", () => {
  const graph = new AgentGraphAdapter("parent");
  const params = { eventId: "evt-1", threadId: "parent", status: { type: "active" } };
  assert.ok(graph.ingest("thread/status/changed", params));
  assert.equal(graph.ingest("thread/status/changed", params), undefined);
  const restored = AgentGraphAdapter.from(graph.snapshot()).snapshot();
  assert.equal(restored.events.length, 1);
  assert.equal(restored.events[0]?.id, "provider:evt-1");
  assert.equal(restored.nodes[0]?.status, "running", "active thread status maps to a running agent");
});

test("only spawnAgent creates all receiver nodes; send/wait/close remain directional events", () => {
  const graph = new AgentGraphAdapter("parent");
  graph.ingest("item/started", { threadId: "parent", item: { type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", senderThreadId: "parent", receiverThreadIds: ["a", "b"], prompt: "Parallel review", agentsStates: { a: { status: "running" }, b: { status: "pendingInit" } } } });
  graph.ingest("item/completed", { threadId: "parent", item: { type: "collabAgentToolCall", id: "send", tool: "sendInput", senderThreadId: "parent", receiverThreadIds: ["a", "b"], prompt: "Check tests" } });
  graph.ingest("item/completed", { threadId: "parent", item: { type: "collabAgentToolCall", id: "wait", tool: "wait", senderThreadId: "parent", receiverThreadIds: ["a", "b"] } });
  graph.ingest("item/completed", { threadId: "parent", item: { type: "collabAgentToolCall", id: "close", tool: "closeAgent", senderThreadId: "parent", receiverThreadIds: ["a", "b"] } });
  const snapshot = graph.snapshot();
  assert.deepEqual(snapshot.nodes.filter((node) => node.parentThreadId === "parent").map((node) => node.threadId).sort(), ["a", "b"]);
  assert.ok(snapshot.events.some((event) => event.kind === "message" && event.summary.includes("sendInput") && event.toThreadIds?.length === 2));
  assert.equal(snapshot.events.filter((event) => event.kind === "spawned").length, 2);
});

test("child turn ids stay on child lifecycle events and changes accumulate by path", () => {
  const graph = new AgentGraphAdapter("parent");
  graph.ingest("item/started", { threadId: "parent", item: { type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", senderThreadId: "parent", receiverThreadIds: ["child"], prompt: "Do work" } });
  graph.ingest("turn/started", { threadId: "child", turn: { id: "child-turn" } });
  graph.ingest("item/completed", { threadId: "child", item: { type: "fileChange", id: "change-a", changes: [{ path: "a.ts" }] } });
  graph.ingest("item/completed", { threadId: "child", item: { type: "fileChange", id: "change-b", changes: [{ path: "b.ts" }, { path: "a.ts" }] } });
  const child = graph.snapshot().nodes.find((node) => node.threadId === "child")!;
  assert.equal(child.turnId, "child-turn");
  assert.deepEqual(child.changes, ["a.ts", "b.ts"]);
  assert.ok(!graph.snapshot().events.find((event) => event.kind === "spawned")?.turnId);
});

test("malformed or non-agent events fail closed without inventing a child", () => {
  const graph = new AgentGraphAdapter("parent");
  assert.equal(graph.ingest("item/started", { item: { type: "commandExecution" } }), undefined);
  assert.equal(graph.ingest("thread/status/changed", { status: null }), undefined);
  assert.equal(graph.snapshot().nodes.length, 0);
  assert.equal(graph.snapshot().capabilities.providerSpawnObserved, false);
  assert.equal(graph.ingest("unrelated/notification", { threadId: "parent" }), undefined);
});

test("persisted collaboration items rebuild graph ownership without fabricating timestamps", () => {
  const graph = new AgentGraphAdapter("parent"); const observed = 1_700_000_000_000;
  graph.ingest("turn/started", { threadId: "parent", turn: { id: "turn-1" } }, observed);
  graph.ingest("item/completed", { threadId: "parent", item: { type: "collabAgentToolCall", id: "spawn-1", tool: "spawnAgent", senderThreadId: "parent", receiverThreadIds: ["child"], prompt: "Inspect child work", agentsStates: { child: { status: "idle" } } } }, observed);
  graph.ingest("turn/completed", { threadId: "parent", turn: { id: "turn-1", status: "completed" } }, observed);
  const snapshot = graph.snapshot(); const child = snapshot.nodes.find((node) => node.threadId === "child");
  assert.equal(child?.parentThreadId, "parent"); assert.equal(child?.status, "idle"); assert.equal(child?.updatedAt, observed);
  assert.equal(snapshot.events[0]?.ts, observed); assert.equal(snapshot.events.some((event) => event.kind === "spawned" && event.parentThreadId === "parent"), true);
});

test("completed file changes retain distinct patch receipts for agents editing the same path", () => {
  const graph = new AgentGraphAdapter("parent");
  for (const [threadId, turnId, itemId, diff] of [["child-a", "turn-a", "item-a", "-old\n+alpha"], ["child-b", "turn-b", "item-b", "-old\n+beta"]] as const) {
    graph.ingest("item/completed", { threadId, turnId, item: { type: "fileChange", id: itemId, status: "completed", changes: [{ path: "shared.ts", kind: "update", diff }] } });
  }
  const records = graph.snapshot().nodes.flatMap((node) => node.changeRecords ?? []);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => [record.threadId, record.turnId, record.itemId, record.path, record.diff]), [["child-a", "turn-a", "item-a", "shared.ts", "-old\n+alpha"], ["child-b", "turn-b", "item-b", "shared.ts", "-old\n+beta"]]);
  assert.equal(AgentGraphAdapter.from(graph.snapshot()).snapshot().nodes.flatMap((node) => node.changeRecords ?? []).length, 2);
});

test("change receipts deduplicate replayed item IDs and mark missing diffs unavailable", () => {
  const graph = new AgentGraphAdapter("parent");
  const params = { threadId: "child", turnId: "turn", item: { type: "fileChange", id: "item", status: "completed", changes: [{ path: "a.ts" }] } };
  graph.ingest("item/completed", params);
  graph.ingest("item/completed", params);
  const record = graph.snapshot().nodes[0]?.changeRecords?.[0];
  assert.equal(graph.snapshot().nodes[0]?.changeRecords?.length, 1);
  assert.equal(record?.unavailable, true);
  assert.equal(record?.diff, undefined);
});

test("large patch receipts are truncated and bounded", () => {
  const graph = new AgentGraphAdapter("parent");
  const diff = "x".repeat(100_000);
  graph.ingest("item/completed", { threadId: "child", turnId: "turn", item: { type: "fileChange", id: "item", status: "completed", changes: [{ path: "large.ts", diff }] } });
  const record = graph.snapshot().nodes[0]?.changeRecords?.[0];
  assert.equal(record?.truncated, true);
  assert.equal(record?.unavailable, false);
  assert.equal(record?.diff?.length, 32_000);
});
