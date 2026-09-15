import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transformSync } from "esbuild";
import * as routing from "../src/provider-routing.js";
import { AgentGraphAdapter } from "../src/agent-orchestration.js";
import * as lease from "../src/edit-lease.js";
import * as conversation from "../src/conversation-state.js";
import { TaskRuntimeRegistry } from "../src/task-runtime-registry.js";

function load(file: string, mocks: Record<string, any>): any {
  const code = transformSync(readFileSync(resolve("src", file), "utf8"), { loader: "ts", format: "cjs", target: "es2022" }).code;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)((name: string) => name in mocks ? mocks[name] : require(name), module, module.exports);
  return module.exports;
}

const config = { get: (_: string, fallback?: any) => fallback };
class EventEmitter { event = () => ({ dispose() {} }); fire() {} }
function codexFixture() {
  const calls: any[] = []; const queries: any[] = []; let execute: (input: any) => Promise<any> = async () => ({ status: "completed", finalMessage: "ok", threadId: "thread", dispatchState: "dispatched" });
  const core = { runCodexAppServer: async (input: any) => { calls.push(input); return execute(input); }, clearCodexAppServerConversation: () => {}, steerActiveCodexTurn: async (...args: any[]) => { calls.push(args); return true; }, interruptActiveCodexTurn: async (...args: any[]) => { calls.push(args); return true; }, callCodexConversation: async (...args: any[]) => { calls.push(args); return {}; } };
  const api = load("codex.ts", { vscode: { workspace: { getConfiguration: () => config } }, "@musterhq/core": core, "./agent-control.js": {}, "./provider-routing.js": routing, "./provider-query.js": { queryProvider: async (route: any, _method: string, _params: any, cwd: string) => { queries.push({ provider: route.providerId, cwd }); return { data: [{ id: route.providerId === "hybrow" ? "codex/gpt-5.6-luna" : "gpt-5.5", supportedReasoningEfforts: [], defaultReasoningEffort: "medium" }] }; } } });
  return { api, calls, queries, setExecute: (fn: typeof execute) => { execute = fn; } };
}

test("actual runTurn preserves browser MCP, approvals, images and exact provider model", async () => {
  for (const provider of ["openai-direct", "hybrow"] as const) {
    const f = codexFixture(); f.api.setBrowserMcp({ command: "/browser/shim", args: ["socket"], env: { PUBLIC_MODE: "browser" } }); f.api.setDisabledMcpServers(["other"]);
    const request = async () => ({ decision: "accept" });
    const id = provider === "hybrow" ? "hybrow:codex/gpt-5.6-luna" : "openai-direct:gpt-5.5";
    await f.api.runTurn({ prompt: "offline test", cwd: "/work", model: id, providerId: provider, conversation: "pane", threadId: "existing", mode: "plan", images: ["/image.png"], access: { sandbox: "read-only", approvalPolicy: "on-request" }, handlers: { onDelta() {}, onReasoning() {}, onRequest: request } });
    const input = f.calls[0]; assert.equal(input.model, provider === "hybrow" ? "codex/gpt-5.6-luna" : "gpt-5.5"); assert.equal(input.collaborationMode.settings.model, input.model); assert.equal(input.threadId, "existing"); assert.equal(input.onRequest, request); assert.equal(input.approvalPolicy, "on-request"); assert.equal(input.sandbox, "read-only"); assert.deepEqual(input.images, ["/image.png"]);
    assert.ok(input.configOverrides.includes('mcp_servers.muster_browser.command="/browser/shim"')); assert.ok(input.configOverrides.includes('mcp_servers.other.enabled=false'));
    assert.ok(!input.configOverrides.some((row: string) => /mcp_servers\.(computer-use|unified-computer-use|visualize|cua_repl|node_repl)\.enabled=false/.test(row)));
    assert.ok(!input.configOverrides.some((row: string) => /^plugins\./.test(row)));
    assert.ok(input.developerInstructions.includes('muster_browser'));
    assert.ok(/computer-use plugin/i.test(input.developerInstructions));
    assert.ok(!input.developerInstructions.includes('unless the user explicitly asks'));
    assert.equal(input.env.MUSTER_PROVIDER_NODE, process.execPath);
    await f.api.steerTurn("follow-up", "pane"); assert.equal(f.calls[1][2], `conv:pane:provider:${provider}`);
  }
});

