import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { parseHTML } from "linkedom";
import { join, resolve } from "node:path";

const exec = promisify(execFile);
const root = resolve(process.cwd(), "../..");

test("generated preview uses the recovered default and accepts an explicit theme", async () => {
  await exec("node", [join(root, "scripts/dev/preview-pane.mjs")], { cwd: root });
  const html = await readFile("/tmp/muster-polish-preview/index.html", "utf8");
  assert.match(html, /--vscode-sideBar-background:#141414/);
  const { document } = parseHTML(html).window;
  assert.equal(document.querySelectorAll("script").length, 3, "malicious patch content must not create a fourth script element");
  assert.doesNotMatch(html, /<script>untrusted/);
  assert.match(html, /\\u003cscript\\u003e/);
  assert.match(html, /agentWorkspace/);
  assert.match(html, /Offline preview: no model requests/);
  assert.match(html, /scenario==='models'\?sendModels/);
  assert.match(html, /hybrow:codex\/gpt-5\.6-terra/);
  await exec("node", [join(root, "scripts/dev/preview-pane.mjs"), "--theme", "Muster Light"], { cwd: root });
  const lightHtml = await readFile("/tmp/muster-polish-preview/index.html", "utf8");
  assert.match(lightHtml, /--vscode-sideBar-background:#F3F3F3/);
});
