import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { handoffThread, ThreadCatalog, ThreadCatalogError, type ThreadQueryAdapter, type ThreadRead, type ThreadRecord } from "../src/thread-catalog.js";

function adapter(responses: Record<string, Record<string, unknown> | Error>) {
  const calls: { method: string; params: Record<string, unknown>; cwd: string }[] = [];
  const value: ThreadQueryAdapter = { query: async (method, params, cwd) => { calls.push({ method, params, cwd }); const result = responses[method]; if (result instanceof Error) throw result; return result ?? {}; } };
  return { value, calls };
}

test("catalog pages across allowed workspaces, filters leaked rows, and preserves durable identities", async () => {
  const a = adapter({ "thread/list": { data: [
    { id: "thr-a", name: "A", cwd: "/workspace/a", threadSource: null, source: "vscode", isPinned: true, forkedFromId: "thr-root" },
    { id: "thr-outside", name: "Secret", cwd: "/other/project" },
  ], nextCursor: "next" } });
  const catalog = new ThreadCatalog(a.value, ["/workspace/a", "/workspace/b"]);
  const page = await catalog.listPage({ searchTerm: "A", includeSubagents: true });
  assert.deepEqual(page.data.map((row) => row.id), ["thr-a"]);
  assert.deepEqual(page.data[0]!.relation, { forkedFromId: "thr-root" });
  assert.equal(page.data[0]!.sourceKind, "vscode");
  assert.deepEqual(page.data[0]!.workspaceRoot, "/workspace/a");
  assert.deepEqual(a.calls[0]!.params.cwd, ["/workspace/a", "/workspace/b"]);
  assert.deepEqual(a.calls[0]!.params.sourceKinds, ["cli", "vscode", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther"]);
  assert.equal(page.nextCursor, "next");
});

test("catalog mutations use documented methods and keep fork/spawn relations distinct", async () => {
  const a = adapter({
    "thread/list": { data: [{ id: "root", name: "Root", cwd: "/workspace", parentThreadId: "spawn-parent", threadSource: "subAgent" }] },
    "thread/read": { thread: { id: "root", turns: [{ id: "turn-1", items: [{ type: "fileChange" }] }] } },
    "thread/name/set": { thread: { name: "Renamed" } },
    "thread/metadata/update": { thread: { isPinned: true } },
    "thread/archive": {}, "thread/unarchive": {},
    "thread/fork": { thread: { id: "forked", sessionId: "root" } },
  });
  const catalog = new ThreadCatalog(a.value, ["/workspace"]); await catalog.listPage();
  const read = await catalog.read("root"); assert.equal(read.thread.turns !== undefined, true);
  assert.equal((await catalog.rename("root", "Renamed")).name, "Renamed");
  assert.equal((await catalog.setPinned("root", true)).isPinned, true);
  await catalog.archive("root"); await catalog.unarchive("root"); const fork = await catalog.fork("root", { lastTurnId: "turn-1" });
  assert.equal(fork.relation.forkedFromId, "root"); assert.equal(fork.relation.spawnedParentId, undefined);
  assert.deepEqual(a.calls.slice(1).map((call) => call.method), ["thread/read", "thread/name/set", "thread/metadata/update", "thread/archive", "thread/unarchive", "thread/fork"]);
  assert.deepEqual(a.calls.at(-1)!.params, { threadId: "root", lastTurnId: "turn-1" });
});

test("cold catalog mutations use safe one-shot calls and refresh cached metadata", async () => {
  const calls: string[] = [];
  const catalog = new ThreadCatalog({
    callOwned: async () => undefined,
    query: async (method) => { calls.push(method); if (method === "thread/list") return { data: [{ id: "cold", name: "Before", cwd: "/workspace", isPinned: false }] }; if (method === "thread/name/set") return { thread: { name: "After" } }; if (method === "thread/metadata/update") return { thread: { isPinned: true } }; return {}; },
  }, ["/workspace"]);
  await catalog.listPage(); assert.equal((await catalog.rename("cold", "After")).name, "After"); assert.equal(catalog.knownThread("cold")?.name, "After"); assert.equal((await catalog.setPinned("cold", true)).isPinned, true); assert.equal(catalog.knownThread("cold")?.isPinned, true);
  assert.deepEqual(calls, ["thread/list", "thread/name/set", "thread/metadata/update"]);
});

test("catalog rejects cross-workspace filters, unknown IDs, and unsupported capabilities", async () => {
  const calls: string[] = []; let first = true;
  const catalog = new ThreadCatalog({ query: async (method) => { calls.push(method); if (first) { first = false; return { data: [{ id: "root", cwd: "/workspace" }] }; } throw new Error("parentThreadId requires experimentalApi capability"); } }, ["/workspace"]);
  await assert.rejects(() => catalog.listPage({ cwd: "/other" }), (error: unknown) => error instanceof ThreadCatalogError && /outside/.test(error.message));
  await assert.rejects(() => catalog.read("missing"), (error: unknown) => error instanceof ThreadCatalogError && /not in/.test(error.message));
  await catalog.listPage();
  await assert.rejects(() => catalog.listPage({ parentThreadId: "root" }), (error: unknown) => error instanceof ThreadCatalogError && error.capability && /experimentalApi/.test(error.message));
  assert.deepEqual(calls, ["thread/list", "thread/list"]);
});

test("catalog scope accepts equivalent symlink spellings while preserving provider cwd", async () => {
  const temp = mkdtempSync(join("/tmp", "muster-thread-scope-")); const real = join(temp, "real"); const link = join(temp, "link"); mkdirSync(real); symlinkSync(real, link);
  try {
    const a = adapter({ "thread/list": { data: [{ id: "symlinked", cwd: real }] } }); const catalog = new ThreadCatalog(a.value, [link]); const page = await catalog.listPage();
    assert.equal(page.data[0]!.cwd, real); assert.equal(a.calls[0]!.params.cwd, link);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("open and continue hand off hydrated reads without dispatching a turn", async () => {
  const record = { id: "thread", name: "Thread", preview: "", cwd: "/workspace", workspaceRoot: "/workspace", relation: {}, raw: {} } as ThreadRecord;
  const read = { record, thread: { id: record.id, turns: [{ id: "turn" }] } } as ThreadRead;
  const modes: string[] = []; const host = { openCatalogThread: async (_record: ThreadRecord, hydrated: ThreadRead, mode: "open" | "continue") => { assert.equal(hydrated.thread.turns !== undefined, true); modes.push(mode); } };
  await handoffThread(host, record, read, "open"); await handoffThread(host, record, read, "continue"); assert.deepEqual(modes, ["open", "continue"]);
  await assert.rejects(() => handoffThread({}, record, read, "open"), (error: unknown) => error instanceof ThreadCatalogError && /cannot open/.test(error.message));
});