test("runner rejects conflicting and busy dispatch; failures are returned once without retries", async () => {
  const f = codexFixture(); const input = { prompt: "test", cwd: "/work", model: "openai-direct:gpt-5.5", conversation: "pane", handlers: { onDelta() {}, onReasoning() {} } };
  await assert.rejects(f.api.runTurn({ ...input, providerId: "hybrow" }), /conflicts/); assert.equal(f.calls.length, 0);
  let release!: (v: any) => void; f.setExecute(() => new Promise(resolve => { release = resolve; })); const pending = f.api.runTurn(input);
  await assert.rejects(f.api.runTurn({ ...input, model: "hybrow:codex/gpt-5.6-luna" }), /active/);
  release({ status: "failed", finalMessage: "", errorMessage: "capacity", dispatchState: "not-dispatched", threadId: "kept" });
  const result = await pending; assert.equal(result.status, "failed"); assert.equal(result.threadId, "kept"); assert.equal(f.calls.length, 1);
});

test("catalog caching separates providers and workspaces and retains legacy Direct models", async () => {
  const f = codexFixture(); const first = await f.api.listModels("/one", ["claude-fable-5"]); await f.api.listModels("/one"); assert.equal(f.queries.length, 2);
  await f.api.listModels("/two"); assert.equal(f.queries.length, 4);
  assert.ok(first.some((m: any) => m.id === "openai-direct:gpt-5.5")); assert.ok(first.some((m: any) => m.id === "openai-direct:gpt-5.3-codex-spark")); assert.ok(first.some((m: any) => m.id === "claude:claude-fable-5"));
});

function paneFixture(store: Record<string, any> = {}) {
  const sent: any[] = [], warnings: string[] = [];
  const vscode = { EventEmitter, workspace: { getConfiguration: () => config, workspaceFolders: [{ uri: { fsPath: "/work" } }] }, window: { showWarningMessage: (text: string) => { warnings.push(text); }, activeTextEditor: undefined }, commands: { executeCommand: async () => {} } };
  const live = { onCard() {}, onChange() {}, review: () => [], reviewMode: "review", setReviewMode() {}, beginCheckpoint() {}, beginTurnWatch: async () => {}, syncTurnWatch: async () => {}, takeCheckpoint: () => new Map() };
  const codex = { bindConversationProvider() {}, isUnattendedAccess: (a: any) => a?.approvalPolicy === "never" || a?.sandbox === "danger-full-access", runTurn: async (input: any) => { sent.push(input); return { status: "failed", threadId: "durable-thread", errorMessage: "offline failure", dispatchState: "not-dispatched" }; } };
  const paneMod = load("agent-pane.ts", { vscode, "./codex.js": codex, "./provider-routing.js": routing, "./agent-view.js": {}, "./agent-orchestration.js": { AgentGraphAdapter }, "./agent-control.js": {}, "./edit-lease.js": lease, "./conversation-state.js": conversation, "./task-runtime-registry.js": { TaskRuntimeRegistry }, "./live-edit.js": {}, "./context.js": { expandContext: async (prompt: string) => ({ prompt, images: [], references: [] }) } });
  const Pane = paneMod.AgentPane;
  codex['readRules' as keyof typeof codex] = (() => "") as any;
  const state = { get: (key: string, fallback: any) => store[key] ?? fallback, update: async (key: string, value: any) => { store[key] = JSON.parse(JSON.stringify(value)); } };
  const pane = new Pane({ workspaceState: state, subscriptions: [] }, { appendLine() {} }, live);
  pane.models = routing.PROVIDER_MODELS.map(m => ({ id: routing.providerModelId(m.providerId, m.model), provider: "codex", providerId: m.providerId, name: m.name, efforts: [{ id: "medium" }], defaultEffort: "medium" }));
  return { pane, sent, warnings, store, paneMod };
}

