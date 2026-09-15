import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { transformSync } from "esbuild";
import { test } from "node:test";

class FakeEvent<T> { private listeners = new Set<(value: T) => void>(); readonly event = (listener: (value: T) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; fire(value: T) { for (const listener of [...this.listeners]) listener(value); } }

function loadHub(mock: { root?: string | undefined; worktrees: any[]; created?: any; usable: (worktree: any) => boolean; pick?: any; ref?: string; openError?: Error; pickError?: Error }) {
  const calls: any[] = []; const messages: string[] = [];
  const vscodeDouble: any = { Disposable: class {}, window: { showQuickPick: async () => { if (mock.pickError) throw mock.pickError; return mock.pick; }, showInputBox: async () => mock.ref, showInformationMessage: async (message: string) => { messages.push(message); }, showWarningMessage: async (message: string) => { messages.push(message); }, showErrorMessage: async (message: string) => { messages.push(message); } }, workspace: { workspaceFolders: [{ uri: { fsPath: "/source" } }] }, commands: { executeCommand: async (id: string, uri: any, newWindow: boolean) => { calls.push({ id, uri, newWindow }); if (mock.openError) throw mock.openError; } }, Uri: { file: (path: string) => ({ fsPath: path }) } };
  const registry = { gitRoot: async () => mock.root, listGitWorktrees: async () => mock.worktrees, isUsableWorktree: mock.usable, createDetachedWorkspace: async () => mock.created };
  const source = readFileSync(join(resolve(process.cwd()), "src", "workspace-hub.ts"), "utf8"); const compiled = transformSync(source, { format: "cjs", platform: "node", target: "es2022", loader: "ts" }).code; const module = { exports: {} as any };
  new Function("require", "module", "exports", compiled)((id: string) => id === "vscode" ? vscodeDouble : id.endsWith("workspace-registry.js") ? registry : require(id), module, module.exports);
  return { Hub: module.exports.WorkspaceHub as new (context: any, options?: any) => any, context: { subscriptions: [], globalStorageUri: { fsPath: "/private/muster" } }, calls, messages };
}

test("workspace hub handles no-Git roots and picker cancellation without opening or creating", async () => {
  const noGit = loadHub({ root: undefined, worktrees: [], usable: () => true }); const noGitResult = await new noGit.Hub(noGit.context, { sourceRoot: () => "/source" }).openHub();
  assert.equal(noGitResult, undefined); assert.equal(noGit.calls.length, 0); assert.match(noGit.messages[0]!, /Git workspace/);
  const canceled = loadHub({ root: "/source", worktrees: [], usable: () => true, pick: undefined }); assert.equal(await new canceled.Hub(canceled.context, { sourceRoot: () => "/source" }).openHub(), undefined); assert.equal(canceled.calls.length, 0);
});

test("workspace hub opens only usable worktrees and handles open-window rejection", async () => {
  const stale = { path: "/stale", head: "deadbee", prunable: "missing" }; const fixture = loadHub({ root: "/source", worktrees: [stale], usable: () => false, pick: { id: stale.path, worktree: stale } });
  assert.equal(await new fixture.Hub(fixture.context, { sourceRoot: () => "/source" }).openHub(), undefined); assert.equal(fixture.calls.length, 0); assert.match(fixture.messages[0]!, /unavailable/);
  const healthy = { path: "/healthy", head: "abc1234", branch: "main" }; const rejected = loadHub({ root: "/source", worktrees: [healthy], usable: () => true, pick: { id: healthy.path, worktree: healthy }, openError: new Error("window failed") });
  assert.equal(await new rejected.Hub(rejected.context, { sourceRoot: () => "/source" }).openHub(), undefined); assert.deepEqual(rejected.calls[0], { id: "vscode.openFolder", uri: { fsPath: "/healthy" }, newWindow: true }); assert.match(rejected.messages[0]!, /Could not open/);
});

test("workspace hub creates at explicit ref, reconciles through registry, then opens one new window", async () => {
  const created = { workspaceId: "workspace-1", sourceRoot: "/source", root: "/private/muster/worktrees/workspace-1", baseRef: "abc123456789", state: "ready" }; const fixture = loadHub({ root: "/source", worktrees: [], usable: () => true, pick: { id: "create" }, ref: "release", created });
  const result = await new fixture.Hub(fixture.context, { sourceRoot: () => "/source", storageRoot: () => "/private/muster" }).openHub();
  assert.deepEqual(result, created); assert.deepEqual(fixture.calls, [{ id: "vscode.openFolder", uri: { fsPath: created.root }, newWindow: true }]);
});

test("workspace hub converts picker rejection into a handled warning without dispatching", async () => {
  const fixture = loadHub({ root: "/source", worktrees: [], usable: () => true, pickError: new Error("picker closed unexpectedly") });
  assert.equal(await new fixture.Hub(fixture.context, { sourceRoot: () => "/source" }).openHub(), undefined);
  assert.equal(fixture.calls.length, 0); assert.match(fixture.messages[0]!, /Workspace hub failed/);
});
