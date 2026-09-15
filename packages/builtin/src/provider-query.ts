import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { applyProviderDispatch, type ProviderRoute } from "./provider-routing.js";

/** Discovery needs the same executable environment as turns; core's query API has no env option. */
export function queryProvider(route: ProviderRoute, method: string, params: Record<string, unknown>, cwd?: string): Promise<Record<string, unknown>> {
  const options = applyProviderDispatch({}, route);
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, ["app-server", "--stdio"], { ...(cwd ? { cwd } : {}), env: { ...process.env, ...options.env }, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return; settled = true; clearTimeout(timer); lines.close(); child.stdin.end(); child.kill();
      if (error) reject(error); else resolve(result ?? {});
    };
    const timer = setTimeout(() => finish(new Error(`Provider ${route.providerId} discovery timed out.`)), 15000);
    child.on("error", () => finish(new Error(`Provider ${route.providerId} launcher is unavailable.`)));
    child.on("exit", () => finish(new Error(`Provider ${route.providerId} discovery failed; check its profile and Codex CLI.`)));
    child.stdin.on("error", () => finish(new Error(`Provider ${route.providerId} discovery disconnected.`)));
    lines.on("line", line => {
      let message: any; try { message = JSON.parse(line); } catch { return; }
      if (message.id !== 1 && message.id !== 2) return;
      if (message.error) { finish(new Error(`Provider ${route.providerId} rejected ${message.id === 1 ? "initialization" : method}.`)); return; }
      if (message.id === 1) { child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n"); child.stdin.write(JSON.stringify({ id: 2, method, params }) + "\n"); }
      else finish(undefined, message.result);
    });
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "muster", version: "0.1" }, capabilities: { experimentalApi: true } } }) + "\n");
  });
}
