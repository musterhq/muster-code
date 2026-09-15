import { test } from "node:test";
import assert from "node:assert/strict";
import { activityId, boundedEventData, browserUrl, cancelQueuedMessages, cleanDraft, editLeaseBlocks, queueMessage, readUsage, uniqueMentions } from "../src/conversation-state.js";

test("drafts retain text and deduplicate valid context without treating malformed storage as instructions", () => {
  assert.deepEqual(cleanDraft({ text: "long\nmessage", context: ["@src/app.ts", "@src/app.ts", 8, "garbage", "@browser:abcdef"] }), { text: "long\nmessage", context: ["@src/app.ts", "@browser:abcdef"] });
  assert.deepEqual(cleanDraft(null), { text: "", context: [] });
});
test("repeated mentions have one context expansion and trailing punctuation is excluded", () => {
  assert.deepEqual(uniqueMentions("@file.ts inspect @file.ts, and @browser:abc @image:/tmp/a.png @image:/tmp/a.png"), ["file.ts", "browser:abc", "image:/tmp/a.png"]);
});
test("usage distinguishes unavailable from reported zero and includes reasoning", () => {
  assert.deepEqual(readUsage({ inputTokens: 0, cachedInputTokens: null, outputTokens: -1, reasoningOutputTokens: 45 }), { inputTokens: 0, reasoningOutputTokens: 45 });
  assert.deepEqual(readUsage({ inputTokens: Infinity, outputTokens: "20" }), {});
});
test("browser URLs preserve local development ports and reject executable schemes", () => {
  for (const value of ["localhost:3000", "127.0.0.1:8000", "[::1]:3000", "app.local:5173"]) assert.equal(browserUrl(value), `http://${value}/`);
  assert.equal(browserUrl("example.com/docs"), "https://example.com/docs");
  assert.equal(browserUrl("https://example.com?a=1"), "https://example.com/?a=1");
  for (const value of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hello", ""]) assert.throws(() => browserUrl(value));
});
test("activity ids are stable for replayed lifecycle events while sequence preserves deltas", () => {
  const event = { turnId: "turn-7", item: { id: "item-3", type: "commandExecution" } };
  assert.equal(activityId("item/started", event, 1), activityId("item/started", event, 1));
  assert.notEqual(activityId("item/outputDelta", event, 1), activityId("item/outputDelta", event, 2));
});
test("event metadata is bounded and circular values cannot break workspace persistence", () => {
  const data: Record<string, unknown> = { output: "x".repeat(20_000), nested: { ok: true } };
  data.self = data;
  const safe = boundedEventData(data, 1000)!;
  assert.ok(JSON.stringify(safe).length <= 1500);
  assert.ok(safe.nested === undefined || (safe.nested as Record<string, unknown>).ok === true);
  assert.ok(safe.self === undefined || safe.self === "[circular]");
});
test("edit ownership queues messages behind an active owner and cancellation settles every waiter", () => {
  const queue: string[] = [], waiters: (() => void)[] = [];
  let settled = 0;
  queueMessage(queue, waiters, "first", () => { settled++; });
  queueMessage(queue, waiters, "second", () => { settled++; });
  assert.equal(editLeaseBlocks({ id: "inline-tab", active: true }, "chat-tab"), true);
  assert.equal(editLeaseBlocks({ id: "inline-tab", active: true }, "inline-tab"), false);
  assert.equal(cancelQueuedMessages(queue, waiters), 2);
  assert.deepEqual(queue, []);
  assert.equal(settled, 2);
});
