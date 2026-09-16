// The Muster browser as MCP tools for the agent (the reference IDE exposes its browser to
// the agent the same way, Playwright-style). Codex launches this file over stdio
// (see setBrowserMcp in codex.ts); every call is bridged to the extension host
// over a unix socket, so the agent drives the very tab the user is looking at.
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const TAB = { tab: { type: "string", description: "Browser tab id from browser_tabs (default: the tab the user is looking at)" } };
const target = (extra: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties: { ...extra, ...TAB }, ...(required.length ? { required } : {}) });
const ann = (title: string, readOnly: boolean, destructive: boolean, idempotent: boolean) => ({
  title,
  readOnlyHint: readOnly,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: true,
});

const TOOLS = [
  { name: "browser_navigate", description: "Navigate the IDE browser tab the user sees. Pass {url}. Prefer this over external automation. Returns a snapshot after load. Optional headless=true for a hidden tab.", inputSchema: target({ url: { type: "string" }, headless: { type: "boolean" } }, ["url"]), annotations: ann("Navigate browser", false, false, true) },
  { name: "browser_snapshot", description: "Inspect the page before interacting. Returns title, URL, and visible elements with [ref=eN] handles for click/type/hover/select.", inputSchema: target(), annotations: ann("Inspect browser page", true, false, true) },
  { name: "browser_click", description: "Click one target by {ref} from browser_snapshot or {selector}. Optional double=true. Returns an updated snapshot.", inputSchema: target({ ref: { type: "string" }, selector: { type: "string" }, double: { type: "boolean" } }), annotations: ann("Click in browser", false, true, false) },
  { name: "browser_type", description: "Type {text} into a textbox or contenteditable via {ref} or {selector}. Replaces content; submit=true presses Enter.", inputSchema: target({ ref: { type: "string" }, selector: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } }, ["text"]), annotations: ann("Type in browser", false, true, false) },
  { name: "browser_press_key", description: "Send a key to the page: Enter, Tab, Escape, arrows, Space, or a single character. Pass {key}.", inputSchema: target({ key: { type: "string" } }, ["key"]), annotations: ann("Press key in browser", false, true, false) },
  { name: "browser_hover", description: "Move the pointer over an element by {ref} or {selector} without clicking.", inputSchema: target({ ref: { type: "string" }, selector: { type: "string" } }), annotations: ann("Hover in browser", false, false, true) },
  { name: "browser_select_option", description: "Pick a <select> option by {ref} or {selector}. {value} matches option value or visible label.", inputSchema: target({ ref: { type: "string" }, selector: { type: "string" }, value: { type: "string" } }, ["value"]), annotations: ann("Select option", false, true, false) },
  { name: "browser_screenshot", description: "Capture a PNG of the visible page. Optional fullPage=true and save=true (writes under .muster/screenshots and returns screenshotPath).", inputSchema: target({ save: { type: "boolean" }, fullPage: { type: "boolean" } }), annotations: ann("Screenshot browser", true, false, true) },
  { name: "browser_console_messages", description: "Read recent console output. Optional {level: debug|log|warn|error} and {limit} (default 100).", inputSchema: target({ level: { type: "string", enum: ["debug", "log", "warn", "error"] }, limit: { type: "number" } }), annotations: ann("Read browser console", true, false, true) },
  { name: "browser_diagnostics", description: "Deep health check: loading/errors, history, console counts, network failures, pending visual edits.", inputSchema: target(), annotations: ann("Browser diagnostics", true, false, true) },
  { name: "browser_status", description: "Quick read-only status: URL, title, loading, history, viewport {width,height,mode,preset}, colorScheme, console errors, recording.", inputSchema: target(), annotations: ann("Browser status", true, false, true) },
  { name: "browser_evaluate", description: "Run a JavaScript {expression} in the page and return JSON-serializable output (e.g. document.title).", inputSchema: target({ expression: { type: "string" } }, ["expression"]), annotations: ann("Evaluate in browser", false, true, false) },
  { name: "browser_wait_for", description: "Wait until all of {text}, {selector}, and {url} (substring or /regex/flags) hold, optionally after {timeMs}. {timeoutMs} default 10000, max 60000.", inputSchema: target({ text: { type: "string" }, selector: { type: "string" }, url: { type: "string" }, timeMs: { type: "number" }, timeoutMs: { type: "number" } }), annotations: ann("Wait for browser", true, false, true) },
  { name: "browser_go_back", description: "Go back in the tab history. Returns a snapshot when navigation settles.", inputSchema: target(), annotations: ann("Browser back", false, false, true) },
  { name: "browser_go_forward", description: "Go forward in the tab history. Returns a snapshot when navigation settles.", inputSchema: target(), annotations: ann("Browser forward", false, false, true) },
  { name: "browser_reload", description: "Reload the current page. Returns a snapshot after load.", inputSchema: target(), annotations: ann("Reload browser", false, false, true) },
  { name: "browser_scroll", description: "Scroll the window or a container {ref}/{selector}. Pass {deltaX} and/or {deltaY} in CSS pixels.", inputSchema: target({ deltaX: { type: "number" }, deltaY: { type: "number" }, ref: { type: "string" }, selector: { type: "string" } }), annotations: ann("Scroll browser", false, false, true) },
  { name: "browser_resize", description: "Set CSS viewport: {mode:'fill'|'freeform'|'preset'} with {width,height} or {preset,orientation}. Returns measured innerWidth/innerHeight.", inputSchema: target({ mode: { type: "string", enum: ["fill", "freeform", "preset"] }, width: { type: "number" }, height: { type: "number" }, preset: { type: "string", enum: ["iphone-12-pro", "iphone-se", "pixel-7", "ipad", "desktop-1280", "desktop-1440"] }, orientation: { type: "string", enum: ["portrait", "landscape"] } }, ["mode"]), annotations: ann("Resize browser viewport", false, false, true) },
  { name: "browser_set_appearance", description: "Emulate prefers-color-scheme with {colorScheme:'dark'|'light'|'system'} (system clears the override).", inputSchema: target({ colorScheme: { type: "string", enum: ["dark", "light", "system"] } }, ["colorScheme"]), annotations: ann("Set browser appearance", false, false, true) },
  { name: "browser_tabs", description: "List open Muster browser tabs with id, title, URL, and loading/history hints.", inputSchema: { type: "object", properties: {} }, annotations: ann("List browser tabs", true, false, true) },
];

