// Writes the pane webview's inline <script> (paneHtml lives in packages/builtin/src/agent-view.ts) to argv[2].
// Run from packages/builtin: node --import tsx ../../scripts/dev/extract-pane-script.ts <out.js>
import { writeFileSync } from "node:fs";
import { paneHtml } from "../../packages/builtin/src/agent-view.ts";

const scripts = [...paneHtml("x").matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
writeFileSync(process.argv[2]!, scripts[scripts.length - 1] ?? "");
