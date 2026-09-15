import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NavigationHub, navigationItems, type NavigationItem } from "../src/navigation.js";

const nativeCommands = ["workbench.action.quickOpen", "workbench.action.showCommands", "workbench.action.gotoSymbol", "workbench.action.gotoLine", "workbench.action.tasks.runTask", "muster.terminal.workspace", "muster.browser.openTab", "muster.review.open", "muster.appearance.open", "editor.action.toggleWordWrap"];

test("navigation hub exposes existing native destinations and gates workspaces by registration", () => {
  const items = navigationItems(nativeCommands, "darwin");
  assert.deepEqual(items.map((item) => item.id), ["files", "commands", "symbols", "lines", "tasks", "terminals", "browser", "review", "appearance", "wrap"]);
  assert.equal(items.find((item) => item.id === "files")?.shortcut, "⌘P");
  assert.equal(items.find((item) => item.id === "wrap")?.command, "editor.action.toggleWordWrap");
  assert.equal(navigationItems([...nativeCommands, "muster.worktree.open"], "linux").some((item) => item.id === "workspaces"), true);
  assert.equal(navigationItems(["unknown.command"], "linux").length, 0);
});

test("navigation hub cancels cleanly and dispatches one selected command", async () => {
  const calls: { command: string; args: unknown[] }[] = []; let selected: NavigationItem | undefined;
  const host = { getCommands: async () => nativeCommands, showQuickPick: async (items: NavigationItem[]) => selected ? items.find((item) => item.id === selected!.id) : undefined, executeCommand: async (command: string, ...args: unknown[]) => { calls.push({ command, args }); return "done"; } };
  const hub = new NavigationHub(host); assert.equal(await hub.open(), undefined); assert.equal(calls.length, 0);
  selected = { id: "lines", label: "", description: "", shortcut: "", command: "" }; assert.equal(await hub.open(), "done"); assert.deepEqual(calls, [{ command: "workbench.action.gotoLine", args: [] }]);
});

test("go-to shortcut does not replace Cmd+P/Cmd+K or introduce a related conflict", () => {
  const root = resolve(process.cwd(), "..", ".."); const manifest = JSON.parse(readFileSync(join(root, "packages", "builtin", "package.json"), "utf8"));
  const bindings = manifest.contributes.keybindings.filter((binding: { mac?: string; key?: string }) => binding.mac === "cmd+alt+g" || binding.key === "ctrl+alt+g");
  assert.deepEqual(bindings.map((binding: { command: string }) => binding.command), ["muster.navigation.goTo"]);
  assert.match(readFileSync(join(root, "scripts", "patch-workbench.py"), "utf8"), /"workbench\.action\.showCommands": \('\"Commands\"', "workbench\.action\.showCommands"\)/);
  assert.doesNotMatch(readFileSync(join(root, "scripts", "patch-workbench.py"), "utf8"), /"workbench\.action\.showCommands": \('\"New Agent\"'/);
});