const sockPath = process.env.MUSTER_BROWSER_SOCK ?? "";
// Trace next to the socket (<sock>.log): what the agent asked and where a call stalled, if it does.
const trace = (msg: string) => { if (sockPath) { try { appendFileSync(`${sockPath}.log`, `${new Date().toISOString().slice(11, 23)} [${process.pid}] ${msg}\n`); } catch { /* best effort */ } } };
trace(`shim started argv=${process.argv.slice(1).join(" ")} node=${process.version}`);
let sock: Socket | null = null;
let connecting: Promise<Socket> | null = null;
let seq = 0;
const pending = new Map<number, (r: { result?: unknown; error?: string }) => void>();

function connect(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    trace(`connecting ${sockPath}`);
    const s = createConnection(sockPath);
    s.once("connect", () => { trace("connected"); resolve(s); });
    s.once("error", (e) => { trace(`socket error ${e.message}`); sock = null; reject(e); });
    s.once("close", () => { trace("socket closed"); sock = null; const error = { text: "The browser bridge connection closed.", isError: true }; for (const p of pending.values()) p({ result: error }); pending.clear(); });
    createInterface({ input: s }).on("line", (line) => { try { const m = JSON.parse(line); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } } catch { /* partial */ } });
  });
}

async function bridge(tool: string, args: Record<string, unknown>): Promise<{ text?: string; image?: string; isError?: boolean }> {
  if (!sock) { connecting ??= connect().finally(() => { connecting = null; }); sock = await connecting; }
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (pending.delete(id)) { trace(`call ${id} ${tool} timed out`); resolve({ text: `The browser did not answer ${tool} within 120s.`, isError: true }); } }, 120_000);
    pending.set(id, (m) => { clearTimeout(timer); trace(`call ${id} ${tool} answered`); resolve(m.error ? { text: m.error, isError: true } : (m.result as { text?: string; image?: string; isError?: boolean })); });
    try { sock!.write(`${JSON.stringify({ id, tool, args })}\n`); } catch (error) { pending.delete(id); clearTimeout(timer); resolve({ text: `Browser bridge write failed: ${error instanceof Error ? error.message : String(error)}`, isError: true }); }
    trace(`call ${id} ${tool} sent`);
  });
}

const send = (msg: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

createInterface({ input: process.stdin }).on("line", async (line) => {
  let m: { id?: number | string; method?: string; params?: Record<string, unknown> };
  try { m = JSON.parse(line); } catch { trace(`bad line ${line.slice(0, 80)}`); return; }
  trace(`← ${m.method ?? "response"} id=${String(m.id ?? "")}${m.method === "tools/call" ? ` ${String(m.params?.name)}` : ""}`);
  if (m.method === "initialize") { send({ id: m.id, result: { protocolVersion: String(m.params?.protocolVersion ?? "2025-06-18"), capabilities: { tools: {} }, serverInfo: { name: "muster-browser", version: "0.1.0" } } }); return; }
  if (m.method === "ping") { send({ id: m.id, result: {} }); return; }
  if (m.method === "tools/list") { send({ id: m.id, result: { tools: TOOLS } }); return; }
  if (m.method === "tools/call") {
    const name = String(m.params?.name ?? ""); const args = (m.params?.arguments as Record<string, unknown>) ?? {};
    if (!TOOLS.some((t) => t.name === name)) { send({ id: m.id, error: { code: -32602, message: `Unknown tool ${name}` } }); return; }
    if (!sockPath) { send({ id: m.id, result: { content: [{ type: "text", text: "The Muster browser bridge is not configured (MUSTER_BROWSER_SOCK missing)." }], isError: true } }); return; }
    inflight++;
    try {
      const r = await bridge(name, args);
      const content: Record<string, unknown>[] = [];
      if (r.text) content.push({ type: "text", text: r.text });
      if (r.image) content.push({ type: "image", data: r.image, mimeType: "image/png" });
      if (!content.length) content.push({ type: "text", text: "Done." });
      send({ id: m.id, result: { content, ...(r.isError ? { isError: true } : {}) } });
    } catch (error) { send({ id: m.id, result: { content: [{ type: "text", text: `Browser bridge error: ${error instanceof Error ? error.message : String(error)}` }], isError: true } }); }
    finally { inflight--; }
    return;
  }
  if (m.id !== undefined && m.method) send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
});
// Exit only once in-flight calls have answered (a spawner that closes stdin right after a call still gets its result).
let inflight = 0;
process.stdin.on("end", () => { const tryExit = () => (inflight > 0 ? setTimeout(tryExit, 50) : process.exit(0)); tryExit(); });
