import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

// Opt-in, local protocol smoke: no thread or turn is created, no inference.
for (const layout of ["resources", "dist-ext/resources"]) for (const profile of ["openai-direct", "hybrow-gateway"]) {
  test(`native initialize/config-read: ${layout}/${profile}`, { skip: process.env.MUSTER_PROVIDER_SMOKE !== "1", timeout: 25000 }, async () => {
    const child = spawn(resolve(layout, `codex-${profile}.sh`), ["app-server", "--stdio", "-c", 'mcp_servers.muster_browser.command="/usr/bin/false"', "-c", 'mcp_servers.muster_browser.enabled=false'], { env: { ...process.env, MUSTER_PROVIDER_NODE: process.execPath, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let seq = 0;
    const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => { let value; try { value = JSON.parse(line); } catch { return; } const item = waiting.get(value.id); if (item) { waiting.delete(value.id); value.error ? item.reject(new Error("App-server rejected protocol request")) : item.resolve(value.result); } });
    child.on("error", () => { for (const item of waiting.values()) item.reject(new Error("Launcher executable failed")); });
    child.on("exit", code => { for (const item of waiting.values()) item.reject(new Error(`Launcher exited (${code}) before protocol response ${seq}`)); });
    child.stderr.resume();
    const request = (method: string, params: Record<string, unknown>) => new Promise<any>((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
    try {
      await request("initialize", { clientInfo: { name: "muster-provider-test", version: "0.1" }, capabilities: { experimentalApi: true } });
      child.stdin.write('{"method":"initialized"}\n');
      const result = await request("config/read", { includeLayers: false });
      // Never print configuration or credentials in diagnostics.
      assert.ok(result.config?.model_provider === (profile === "openai-direct" ? "openai" : "hybrow"), "selected provider must reach native config");
      assert.ok(typeof result.config?.model_catalog_json === "string", "selected catalog must reach native config");
      assert.ok(result.config?.mcp_servers?.muster_browser?.enabled === false, "host MCP override must survive");
    } finally { lines.close(); child.stdin.end(); child.kill(); }
  });
}
