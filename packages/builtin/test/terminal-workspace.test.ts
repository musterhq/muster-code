import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { transformSync } from "esbuild";
import { boundedText, searchText } from "../src/terminal-state.js";

const root = resolve(process.cwd());
const source = readFileSync(join(root, "src", "terminal-workspace.ts"), "utf8");
const extension = readFileSync(join(root, "src", "extension.ts"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("managed output is bounded by UTF-8 bytes and preserves newest content", () => {
  const value = boundedText("old\n".repeat(100) + "終わり", 32);
  assert.ok(Buffer.byteLength(value, "utf8") <= 32);
  assert.match(value, /終わり$/);
});

test("managed output search returns bounded, line-addressable matches", () => {
  const matches = searchText("alpha\nBuild passed\nalpha again\nalpha third", "ALPHA", { limit: 2 });
  assert.deepEqual(matches.map((match) => match.line), [1, 3]);
  assert.equal(matches.length, 2);
});

test("terminal workspace uses native shell terminals and keeps provider output separate", () => {
  assert.match(source, /vscode\.window\.createTerminal/);
  assert.match(source, /kind: \"managed-shell\"/);
  assert.match(source, /onDidWriteTerminalData/);
  assert.match(source, /onDidCloseTerminal/);
  assert.match(source, /sendText\(text, execute\)/);
  assert.match(extension, /new TerminalWorkspace/);
  assert.match(extension, /terminalContext\?\.\(\)/);
  assert.match(extension, /terminalArgs = .*terminalContext\(\)/);
  for (const command of ["muster.terminal.workspace", "muster.terminal.list", "muster.terminal.open", "muster.terminal.create", "muster.terminal.reveal", "muster.terminal.output", "muster.terminal.search", "muster.terminal.send", "muster.terminal.close"]) {
    assert.ok(manifest.contributes.commands.some((entry: { command: string }) => entry.command === command), command);
    assert.match(extension, new RegExp(command.replaceAll(".", "\\.")));
  }
});

class FakeEvent<T> {
  private listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value: T) { for (const listener of [...this.listeners]) listener(value); }
}

class FakeTerminal {
  readonly creationOptions: { cwd: string };
  readonly processId = Promise.resolve(4321);
  readonly writes: { text: string; execute: boolean }[] = [];
  name: string; exitStatus: { code: number | undefined } | undefined;
  constructor(name: string, cwd: string, private readonly closed: FakeEvent<FakeTerminal>) { this.name = name; this.creationOptions = { cwd }; }
  show() {}
  sendText(text: string, execute: boolean) { this.writes.push({ text, execute }); }
  dispose() { this.exitStatus = { code: 0 }; this.closed.fire(this); }
}

test("managed terminal behavior uses native lifecycle, task reuse, explicit execution, and bounded inspection", async () => {
  const opened = new FakeEvent<FakeTerminal>(), closed = new FakeEvent<FakeTerminal>(), output = new FakeEvent<{ terminal: FakeTerminal; data: string }>(), state = new FakeEvent<FakeTerminal>();
  const terminals: FakeTerminal[] = [];
  const vscodeDouble: any = {
    EventEmitter: class<T> extends FakeEvent<T> { dispose() {} },
    window: {
      terminals, onDidOpenTerminal: opened.event, onDidCloseTerminal: closed.event, onDidWriteTerminalData: output.event, onDidChangeTerminalState: state.event,
      createTerminal: ({ name, cwd }: { name: string; cwd: string }) => { const terminal = new FakeTerminal(name, cwd, closed); terminals.push(terminal); opened.fire(terminal); return terminal; },
      showQuickPick: async () => undefined, showInputBox: async () => undefined, showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showTextDocument: async () => undefined,
    },
    workspace: { openTextDocument: async ({ content }: { content: string }) => ({ getText: () => content }) },
  };
  const sourceText = readFileSync(join(root, "src", "terminal-workspace.ts"), "utf8");
  const compiled = transformSync(sourceText, { format: "cjs", platform: "node", target: "es2022", loader: "ts" }).code;
  const module = { exports: {} as any };
  new Function("require", "module", "exports", compiled)( (id: string) => id === "vscode" ? vscodeDouble : id.endsWith("terminal-state.js") ? { boundedText, DEFAULT_TERMINAL_OUTPUT_BYTES: 40_000, searchText } : require(id), module, module.exports);
  const Workspace = module.exports.TerminalWorkspace as new (context: any, cwd: () => string, bytes: () => number) => any;
  const context = { subscriptions: [], workspaceState: {} };
  const workspace = new Workspace(context, () => "/workspace", () => 5_000);
  const first = await workspace.open({ taskId: "tab-1", taskLabel: "Fix UI", cwd: "/workspace/ui", name: "Fix UI" });
  const reused = await workspace.open({ taskId: "tab-1", taskLabel: "Fix UI", cwd: "/workspace/ui", name: "Fix UI" });
  assert.equal(reused.id, first.id); assert.equal(terminals.length, 1); assert.equal(first.kind, "managed-shell"); assert.equal(first.cwd, "/workspace/ui");
  const forced = await workspace.create({ taskId: "tab-1", taskLabel: "Fix UI", cwd: "/workspace/ui", name: "Fix UI" }); assert.notEqual(forced.id, first.id); assert.equal(terminals.length, 2);
  const native = terminals[0]!; output.fire({ terminal: native, data: "old\n".repeat(4_000) + "latest-marker\n" });
  const inspected = workspace.output(first.id, 120); assert.equal(inspected.truncated, true); assert.match(inspected.text, /latest-marker/); assert.ok(inspected.terminal.outputBytes <= 5_000);
  const found = workspace.search(first.id, "LATEST-MARKER"); assert.ok(found.matches.length >= 1); assert.equal(found.matches[0]!.line > 0, true);
  workspace.send(first.id, "echo pending", false); workspace.send(first.id, "echo run", true); assert.deepEqual(native.writes, [{ text: "echo pending", execute: false }, { text: "echo run", execute: true }]);
  native.exitStatus = { code: 7 }; state.fire(native); assert.equal(workspace.get(first.id).status, "exited"); assert.equal(workspace.get(first.id).exitCode, 7);
  closed.fire(native); assert.equal(workspace.get(first.id).status, "closed"); assert.throws(() => workspace.send(first.id, "echo no", true), /closed/); assert.throws(() => workspace.output("stale", 100), /Unknown managed terminal/);
  workspace.dispose(); assert.deepEqual(workspace.list(), []);
});
