// The Muster browser as MCP tools for the agent (Cursor exposes its browser to
// the agent the same way, Playwright-style). Codex launches this file over stdio
// (see setBrowserMcp in codex.ts); every call is bridged to the extension host
// over a unix socket, so the agent drives the very tab the user is looking at.
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const TAB = { tab: { type: "string", description: "Browser tab id from browser_tabs (default: the tab the user is looking at)" } };
const target = (extra: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties: { ...extra, ...TAB }, ...(required.length ? { required } : {}) });
const TOOLS = [
  { name: "browser_navigate", description: "Open a URL in the IDE's built-in browser tab (the one the user is looking at; preferred over any other browser automation) and wait for it to load. Returns a page snapshot.", inputSchema: target({ url: { type: "string" } }, ["url"]) },
  { name: "browser_snapshot", description: "Accessibility-style snapshot of the current page: title, URL and the visible elements with [ref=eN] handles to use with browser_click / browser_type / browser_hover / browser_select_option.", inputSchema: target() },
  { name: "browser_click", description: "Click an element by ref (from browser_snapshot) or CSS selector; returns the snapshot afterwards.", inputSchema: target({ ref: { type: "string" }, selector: { type: "string" }, double: { type: "boolean" } }) },
  { name: "browser_type", description: "Type text into a textbox/contenteditable by ref or selector (replaces its content); submit=true presses Enter afterwards.", inputSchema: target({ ref: { type: "string" }, selector: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } }, ["text"]) },
  { name: "browser_press_key", description: "Press a key in the page: Enter, Tab, Escape, Backspace, ArrowDown/Up/Left/Right, Space, or a single character.", inputSchema: target({ key: { type: "string" } }, ["key"]) },
  { name: "browser_hover", description: "Move the mouse over an element by ref or selector.", inputSchema: target({ ref: { type: "string" }, selector: { type: "string" } }) },
  { name: "browser_select_option", description: "Choose a <select> option by ref or selector; value matches the option value or its label.", inputSchema: target({ ref: { type: "string" }, selector: { type: "string" }, value: { type: "string" } }, ["value"]) },
  { name: "browser_screenshot", description: "PNG screenshot of the current page as the user sees it.", inputSchema: target() },
  { name: "browser_console_messages", description: "Recent console output of the page (debug/log/warn/error) with sources.", inputSchema: target() },
  { name: "browser_evaluate", description: "Evaluate a JavaScript expression in the page and return its JSON result (e.g. document.title, getComputedStyle(...).color).", inputSchema: target({ expression: { type: "string" } }, ["expression"]) },
  { name: "browser_wait_for", description: "Wait until the given text appears on the page (up to 10s), or for timeMs milliseconds.", inputSchema: target({ text: { type: "string" }, timeMs: { type: "number" } }) },
  { name: "browser_go_back", description: "Navigate back in the tab's history.", inputSchema: target() },
  { name: "browser_reload", description: "Reload the page.", inputSchema: target() },
  { name: "browser_tabs", description: "List the open Muster browser tabs (id, title, URL).", inputSchema: { type: "object", properties: {} } },
];

const sockPath = process.env.MUSTER_BROWSER_SOCK ?? "";
// Trace next to the socket (<sock>.log): what the agent asked and where a call stalled, if it does.
const trace = (msg: string) => { if (sockPath) { try { appendFileSync(`${sockPath}.log`, `${new Date().toISOString().slice(11, 23)} [${process.pid}] ${msg}\n`); } catch { /* best effort */ } } };
trace(`shim started argv=${process.argv.slice(1).join(" ")} node=${process.version}`);
let sock: Socket | null = null;
let seq = 0;
const pending = new Map<number, (r: { result?: unknown; error?: string }) => void>();

function connect(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    trace(`connecting ${sockPath}`);
    const s = createConnection(sockPath);
    s.once("connect", () => { trace("connected"); resolve(s); });
    s.once("error", (e) => { trace(`socket error ${e.message}`); sock = null; reject(e); });
    s.once("close", () => { trace("socket closed"); sock = null; });
    createInterface({ input: s }).on("line", (line) => { try { const m = JSON.parse(line); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } } catch { /* partial */ } });
  });
}

async function bridge(tool: string, args: Record<string, unknown>): Promise<{ text?: string; image?: string; isError?: boolean }> {
  sock ??= await connect();
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (pending.delete(id)) { trace(`call ${id} ${tool} timed out`); resolve({ text: `The browser did not answer ${tool} within 90s.`, isError: true }); } }, 90_000);
    pending.set(id, (m) => { clearTimeout(timer); trace(`call ${id} ${tool} answered`); resolve(m.error ? { text: m.error, isError: true } : (m.result as { text?: string; image?: string; isError?: boolean })); });
    sock!.write(`${JSON.stringify({ id, tool, args })}\n`);
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
