import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const browser = readFileSync(join(root, "src", "browser.ts"), "utf8");
const tools = readFileSync(join(root, "src", "browser-tools.ts"), "utf8");
const mcp = readFileSync(join(root, "src", "browser-mcp.ts"), "utf8");
const main = readFileSync(join(root, "..", "..", "product", "muster-browser-main.js"), "utf8");

test("browser contract carries recoverable load state and diagnostics", () => {
  assert.match(browser, /interface BrowserHistory/);
  assert.match(browser, /networkErrors\?: BrowserLoadError\[\]/);
  assert.match(browser, /id="browser-state"/);
  assert.match(tools, /browser_diagnostics/);
  assert.match(tools, /Unknown browser tab/);
  assert.match(mcp, /browser_go_forward/);
  assert.match(mcp, /browser_scroll/);
  assert.match(mcp, /browser_status/);
  assert.match(mcp, /readOnlyHint/);
  assert.match(tools, /browser_resize/);
  assert.match(tools, /browser_set_appearance/);
  assert.match(main, /setAppearance/);
});

test("main process waits on real load events and records frame scope", () => {
  assert.match(main, /did-stop-loading/);
  assert.match(main, /did-fail-load/);
  assert.match(main, /mainFrame/);
  assert.match(main, /Navigation superseded/);
});

test("browser stress fixtures are deterministic and local", () => {
  for (const name of ["slow.html", "subframe-error.html", "console-stress.html"]) assert.equal(existsSync(join(root, "..", "..", "scripts", "dev", "site", name)), true, name);
});