test("pane selection locks busy tasks, persists failed thread identity and resumes after reload", async () => {
  const f = paneFixture(); const tab = f.pane.active(); const modelId = "hybrow:codex/gpt-5.6-luna";
  assert.equal(f.pane.selectModel(tab, modelId), true);
  tab.running = true; assert.equal(f.pane.selectModel(tab, "openai-direct:gpt-5.5"), false); assert.equal(tab.settings.modelId, modelId); tab.running = false;
  await f.pane.send("test", tab); await f.pane.saveChain;
  assert.equal(f.sent[0].providerId, "hybrow"); assert.equal(tab.thread.id, "durable-thread"); assert.equal(tab.thread.providerId, "hybrow");
  const restored = paneFixture(f.store); const next = restored.pane.active(); assert.equal(next.settings.modelId, modelId); assert.equal(next.thread.providerId, "hybrow");
  assert.equal(restored.pane.selectModel(next, "openai-direct:gpt-5.5"), false);
  await restored.pane.send("resume", next); assert.equal(restored.sent[0].threadId, "durable-thread"); assert.equal(restored.sent[0].model, modelId);
});

test("computer-use is not in the default disabled MCP list", () => {
  const f = codexFixture();
  assert.deepEqual([...f.api.disabledMcpServers], []);
  assert.ok(f.api.HOST_COMPUTER_USE_MCP.includes("computer-use"));
  assert.ok(!f.api.mcpDisableOverrides().some((row: string) => row.includes("computer-use")));
  assert.deepEqual(f.api.mcpDisableOverrides(["computer-use", "cua_repl", "visualize", "node_repl", "unified-computer-use", "other"]), ["mcp_servers.other.enabled=false"]);
});

test("computer-use elicitation fixture maps to Allow/Decline", async () => {
  const f = paneFixture();
  const fixture = { serverName: "computer-use", elicitation: { message: "Allow Calendar.app for this task?", requestedSchema: { type: "object", properties: {} } } };
  assert.equal(f.paneMod.elicitationText(fixture), "Allow Calendar.app for this task?");
  assert.deepEqual(f.paneMod.computerUseToolFromItem({ id: "cu-1", type: "mcpToolCall", server: "computer-use", tool: "listApps" }), { id: "cu-1", tool: "computer", detail: "computer-use listApps", status: "running" });
  const pending = f.pane.debugRequest("mcpServer/elicitation/request", fixture);
  await new Promise((resolve) => setImmediate(resolve));
  const ids = f.pane.debugState().approvals as string[];
  assert.equal(ids.length, 1);
  f.pane.debugDecide(ids[0]!, "accept");
  assert.deepEqual(await pending, { action: "accept", content: {} });
  const declined = f.pane.debugRequest("mcpServer/elicitation/request", { params: { prompt: "Use Screen Recording?" } });
  await new Promise((resolve) => setImmediate(resolve));
  const next = f.pane.debugState().approvals as string[];
  assert.equal(next.length, 1);
  f.pane.debugDecide(next[0]!, "decline");
  assert.deepEqual(await declined, { action: "decline", content: null });
});

test("full access auto-accepts command approval and computer-use elicitation", async () => {
  const f = paneFixture();
  (f.pane as any).access = [{ id: ":danger-full-access", label: "Full access", sandbox: "danger-full-access", approvalPolicy: "never" }];
  f.pane.active().settings.accessId = ":danger-full-access";
  const command = await f.pane.debugRequest("item/commandExecution/requestApproval", { command: "ls", cwd: "/work" });
  assert.deepEqual(command, { decision: "accept" });
  assert.equal((f.pane.debugState().approvals as string[]).length, 0);
  const elicitation = await f.pane.debugRequest("mcpServer/elicitation/request", { elicitation: { message: "Allow Calendar.app for this task?" } });
  assert.deepEqual(elicitation, { action: "accept", content: {} });
  assert.equal((f.pane.debugState().approvals as string[]).length, 0);
});

test("access profile ids without a leading colon still map to never", () => {
  const f = codexFixture();
  assert.equal(f.api.normalizeAccessMode("danger-full-access").approvalPolicy, "never");
  assert.equal(f.api.normalizeAccessMode("custom", "Full access").sandbox, "danger-full-access");
  assert.equal(f.api.isUnattendedAccess(f.api.normalizeAccessMode(":danger-full-access")), true);
  assert.equal(f.api.isUnattendedAccess(f.api.normalizeAccessMode(":workspace")), false);
});
